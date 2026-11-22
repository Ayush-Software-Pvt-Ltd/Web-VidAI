// The event stream of an OpenCode 2 server (`GET /api/event`, server-sent events): the decoder
// and the reader, which connects, waits for the first
// event, hands the `data` of every event on and, when the stream drops while the server is still
// there, connects again.
//
// A server of VidAI runs for hours of work, so a dropped
// connection (a proxy-less local socket still can be reset) must not end the job's events;
// `Last-Event-ID` is sent when the server gave an id, and the caller drops an event it has seen
// (`server.js` keeps the ids), because a server that replays on reconnect would repeat events.

import { OpencodeRequestError, describeFetchError } from "./serverErrors.js";

/** Longest event kept; a longer one is dropped whole. */
export const MAX_EVENT_BYTES = 16 * 1024 * 1024;

/**
 * Splits a server-sent event stream into the `data` of each event. Bytes may arrive in any
 * pieces; `\n` and `\r\n` line ends both work; comments and `event:` lines are ignored, the `id:`
 * line is remembered (`lastEventId`).
 */
export class SseDecoder {
  /** @type {Buffer[]} */
  #lineParts = [];
  #lineLength = 0;
  /** @type {Buffer[]} */
  #data = [];
  #dataLength = 0;
  #hasData = false;
  /** The current line or event is too long and is being skipped. */
  #overflow = false;
  /** @type {string | null} */
  #lastEventId = null;

  /** The value of the last `id:` line, or `null`. @returns {string | null} */
  get lastEventId() {
    return this.#lastEventId;
  }

  /**
   * Feeds bytes and returns the data of every event they complete.
   * @param {Buffer} bytes
   * @returns {string[]}
   */
  push(bytes) {
    /** @type {string[]} */
    const out = [];
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(0x0a, start);
      const end = newline < 0 ? bytes.length : newline;
      if (end > start) this.#append(bytes.subarray(start, end));
      if (newline < 0) break;
      this.#endLine(out);
      start = newline + 1;
    }
    return out;
  }

  /** @param {Buffer} segment */
  #append(segment) {
    const room = MAX_EVENT_BYTES - this.#lineLength - this.#dataLength;
    if (segment.length > room) this.#overflow = true;
    if (room <= 0) return;
    const kept = segment.length > room ? segment.subarray(0, room) : segment;
    this.#lineParts.push(kept);
    this.#lineLength += kept.length;
  }

  /** @param {string[]} out */
  #endLine(out) {
    let line = Buffer.concat(this.#lineParts, this.#lineLength);
    this.#lineParts = [];
    this.#lineLength = 0;
    if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    if (line.length === 0) {
      if (this.#hasData && !this.#overflow) {
        out.push(Buffer.concat(this.#data, this.#dataLength).toString("utf8"));
      }
      this.#data = [];
      this.#dataLength = 0;
      this.#hasData = false;
      this.#overflow = false;
      return;
    }
    if (line.subarray(0, 5).toString("latin1") === "data:") {
      let value = line.subarray(5);
      if (value[0] === 0x20) value = value.subarray(1);
      if (this.#hasData) {
        this.#data.push(Buffer.from("\n"));
        this.#dataLength += 1;
      }
      this.#data.push(value);
      this.#dataLength += value.length;
      this.#hasData = true;
    } else if (line.subarray(0, 3).toString("latin1") === "id:") {
      let value = line.subarray(3);
      if (value[0] === 0x20) value = value.subarray(1);
      this.#lastEventId = value.toString("utf8");
    }
  }
}

/**
 * @typedef {object} StreamOptions
 * @property {string} url The full address of `/api/event`.
 * @property {Record<string, string>} headers Authorization and the directory.
 * @property {typeof fetch} fetch
 * @property {number} firstEventTimeoutMs How long a connection may take to deliver its first event.
 * @property {readonly number[]} reconnectGapsMs The waits before each reconnect; the last repeats.
 * @property {() => boolean} serverAlive Whether the server process is still there (no reconnect
 *   once it is gone).
 * @property {(data: string) => void} onData Called with the data of each event, in order.
 */

/**
 * @typedef {object} EventStream
 * @property {Promise<void>} connected Resolves when the first event arrived; rejects (with an
 *   `OpencodeRequestError` or an `Error` with a sentence) when the first connection failed, and
 *   then there is no retry.
 * @property {Promise<void>} done Resolves when the reader ended for good (stopped, or the stream
 *   ended and the server is gone).
 * @property {() => void} stop Ends the reader; no more `onData` calls follow.
 * @property {() => number} reconnects How many times the stream was connected again.
 */

/**
 * Opens the event stream and keeps reading it.
 * @param {StreamOptions} options
 * @returns {EventStream}
 */
export function createEventStream(options) {
  let stopped = false;
  let reconnected = 0;
  /** @type {AbortController | null} */
  let current = null;
  /** @type {() => void} */
  let wake = () => {};
  const woken = new Promise((resolve) => {
    wake = () => resolve(undefined);
  });
  /** @type {() => void} */
  let markConnected = () => {};
  /** @type {(error: unknown) => void} */
  let failConnect = () => {};
  const connected = new Promise((resolve, reject) => {
    markConnected = () => resolve(undefined);
    failConnect = reject;
  });
  // A rejection nobody awaits yet must not crash the server.
  connected.catch(() => {});
  let everConnected = false;
  /** Whether the current connection delivered an event. */
  let delivered = false;
  const decoder = new SseDecoder();

  /** One connection: resolves when the stream ends, rejects when it fails. */
  const readOnce = async () => {
    const controller = new AbortController();
    current = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.firstEventTimeoutMs);
    const lastId = decoder.lastEventId;
    try {
      const response = await options.fetch(options.url, {
        headers: {
          ...options.headers,
          accept: "text/event-stream",
          ...(lastId === null ? {} : { "last-event-id": lastId }),
        },
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        await response.body?.cancel().catch(() => {});
        throw new OpencodeRequestError(
          "other",
          `OpenCode refused the event stream (HTTP ${response.status})`,
        );
      }
      const reader = response.body.getReader();
      let first = true;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const data of decoder.push(Buffer.from(value))) {
          if (stopped) return;
          if (first) {
            first = false;
            clearTimeout(timer);
            everConnected = true;
            markConnected();
          }
          delivered = true;
          try {
            options.onData(data);
          } catch {
            // A throwing callback must not end the stream or take the server down.
          }
        }
      }
    } catch (error) {
      if (timedOut) {
        throw new OpencodeRequestError("timeout", "OpenCode's event stream did not connect");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (current === controller) current = null;
    }
  };

  const done = (async () => {
    let attempt = 0;
    for (;;) {
      delivered = false;
      try {
        await readOnce();
      } catch (error) {
        if (stopped) return;
        if (!everConnected) {
          failConnect(error instanceof OpencodeRequestError ? error : describeFetchError(error));
          return;
        }
      }
      if (delivered) attempt = 0;
      if (stopped || !options.serverAlive()) {
        if (!everConnected) failConnect(new Error("OpenCode's event stream did not connect"));
        return;
      }
      const gaps = options.reconnectGapsMs;
      const gap = gaps[Math.min(attempt, gaps.length - 1)] ?? 0;
      attempt += 1;
      await Promise.race([woken, new Promise((resolve) => setTimeout(resolve, gap))]);
      if (stopped || !options.serverAlive()) return;
      reconnected += 1;
    }
  })();

  return {
    connected,
    done,
    stop() {
      stopped = true;
      wake();
      current?.abort();
    },
    reconnects: () => reconnected,
  };
}

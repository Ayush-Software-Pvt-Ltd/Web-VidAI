/**
 * The event stream of the signed-in session (SPEC section 14): one `EventSource` on `/api/events`
 * that `http.ts` starts after sign-in and stops at sign-out.
 *
 * - The server's first message is `hello` with its instance id. The page remembers the first one
 *   it saw (`connection.instance`); another one later means the server was restarted or updated,
 *   so the page reloads, once, to load the matching UI.
 * - Every other message is `{ event, payload }`. Only names of `EVENT_NAMES` are passed on (to the
 *   event hub), and only when the payload has the rough shape of that event; anything else is
 *   ignored and logged once, so one bad message can never break the page. A new event needs
 *   nothing here: add its name to `EVENT_NAMES` (and its payload to `EventPayloads`).
 * - The browser's own reconnecting has a fixed delay and does not tell why it stopped, so the
 *   stream closes a broken `EventSource` and opens a new one itself, with growing delays. When the
 *   browser gave up on an HTTP error (readyState CLOSED, for instance a 401), the stream asks
 *   `checkSession` before it tries again: no session means it stops for good (`onSessionLost`).
 * - `connection.status` is `connecting` until the stream first opens, `connected` while it is up
 *   and `lost` while it is down. A change from `lost` back to `connected` is the signal for the
 *   store to refetch what it shows: events sent in between are gone.
 * - The server sends a `ping` event every 15 seconds while nothing else was sent (a comment line
 *   would never reach the page). It is swallowed here, but any message of any kind restarts a
 *   silence timer: when nothing arrived for 45 seconds (`silentMs`) the stream is open but dead,
 *   and it is treated exactly like an error (closed, then the usual reconnect with its backoff).
 * - The server sends `session-ended` (first with a reason, then without one as it closes the
 *   stream). The page gets one `session-ended` (the first message: its reason, or `reason: null`
 *   when the server gave none) and the stream stops: there is nothing to reconnect to.
 */
import type { ConnectionStore } from "./connection";
import type { EventHub } from "./eventHub";
import {
  EVENT_NAMES,
  type EventName,
  type EventPayloads,
  type SessionEndedPayload,
  type SessionEndReason,
} from "./rpc";

/** The part of `EventSource` the stream uses (tests fake it). */
export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  readonly readyState: number;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

/** `EventSource.readyState` of a stream the browser gave up on. */
export const EVENT_SOURCE_CLOSED = 2;

/** Waits in milliseconds before the 1st, 2nd, ... attempt after a break; the last one repeats. */
export const DEFAULT_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 15000];

/** No message of any kind for this long means the stream is dead (the server pings every 15 s). */
export const DEFAULT_SILENT_MS = 45_000;

export type SessionCheck = "signedIn" | "signedOut" | "unreachable";

export interface EventStreamOptions {
  url: string;
  hub: Pick<EventHub, "emit">;
  connection: ConnectionStore;
  /** Default: `new EventSource(url)`. */
  createSource?: EventSourceFactory;
  /** Is the session still there? Asked after the browser gave up on the stream. */
  checkSession: () => Promise<SessionCheck>;
  /** The server says there is no session (any more): the page must show the sign-in. */
  onSessionLost: () => void;
  /** Default: `window.location.reload()`. */
  reload?: () => void;
  backoffMs?: readonly number[];
  /** Default `DEFAULT_SILENT_MS`. */
  silentMs?: number;
  /** Default: `console.warn`. */
  warn?: (message: string) => void;
}

export interface EventStream {
  /** Opens the stream; does nothing while one is open or being retried. */
  start(): void;
  /** Closes the stream and stops reconnecting (sign-out). Does nothing when it is not started. */
  stop(): void;
  readonly running: boolean;
}

const KNOWN: ReadonlySet<string> = new Set(EVENT_NAMES);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "string");
}

/** Rough checks of the shape of each payload; an event without a rule must carry an object. */
const SHAPES: Partial<Record<EventName, (payload: unknown) => boolean>> = {
  "library-changed": (p) => p === null || isObject(p),
  "job-updated": (p) => isObject(p) && hasStrings(p, ["id", "videoId", "userId"]),
  "job-log": (p) => isObject(p) && hasStrings(p, ["videoId", "jobId"]) && Array.isArray(p.entries),
  "queue-changed": (p) => isObject(p) && typeof p.queue === "string",
  "timeline-changed": (p) => isObject(p) && hasStrings(p, ["videoId"]),
  "note-updated": (p) => isObject(p) && hasStrings(p, ["videoId"]) && isObject(p.note),
  "preview-copies-changed": (p) => isObject(p) && hasStrings(p, ["videoId"]) && isObject(p.copies),
  "disk-use-changed": (p) => isObject(p) && Array.isArray(p.videos),
  "system-changed": () => true,
  "workspace-changed": () => true,
};

const REASONS: readonly string[] = ["passwordChanged", "disabled", "removed"];

export function createEventStream(options: EventStreamOptions): EventStream {
  const { url, hub, connection, checkSession, onSessionLost } = options;
  const createSource: EventSourceFactory = options.createSource ?? ((u) => new EventSource(u));
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const silentMs = options.silentMs ?? DEFAULT_SILENT_MS;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const reload =
    options.reload ??
    (() => {
      window.location.reload();
    });

  let running = false;
  let source: EventSourceLike | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Fires when no message arrived for `silentMs`; restarted by every message. */
  let silence: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  /** Bumped by `stop` so an answer of `checkSession` that arrives later is dropped. */
  let generation = 0;
  let reloading = false;
  const warned = new Set<string>();

  function warnOnce(key: string, message: string) {
    if (warned.has(key)) return;
    warned.add(key);
    warn(message);
  }

  function clearSilence() {
    if (silence !== null) clearTimeout(silence);
    silence = null;
  }

  function closeSource() {
    clearSilence();
    if (!source) return;
    source.onopen = null;
    source.onmessage = null;
    source.onerror = null;
    source.close();
    source = null;
  }

  function deliver<E extends EventName>(event: E, payload: EventPayloads[E]) {
    try {
      hub.emit(event, payload);
    } catch (error) {
      console.error(`A handler of the event "${event}" failed.`, error);
    }
  }

  function onHello(payload: unknown) {
    const id = isObject(payload) ? payload.instanceId : undefined;
    if (typeof id !== "string" || id === "") {
      warnOnce("hello", "VidAI event stream: ignored a hello without an instance id.");
      return;
    }
    failures = 0;
    const first = connection.getSnapshot().instance;
    if (first === null) connection.update({ instance: id });
    else if (first !== id && !reloading) {
      reloading = true;
      reload();
    }
  }

  function onSessionEnded(payload: unknown) {
    let reason: SessionEndReason | null;
    if (payload === null || payload === undefined) {
      reason = null;
    } else if (
      isObject(payload) &&
      (payload.reason === null || typeof payload.reason === "string")
    ) {
      if (typeof payload.reason === "string" && !REASONS.includes(payload.reason)) {
        warnOnce("session-ended", "VidAI event stream: ignored a session-ended with a bad reason.");
        return;
      }
      reason = payload.reason as SessionEndReason | null;
    } else {
      warnOnce("session-ended", "VidAI event stream: ignored a malformed session-ended.");
      return;
    }
    const ended: SessionEndedPayload = { reason };
    // The server closes the stream next: there is nothing to reconnect to.
    stopStream();
    deliver("session-ended", ended);
  }

  function onMessage(data: unknown) {
    let message: unknown;
    try {
      message = typeof data === "string" ? JSON.parse(data) : undefined;
    } catch {
      message = undefined;
    }
    if (!isObject(message) || typeof message.event !== "string") {
      warnOnce("malformed", "VidAI event stream: ignored a message that is not an event.");
      return;
    }
    const name = message.event;
    const payload = message.payload === undefined ? null : message.payload;
    // The heartbeat only proves the stream is alive (the timer was restarted by `onmessage`).
    if (name === "ping") return;
    if (name === "hello") {
      onHello(payload);
      return;
    }
    if (name === "session-ended") {
      onSessionEnded(payload);
      return;
    }
    if (!KNOWN.has(name)) {
      warnOnce(`unknown:${name}`, `VidAI event stream: ignored the unknown event "${name}".`);
      return;
    }
    const eventName = name as EventName;
    const shape = SHAPES[eventName];
    const fine = shape ? shape(payload) : isObject(payload);
    if (!fine) {
      warnOnce(
        `shape:${name}`,
        `VidAI event stream: ignored an "${name}" event with an unexpected payload.`,
      );
      return;
    }
    // `system-changed` and `workspace-changed` carry nothing, whatever the server put there.
    const empty = eventName === "system-changed" || eventName === "workspace-changed";
    deliver(eventName, (empty ? null : payload) as never);
  }

  function schedule() {
    if (!running || timer !== null) return;
    const wait = backoff[Math.min(failures, backoff.length - 1)] ?? 1000;
    failures += 1;
    timer = setTimeout(() => {
      timer = null;
      open();
    }, wait);
  }

  async function sessionStillThere(mine: number) {
    let answer: SessionCheck;
    try {
      answer = await checkSession();
    } catch {
      answer = "unreachable";
    }
    if (!running || mine !== generation) return;
    if (answer === "signedOut") {
      stopStream();
      connection.update({ status: "connecting", unauthorized: true });
      onSessionLost();
      return;
    }
    schedule();
  }

  /** (Re)starts the silence timer of `stream`; when it fires the stream counts as broken. */
  function watchSilence(stream: EventSourceLike) {
    clearSilence();
    silence = setTimeout(() => {
      silence = null;
      if (source !== stream) return;
      closeSource();
      connection.update({ status: "lost" });
      schedule();
    }, silentMs);
  }

  function open() {
    if (!running) return;
    const stream = createSource(url);
    source = stream;
    watchSilence(stream);
    stream.onopen = () => {
      if (source !== stream) return;
      connection.update({ status: "connected", unauthorized: false });
    };
    stream.onmessage = (message) => {
      if (source !== stream) return;
      watchSilence(stream);
      onMessage(message.data);
    };
    stream.onerror = () => {
      if (source !== stream) return;
      const gaveUp = stream.readyState === EVENT_SOURCE_CLOSED;
      closeSource();
      connection.update({ status: "lost" });
      if (gaveUp) void sessionStillThere(generation);
      else schedule();
    };
  }

  function onOnline() {
    // The network is back: no reason to wait out the rest of the delay.
    if (!running || timer === null) return;
    clearTimeout(timer);
    timer = null;
    open();
  }

  /** Stops without touching `connection.status` of a stream that ended on purpose. */
  function stopStream() {
    if (!running) return;
    running = false;
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    closeSource();
    if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
  }

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      connection.update({ status: "connecting" });
      if (typeof window !== "undefined") window.addEventListener("online", onOnline);
      open();
    },
    stop() {
      stopStream();
      connection.update({ status: "connecting" });
    },
    get running() {
      return running;
    },
  };
}

// Delivery of job log entries (src-tauri/src/jobs/log.rs, `LogSink`).
//
// The sink assigns increasing `seq` numbers, scrubs every registered secret (an API key), cuts
// `text` and `detail` to `MAX_LOG_DETAIL_CHARS` (after scrubbing, so a cut can never leave half
// a secret), appends the entries to the job's log file and hands the same entries to a listener
// (the `job-log` event), batched: the first entry goes out at once, then at most one batch per
// `intervalMs` (150 ms). Producers never wait for the disk; they only queue.

import { systemClock } from "../db/open.js";
import { createScrubber } from "./logScrub.js";
import { MAX_LOG_DETAIL_CHARS, truncateChars } from "./logText.js";

/** @typedef {import("../db/open.js").Clock} Clock */
/** @typedef {import("./logDescribe.js").Draft} Draft */
/** @typedef {import("./logStore.js").LogEntry} LogEntry */
/** @typedef {import("./logStore.js").LogStore} LogStore */
/** @typedef {import("./logStore.js").JobLogBatch} JobLogBatch */
/** @typedef {import("./logScrub.js").Scrubber} Scrubber */

/**
 * The timers the sink uses, injected so tests control time.
 * @typedef {object} Timers
 * @property {(callback: () => void, ms: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 */

/** @type {Timers} */
export const realTimers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    // A pending batch must never keep the server alive; `close` flushes it.
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(/** @type {NodeJS.Timeout} */ (handle));
  },
};

/** The batching interval of the UI delivery. */
export const LOG_INTERVAL_MS = 150;

/**
 * @typedef {object} LogSink
 * @property {(secret: string, label?: string) => void} addSecret Adds a secret given to a job,
 *   to scrub from every later entry as `label` (default `[api key]`).
 * @property {(text: string) => string} scrub `text` with every known secret replaced by its label.
 * @property {(videoId: string, jobId: string, drafts: readonly Draft[], ts?: string) => void} push
 *   Queues entries for a job. They get the next `seq` numbers and the timestamp `ts` (default:
 *   now, ISO 8601).
 * @property {() => boolean} flush Writes and delivers everything pending now (before reading a
 *   log, or before exit); true when anything was written.
 * @property {(jobId: string) => void} forget Forgets a job whose log was deleted (its video got a
 *   newer job).
 * @property {() => void} close Flushes and stops the timers; later pushes are written at once.
 */

/**
 * @param {object} options
 * @param {LogStore} options.store
 * @param {(batch: JobLogBatch) => void} options.notify Receives each batch after it was written
 *   (also when writing failed: the live view must not lose lines to a full disk).
 * @param {Scrubber} [options.scrubber] Shared with whoever else must scrub (default: its own).
 * @param {Clock} [options.clock]
 * @param {number} [options.intervalMs]
 * @param {Timers} [options.timers]
 * @param {(error: unknown, jobId: string) => void} [options.onError] A log that cannot be written
 *   or a listener that throws; never rethrown.
 * @returns {LogSink}
 */
export function createLogSink({
  store,
  notify,
  scrubber = createScrubber(),
  clock = systemClock,
  intervalMs = LOG_INTERVAL_MS,
  timers = realTimers,
  onError = () => {},
}) {
  /** @type {Map<string, { videoId: string, entries: LogEntry[] }>} */
  let pending = new Map();
  /** @type {Map<string, number>} */
  const nextSeq = new Map();
  /** @type {unknown} */
  let timer = null;
  let cooling = false;
  let closed = false;

  /** @param {string} jobId */
  function lastSeqOnDisk(jobId) {
    try {
      return store.read(jobId, 1)[0]?.seq ?? 0;
    } catch {
      return 0;
    }
  }

  /** @param {string} text */
  const cut = (text) => truncateChars(scrubber.scrub(text), MAX_LOG_DETAIL_CHARS);

  function flush() {
    const batch = pending;
    pending = new Map();
    for (const [jobId, { videoId, entries }] of batch) {
      try {
        store.append(jobId, entries);
      } catch (error) {
        onError(error, jobId);
      }
      try {
        notify({ videoId, jobId, entries });
      } catch (error) {
        onError(error, jobId);
      }
    }
    return batch.size > 0;
  }

  // At most one batch per interval: the first push flushes on the next turn of the event loop
  // (so pushes of the same turn share a batch), then the cooling timer holds the next one back.
  function leading() {
    timer = null;
    flush();
    cooling = true;
    timer = timers.setTimeout(endCooling, intervalMs);
  }

  function endCooling() {
    timer = null;
    cooling = false;
    if (pending.size > 0) leading();
  }

  return {
    addSecret: (secret, label) => scrubber.add(secret, label),
    scrub: (text) => scrubber.scrub(text),
    push(videoId, jobId, drafts, ts = new Date(clock.now()).toISOString()) {
      if (drafts.length === 0) return;
      let seq = nextSeq.get(jobId) ?? lastSeqOnDisk(jobId) + 1;
      const entries = drafts.map((d) => {
        const entry = {
          seq,
          ts,
          kind: d.kind,
          text: cut(d.text),
          detail: d.detail === null ? null : cut(d.detail),
          nested: d.nested,
        };
        seq += 1;
        return entry;
      });
      nextSeq.set(jobId, seq);
      const queue = pending.get(jobId);
      if (queue === undefined) pending.set(jobId, { videoId, entries });
      else queue.entries.push(...entries);
      if (closed) flush();
      else if (timer === null && !cooling) timer = timers.setTimeout(leading, 0);
    },
    flush,
    forget(jobId) {
      pending.delete(jobId);
      nextSeq.delete(jobId);
    },
    close() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      cooling = false;
      closed = true;
      flush();
    },
  };
}

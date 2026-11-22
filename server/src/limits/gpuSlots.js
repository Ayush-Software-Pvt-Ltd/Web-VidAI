// The GPU slots (docs/SPEC.md section 9, GPU): the number of GPU tasks that may run at once, kept
// as files in `<data dir>/locks/gpu/` so that programs in any language take part. THE FORMAT ON
// DISK IS THE CONTRACT: the Python toolkit implements it on its own from this description.
//
// The folder (`VE_GPU_SLOTS_DIR` of a job's programs; `VE_JOB_ID` is the job id) holds:
//
// 1. `limits.json`: `{"total":n,"perJob":n}`, whole numbers from 1. The server writes it at start
//    and whenever the settings change: it writes `limits.json.tmp-<unique>` in the same folder,
//    then renames it over `limits.json` (so no reader sees half of it). A program reads it again
//    EVERY time it wants a slot. When it is missing or unreadable a program uses
//    `{"total":8,"perJob":8}` (the 100 percent default), and `perJob` above `total` counts as
//    `total`.
//
// 2. `slot-<i>` for `i` from 0 to `total - 1`: one file per slot that is held. Its content is
//    `{"jobId":"<job id>","pid":<number>,"at":<milliseconds since 1970>}` and its MODIFIED TIME is
//    the lease. The holder is the process `pid` (a program that runs for the job; the server's
//    own render runner uses the server's pid).
//
// Taking a slot, one attempt (the program repeats it every second until it succeeds):
//   a. Read `limits.json`.
//   b. Read every `slot-<n>` file. The job already holds one for every file whose content names
//      its job id and that is not stale (see 4). When that number is `perJob` or more: no slot
//      now, wait.
//   c. For `i` from 0 to `total - 1`, in order: create `slot-<i>` with EXCLUSIVE create (O_EXCL;
//      Python `open(path, "x")`). The first name that can be created is the slot taken: write
//      the record, set the modified time to now, close.
//      When the name exists and the file is stale (see 4), take it over (see 5) and try to create
//      the name once more.
//   d. After creating: count the job's slots again; when they are now more than `perJob`
//      (another program of the same job was just as fast) delete the file just created and wait,
//      for a random moment of up to a quarter of a second more than usual.
//   e. When no name could be created, wait one second and start again.
//
// Holding: the holder sets the modified time of its file to now every 60 seconds (`utimes`),
// after checking that the content is still its own (jobId, pid, at). A holder that finds its file
// gone or someone else's has lost the slot and stops renewing.
//
// Giving back: delete the file, after checking that the content is still its own.
//
// Stale (may be taken over): the modified time is more than 15 minutes ago (the lease), or the
// process `pid` of a valid record does not run any more. A file whose content is not a valid
// record (empty because its creator has not written yet, cut short, corrupt) is judged by its
// modified time only, so it is never taken over before the lease has passed and never crashes a
// program.
//
// Taking over (also how the server removes slots): read the file; decide it is stale; RENAME it to
// the unique name `slot-<i>.gone-<unique>` in the same folder; when the rename fails the file is
// already gone (somebody else won, do nothing); read the renamed file and check that it is the
// file that was judged (same content and modified time), then delete it. When it is a different
// file (a fresh slot created in between), link it back to `slot-<i>` (`link` fails rather than
// overwrites) and delete the renamed name. Files named `slot-<i>.gone-*` or `limits.json.tmp-*`
// older than the lease are leftovers of a crash and may be deleted by anyone.
//
// What the server does (`createGpuSlotKeeper`): writes `limits.json`; sweeps every 30 seconds
// and whenever the limits change or a job ends: removes slots held by processes that no longer
// run, slots of jobs that ended (`endJob`), expired slots and slots numbered `total` or more
// (their holders find out at the next renewal); `list()` tells the System page who holds what.

import fs from "node:fs";
import path from "node:path";
import { systemClock } from "../db/open.js";
import { isAlive as systemIsAlive } from "../platform/process.common.js";
import {
  DEFAULT_LIMITS,
  LEASE_MS,
  RENEW_MS,
  createSlotFile,
  readLimits,
  readSlotFile,
  readSlots,
  removeLeftovers,
  removeSlotIf,
  slotName,
  staleReason,
  writeLimits,
} from "./gpuFiles.js";
import { realTimers } from "./timers.js";

/** @typedef {import("./budget.js").GpuSlotLimits} GpuSlotLimits */
/** @typedef {import("./timers.js").Timers} Timers */

/**
 * One slot as the System page shows it.
 * @typedef {object} GpuSlotView
 * @property {number} index
 * @property {string | null} jobId `null` when the file is not a valid record.
 * @property {number | null} pid
 * @property {number | null} at When it was taken.
 * @property {number} ageMs Time since the holder last renewed it.
 * @property {"held" | "expired" | "holder gone" | "unreadable"} state `unreadable` is a file that
 *   is not a valid record and is still within its lease.
 */

/** @param {string} reason */
function abortError(reason = "The wait for a GPU slot was cancelled.") {
  return Object.assign(new Error(reason), { name: "AbortError" });
}

/**
 * The server's side: writes the limits, removes stale slots, tells who holds what.
 * @param {object} options
 * @param {string} options.dir `<data dir>/locks/gpu`.
 * @param {{ now(): number }} [options.clock]
 * @param {Timers} [options.timers]
 * @param {(pid: number) => boolean} [options.isAlive]
 * @param {{ info(message: string, detail?: unknown): void, warn(message: string, detail?: unknown): void }} [options.log]
 * @param {number} [options.sweepMs] Time between sweeps (default 30 s).
 */
export function createGpuSlotKeeper({
  dir,
  clock = systemClock,
  timers = realTimers,
  isAlive = systemIsAlive,
  log,
  sweepMs = 30_000,
}) {
  /** @type {GpuSlotLimits | null} */
  let limits = null;
  /** Jobs that ended, with when: late slots of theirs are still removed for a while. */
  /** @type {Map<string, number>} */
  const ended = new Map();
  /** @type {unknown} */
  let timer = null;
  const ENDED_KEPT_MS = LEASE_MS;

  /**
   * Removes the slots that must go.
   * @returns {{ index: number, jobId: string | null, reason: string }[]} What was removed.
   */
  function sweep() {
    const now = clock.now();
    for (const [jobId, at] of ended) if (now - at > ENDED_KEPT_MS) ended.delete(jobId);
    /** @type {{ index: number, jobId: string | null, reason: string }[]} */
    const removed = [];
    try {
      for (const slot of readSlots(dir)) {
        const outcome = removeSlotIf(dir, slot.index, (current) => {
          if (limits !== null && current.index >= limits.total) return "above the limit";
          if (current.record !== null && ended.has(current.record.jobId)) return "job ended";
          return staleReason(current, now, isAlive);
        });
        if (outcome.result === "removed") {
          removed.push({
            index: slot.index,
            jobId: outcome.slot.record?.jobId ?? null,
            reason: outcome.reason,
          });
        }
      }
      removeLeftovers(dir, now);
    } catch (error) {
      log?.warn("GPU slots: sweep failed", error);
    }
    if (removed.length > 0) log?.info("GPU slots: removed", removed);
    return removed;
  }

  return {
    /**
     * Writes `limits.json` (temporary name, then rename) and removes the slots numbered `total`
     * or more.
     * @param {GpuSlotLimits} next
     */
    setLimits(next) {
      limits = { total: next.total, perJob: Math.min(next.perJob, next.total) };
      writeLimits(dir, limits);
      sweep();
    },

    /** The limits last written (`null` before the first `setLimits`). */
    limits: () => (limits === null ? null : { ...limits }),

    sweep,

    /**
     * A job ended: its slots go now, and any it takes later until the lease time has passed.
     * @param {string} jobId
     */
    endJob(jobId) {
      ended.set(jobId, clock.now());
      sweep();
    },

    /** @returns {GpuSlotView[]} */
    list() {
      const now = clock.now();
      return readSlots(dir).map((slot) => {
        const reason = staleReason(slot, now, isAlive);
        return {
          index: slot.index,
          jobId: slot.record?.jobId ?? null,
          pid: slot.record?.pid ?? null,
          at: slot.record?.at ?? null,
          ageMs: Math.max(0, now - slot.mtimeMs),
          state: reason ?? (slot.record === null ? "unreadable" : "held"),
        };
      });
    },

    /** Starts the periodic sweep. */
    start() {
      if (timer !== null) return;
      timer = timers.setInterval(() => sweep(), sweepMs);
    },

    stop() {
      if (timer !== null) timers.clearInterval(timer);
      timer = null;
    },
  };
}

/**
 * @typedef {object} AcquireOptions
 * @property {string} dir `VE_GPU_SLOTS_DIR`.
 * @property {string} jobId
 * @property {number} [pid] The holder (default: this process).
 * @property {AbortSignal} [signal] Aborting stops the wait, or gives a held slot back.
 * @property {{ now(): number }} [clock]
 * @property {Timers} [timers]
 * @property {(pid: number) => boolean} [isAlive]
 * @property {number} [retryMs] Time between attempts (default 1 s).
 * @property {number} [renewMs] Time between renewals (default 60 s).
 * @property {() => number} [random] 0 to 1, for the pause after a lost race (default `Math.random`).
 * @property {{ warn(message: string, detail?: unknown): void }} [log]
 */

/**
 * @typedef {object} HeldSlot
 * @property {number} index
 * @property {() => void} release Gives the slot back; calling it again does nothing.
 */

/**
 * The job's slots that count against `perJob`: valid records of the job that are not stale.
 * @param {string} dir
 * @param {string} jobId
 * @param {number} now
 * @param {(pid: number) => boolean} isAlive
 * @returns {number}
 */
function heldBy(dir, jobId, now, isAlive) {
  let count = 0;
  for (const slot of readSlots(dir)) {
    if (slot.record?.jobId === jobId && staleReason(slot, now, isAlive) === null) count += 1;
  }
  return count;
}

/**
 * One attempt to take a slot (steps a to d of the head). Synchronous, so that the clients of one
 * process never interleave inside it.
 * @param {AcquireOptions & { clock: { now(): number }, isAlive: (pid: number) => boolean, pid: number }} o
 * @returns {{ index: number, record: import("./gpuFiles.js").SlotRecord } | "full" | "lost race"}
 */
function attempt({ dir, jobId, pid, clock, isAlive }) {
  const limits = readLimits(dir) ?? DEFAULT_LIMITS;
  const now = clock.now();
  if (heldBy(dir, jobId, now, isAlive) >= limits.perJob) return "full";
  for (let index = 0; index < limits.total; index += 1) {
    const record = { jobId, pid, at: now };
    let created = createSlotFile(dir, index, record);
    if (!created) {
      const outcome = removeSlotIf(dir, index, (slot) => staleReason(slot, now, isAlive));
      if (outcome.result !== "kept") created = createSlotFile(dir, index, record);
    }
    if (!created) continue;
    if (heldBy(dir, jobId, now, isAlive) > limits.perJob) {
      // Another program of the job was as fast: the later look decides, both give way.
      fs.rmSync(path.join(dir, slotName(index)), { force: true });
      return "lost race";
    }
    return { index, record };
  }
  return "full";
}

/**
 * Waits for a GPU slot and holds it: the client for the server's own render runner. It tries
 * every second until it has one, renews it every 60 seconds while held, and gives it back with
 * `release()` (which does nothing the second time) or when `signal` aborts. Rejects with an
 * `AbortError` when `signal` aborts first.
 * @param {AcquireOptions} options
 * @returns {Promise<HeldSlot>}
 */
export async function acquireGpuSlot(options) {
  const {
    dir,
    jobId,
    pid = process.pid,
    signal,
    clock = systemClock,
    timers = realTimers,
    isAlive = systemIsAlive,
    retryMs = 1000,
    renewMs = RENEW_MS,
    random = Math.random,
    log,
  } = options;
  if (signal?.aborted) throw abortError();
  fs.mkdirSync(dir, { recursive: true });

  /** @type {Awaited<ReturnType<typeof attempt>>} */
  let got;
  for (;;) {
    got = attempt({ ...options, dir, jobId, pid, clock, isAlive });
    if (typeof got !== "string") break;
    // After a lost race a random extra pause keeps the two from colliding again.
    const pause = retryMs + (got === "lost race" ? Math.floor(random() * 250) : 0);
    await new Promise((resolve, reject) => {
      /** @type {(() => void) | null} */
      let onAbort = null;
      const timer = timers.setTimeout(() => {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        resolve(undefined);
      }, pause);
      if (signal) {
        onAbort = () => {
          timers.clearTimeout(timer);
          reject(abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  const { index, record } = got;
  const file = path.join(dir, slotName(index));
  /** Whether the file is still this holder's. */
  const mine = () => {
    const slot = readSlotFile(file, index);
    return (
      slot?.record?.jobId === record.jobId &&
      slot.record.pid === record.pid &&
      slot.record.at === record.at
    );
  };
  let released = false;
  /** @type {unknown} */
  let renewTimer = null;

  /** @returns {void} */
  function release() {
    if (released) return;
    released = true;
    if (renewTimer !== null) timers.clearInterval(renewTimer);
    signal?.removeEventListener("abort", release);
    try {
      if (mine()) fs.rmSync(file, { force: true });
    } catch (error) {
      log?.warn("GPU slot: could not give the slot back", error);
    }
  }

  renewTimer = timers.setInterval(() => {
    try {
      if (!mine()) {
        log?.warn(`GPU slot ${index} of job ${jobId} was taken away`);
        released = true;
        if (renewTimer !== null) timers.clearInterval(renewTimer);
        return;
      }
      const seconds = clock.now() / 1000;
      fs.utimesSync(file, seconds, seconds);
    } catch (error) {
      log?.warn("GPU slot: could not renew the slot", error);
    }
  }, renewMs);
  signal?.addEventListener("abort", release, { once: true });
  // An abort that arrived between the last attempt and now.
  if (signal?.aborted) release();
  return { index, release };
}

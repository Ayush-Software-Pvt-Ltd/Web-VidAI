// What the pieces of one job's driver share : the
// resolved settings of the job, the queue, the requests of the manager, the log and the
// published progress. Plain data and small helpers; the decisions are in `driverProcess.js`,
// `driverObserve.js` and `driver.js`.

import { DEFAULT_LIMITS, createKeeper } from "./keepgoing.js";
import { draft, errorDraft, statusDraft } from "./logDescribe.js";
import { createMailbox, realTimers } from "./driverMailbox.js";
import { DEFAULT_TEXTS } from "./driverTexts.js";
import { createRetryPlanner } from "./retry.js";
import { cpuByPid, endTree, listTree } from "../platform/process.js";

/** @typedef {import("./driver.js").AgentJobContext} AgentJobContext */
/** @typedef {import("./logDescribe.js").Draft} Draft */

/**
 * The times of the driver, in milliseconds.
 * @typedef {object} DriverTimings
 * @property {number} settle Quiet this long, with nothing pending: the model is idle.
 * @property {number} interruptTimeout How long a pause waits for the model to go idle.
 * @property {number} exitTimeout How long a closed program may take to exit.
 * @property {number} killGrace How long an ended tree may take before it is forced.
 * @property {number} stallTimeout No line at all for this long: the program is stuck.
 * @property {number} progressInterval How often activity, cost and progress are published.
 * @property {number} treeRefresh How often the process tree is looked at.
 * @property {number} retrySecond One "second" of the retry schedule.
 */

/** @type {DriverTimings} */
export const DEFAULT_TIMINGS = Object.freeze({
  settle: 4000,
  interruptTimeout: 15_000,
  exitTimeout: 20_000,
  killGrace: 5000,
  stallTimeout: 20 * 60_000,
  progressInterval: 1000,
  treeRefresh: 5000,
  retrySecond: 1000,
});

/** The retries after a model error when the context does not say. */
export const DEFAULT_MAX_RETRIES = 5;

/**
 * @param {AgentJobContext} ctx
 */
export function createDriverState(ctx) {
  const clock = ctx.clock ?? { now: () => Date.now() };
  const timers = ctx.timers ?? realTimers;
  const timings = { ...DEFAULT_TIMINGS, ...ctx.timings };
  const proc = ctx.process ?? { listTree, endTree, cpuByPid };
  const startedAt = clock.now();
  /** @type {Array<() => void>} */
  const signals = [];

  const state = {
    ctx,
    clock,
    timers,
    timings,
    texts: { ...DEFAULT_TEXTS, ...ctx.texts },
    process: proc,
    mailbox: createMailbox(timers),
    startedAt,
    keeper: createKeeper({ ...DEFAULT_LIMITS, ...ctx.keepLimits }, ctx.tracker.workShown()),
    planner: createRetryPlanner({
      maxRetries: ctx.maxRetries ?? (() => DEFAULT_MAX_RETRIES),
      clock,
      workShown: ctx.tracker.workShown(),
      secondMs: timings.retrySecond,
    }),
    /** What the main conversation did since the last message was sent. */
    turn: { toolCalls: 0, marker: false },
    /** @type {string | null} */
    sessionId: ctx.job.sessionId,
    /** @type {string | null} */
    activity: null,
    /** @type {number | null} */
    cost: null,
    /** The latest cost reported, kept for the outcome. @type {number | null} */
    lastCost: null,
    lastProgress: startedAt,
    /** @type {{ resetsAt: number | null } | null} Set once any program of this run hit a limit. */
    limit: null,
    /** The agent's fixes asked for after a failed `verify`. */
    fixes: 0,
    beforeChangeDone: false,
    /** The limiter was told a program started and has not been told it ended. */
    limiterOn: false,
    /** The number of the program being driven (events of an older one are ignored). */
    gen: 0,
    /** @type {"pause" | "stop" | null} What the manager asked for; once, never taken back. */
    request: /** @type {"pause" | "stop" | null} */ (null),
    stopAsked: false,
    finished: false,

    /**
     * Whether the driver may still send a message of its own: not after a pause or a stop was
     * requested (synchronous because the driver is one thread).
     * @returns {boolean}
     */
    halted: () => state.request !== null,

    /**
     * How a job without a program ends once a request came: a stop wins over a pause.
     * @returns {"stopped" | "paused"}
     */
    requestedEnd: () => (state.stopAsked ? "stopped" : "paused"),

    /** @param {"pause" | "stop"} kind */
    requestMade(kind) {
      if (state.finished) return;
      if (kind === "pause" && state.request !== null) return;
      if (kind === "stop" && state.stopAsked) return;
      state.request = kind === "stop" ? "stop" : (state.request ?? "pause");
      if (kind === "stop") state.stopAsked = true;
      state.mailbox.push({ type: kind });
      for (const wake of signals.splice(0)) wake();
    },

    /**
     * Waits for `promise`, unless a pause or stop is requested first.
     * @template T
     * @param {Promise<T>} promise
     * @returns {Promise<{ done: true, value: T } | { done: false }>}
     */
    raceRequest(promise) {
      const asked = new Promise((resolve) => {
        if (state.request !== null) resolve(undefined);
        else signals.push(() => resolve(undefined));
      });
      return Promise.race([
        promise.then((value) => ({ done: /** @type {const} */ (true), value })),
        asked.then(() => ({ done: /** @type {const} */ (false) })),
      ]);
    },

    /**
     * Resolves after `ms`, or earlier when `promise` settles.
     * @param {Promise<unknown>} promise
     * @param {number} ms
     * @returns {Promise<void>}
     */
    settleOrTimeout(promise, ms) {
      return new Promise((resolve) => {
        const handle = timers.setTimeout(() => resolve(), ms);
        const done = () => {
          timers.clearTimeout(handle);
          resolve();
        };
        promise.then(done, done);
      });
    },

    /** @param {Draft} entry */
    log(entry) {
      try {
        ctx.sink.push(ctx.job.videoId, ctx.job.id, [entry]);
      } catch {
        // A log that cannot be written must not stop the job.
      }
    },
    /** @param {readonly Draft[]} entries */
    logAll(entries) {
      if (entries.length === 0) return;
      try {
        ctx.sink.push(ctx.job.videoId, ctx.job.id, entries);
      } catch {
        // Same.
      }
    },
    /** @param {string} text */
    status: (text) => state.log(statusDraft(text)),
    /** @param {string} text @param {string} [detail] */
    error: (text, detail) => state.log(errorDraft(text, detail === undefined ? {} : { detail })),
    /** @param {string} text @param {string} detail */
    user: (text, detail) => state.log(draft("user", text, { detail })),

    /** @param {import("./driver.js").JobPatch} patch */
    update(patch) {
      try {
        ctx.onUpdate(patch);
      } catch {
        // The manager's problem; the job goes on.
      }
    },

    /**
     * Publishes `lastActivity`, `costUsd` and `progress`, at most every `progressInterval`
     * unless forced (a new progress stage goes out at once).
     * @param {boolean} force
     */
    flushProgress(force) {
      const progress = ctx.tracker.poll(force);
      if (state.activity === null && state.cost === null && progress === null) return;
      const now = clock.now();
      const due = force || now - state.lastProgress >= timings.progressInterval;
      if (!due && progress === null) return;
      state.lastProgress = now;
      /** @type {import("./driver.js").JobPatch} */
      const patch = {};
      if (due) {
        if (state.activity !== null) patch.lastActivity = state.activity;
        if (state.cost !== null) patch.costUsd = state.cost;
        state.activity = null;
        state.cost = null;
      }
      if (progress !== null) patch.progress = progress;
      state.update(patch);
    },
  };
  return state;
}

/** @typedef {ReturnType<typeof createDriverState>} DriverState */

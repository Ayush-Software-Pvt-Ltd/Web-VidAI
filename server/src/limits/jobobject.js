// The server's side of the Windows CPU limit (docs/SPEC.md section 9, CPU, Windows way): the
// protocol with the long-lived PowerShell helper that owns the Job Objects
// (`platform/jobobject.windows.js`), the rate arithmetic, and a client with a small state machine.
//
// NEVER EXECUTED against the real helper (it cannot be run on a Mac); everything here is pure or
// runs against a fake helper in the tests.
//
// The protocol, one JSON object per line each way:
//   helper -> server, once, after its compile:  {"ready":true}  or  {"ready":false,"error":"..."}
//   server -> helper:  {"id":1,"op":"create","job":"<key>"}
//                      {"id":2,"op":"assign","job":"<key>","pid":1234}
//                      {"id":3,"op":"setRate","job":"<key>","rate":625}
//                      {"id":4,"op":"terminate","job":"<key>"}
//                      {"id":5,"op":"close","job":"<key>"}
//   helper -> server:  {"id":1,"ok":true}  or  {"id":1,"ok":false,"error":"..."}
// The helper answers in the order of the requests. Closing a job closes its handle, and the job
// has kill-on-close, so `close` also ends processes that are still in it.
//
// States of the client: idle (no helper yet), starting (waiting for `ready`, requests queue up),
// ready, dead (the helper ended: every job it held is gone and its processes were ended by
// kill-on-close; the next request starts a new helper). Requests that were waiting or unanswered
// when the helper ended, or that got no answer in time, are rejected.

/** @typedef {import("../platform/jobobject.windows.js").HelperProcess} HelperProcess */
/** @typedef {import("./timers.js").Timers} Timers */

/** The scale of `CpuRate`: 1/100 of a percent of all processors. */
export const RATE_SCALE = 10_000;

/**
 * The `CpuRate` of a Job Object for a budget: the share of ALL processors in 1/100 of a percent,
 * from 1 to 10000 (a budget of 0.5 of 8 processors is 625).
 * @param {number} budget Processors the job may use.
 * @param {number} processors Logical processors of the computer.
 * @returns {number}
 */
export function jobRate(budget, processors) {
  const rate = Math.round((budget / Math.max(1, processors)) * RATE_SCALE);
  return Math.min(RATE_SCALE, Math.max(1, rate));
}

/**
 * @typedef {object} JobRequest
 * @property {"create" | "assign" | "setRate" | "terminate" | "close"} op
 * @property {string} job
 * @property {number} [pid] For `assign`.
 * @property {number} [rate] For `setRate`.
 */

/**
 * The line for a request. Characters outside ASCII are written as `\uXXXX`: the helper reads its
 * stdin in the console's code page, which is not UTF-8.
 * @param {number} id
 * @param {JobRequest} request
 * @returns {string} One line without a newline.
 */
export function requestLine(id, request) {
  /** @type {Record<string, unknown>} */
  const body = { id, op: request.op, job: request.job };
  if (request.pid !== undefined) body.pid = request.pid;
  if (request.rate !== undefined) body.rate = request.rate;
  return JSON.stringify(body).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * @typedef {{ kind: "ready", ok: boolean, error: string | null }
 *   | { kind: "answer", id: number, ok: boolean, error: string | null }
 *   | { kind: "invalid" }} Answer
 */

/**
 * Reads one line of the helper's output.
 * @param {string} line
 * @returns {Answer}
 */
export function parseAnswer(line) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "invalid" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { kind: "invalid" };
  const body = /** @type {Record<string, unknown>} */ (value);
  const error = typeof body.error === "string" ? body.error : null;
  if (typeof body.ready === "boolean") return { kind: "ready", ok: body.ready, error };
  if (typeof body.id === "number" && Number.isInteger(body.id) && typeof body.ok === "boolean") {
    return { kind: "answer", id: body.id, ok: body.ok, error };
  }
  return { kind: "invalid" };
}

/**
 * @typedef {object} ClientOptions
 * @property {() => HelperProcess} spawnHelper Starts a helper (throws when it cannot).
 * @property {Timers} timers
 * @property {{ info(message: string, detail?: unknown): void, warn(message: string, detail?: unknown): void }} [log]
 * @property {number} [startTimeoutMs] How long the compile may take (default 30 s).
 * @property {number} [requestTimeoutMs] How long one answer may take (default 15 s).
 */

/**
 * @typedef {object} Pending
 * @property {(error: Error | null) => void} settle
 * @property {unknown} timer The wait for the answer; `null` while the request is queued.
 * @property {() => void} arm Starts that wait (called when the line is written).
 */

/**
 * @param {ClientOptions} options
 */
export function createJobObjectClient({
  spawnHelper,
  timers,
  log,
  startTimeoutMs = 30_000,
  requestTimeoutMs = 15_000,
}) {
  /** @type {"idle" | "starting" | "ready" | "dead"} */
  let state = "idle";
  /** @type {HelperProcess | null} */
  let helper = null;
  let nextId = 1;
  /** @type {unknown} */
  let startTimer = null;
  /** @type {Map<number, Pending>} */
  const pending = new Map();
  /** @type {{ id: number, line: string }[]} */
  const queue = [];
  /** @type {(() => void)[]} */
  let exitWaiters = [];

  /** @param {Error} error */
  function failAll(error) {
    const all = [...pending.values()];
    pending.clear();
    queue.length = 0;
    for (const entry of all) {
      if (entry.timer !== null) timers.clearTimeout(entry.timer);
      entry.settle(error);
    }
  }

  /** @param {string} reason */
  function die(reason) {
    if (state === "dead") return;
    const old = helper;
    state = "dead";
    helper = null;
    if (startTimer !== null) timers.clearTimeout(startTimer);
    startTimer = null;
    failAll(new Error(reason));
    try {
      old?.kill();
    } catch {
      // Already gone.
    }
    const waiters = exitWaiters;
    exitWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /** @param {HelperProcess} owner @param {string} line */
  function onLine(owner, line) {
    if (owner !== helper) return;
    const answer = parseAnswer(line);
    if (answer.kind === "invalid") {
      log?.warn("CPU limit: the Windows helper said something unreadable", line.slice(0, 200));
      return;
    }
    if (answer.kind === "ready") {
      if (!answer.ok) {
        die(`the Windows CPU helper could not start: ${answer.error ?? "unknown reason"}`);
        return;
      }
      if (state !== "starting") return;
      state = "ready";
      if (startTimer !== null) timers.clearTimeout(startTimer);
      startTimer = null;
      for (const queued of queue.splice(0)) {
        pending.get(queued.id)?.arm();
        owner.write(queued.line);
      }
      return;
    }
    const entry = pending.get(answer.id);
    if (entry === undefined) return;
    pending.delete(answer.id);
    if (entry.timer !== null) timers.clearTimeout(entry.timer);
    entry.settle(answer.ok ? null : new Error(answer.error ?? "the Windows CPU helper refused"));
  }

  function start() {
    /** @type {HelperProcess} */
    let started;
    try {
      started = spawnHelper();
    } catch (error) {
      state = "dead";
      throw error;
    }
    helper = started;
    state = "starting";
    started.onLine((line) => onLine(started, line));
    started.onExit((code) => {
      if (started === helper) die(`the Windows CPU helper ended (exit code ${code ?? "none"})`);
    });
    startTimer = timers.setTimeout(() => {
      startTimer = null;
      die("the Windows CPU helper did not become ready in time");
    }, startTimeoutMs);
  }

  /**
   * @param {JobRequest} request
   * @returns {Promise<void>} Resolves when the helper says ok; rejects with its error, or when
   *   the helper ends or is silent.
   */
  function send(request) {
    return new Promise((resolve, reject) => {
      if (state === "idle" || state === "dead") {
        try {
          start();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      const id = nextId++;
      const line = requestLine(id, request);
      // The wait for an answer starts when the line is written: a request queued behind the
      // helper's compile is covered by the start timeout instead.
      /** @type {Pending} */
      const entry = {
        timer: null,
        settle: (error) => (error === null ? resolve() : reject(error)),
        arm: () => {
          entry.timer = timers.setTimeout(() => {
            pending.delete(id);
            reject(new Error(`the Windows CPU helper did not answer "${request.op}" in time`));
          }, requestTimeoutMs);
        },
      };
      pending.set(id, entry);
      if (state === "ready") {
        entry.arm();
        helper?.write(line);
      } else {
        queue.push({ id, line });
      }
    });
  }

  return {
    /** @returns {"idle" | "starting" | "ready" | "dead"} */
    state: () => state,
    /** Makes a Job Object (kill on close) under the key. @param {string} job */
    create: (job) => send({ op: "create", job }),
    /** Puts a running process into the job. @param {string} job @param {number} pid */
    assign: (job, pid) => send({ op: "assign", job, pid }),
    /** Sets the hard CPU rate, 1 to 10000. @param {string} job @param {number} rate */
    setRate: (job, rate) => send({ op: "setRate", job, rate }),
    /** Ends every process of the job. @param {string} job */
    terminate: (job) => send({ op: "terminate", job }),
    /** Closes the job (kill on close ends what is still in it). @param {string} job */
    close: (job) => send({ op: "close", job }),

    /**
     * Ends stdin so the helper closes its jobs and ends; kills it when it does not end within
     * `graceMs`. Resolves when it is gone. Never rejects.
     * @param {number} [graceMs]
     * @returns {Promise<void>}
     */
    stop(graceMs = 2000) {
      if (helper === null) {
        state = "dead";
        return Promise.resolve();
      }
      const current = helper;
      return new Promise((resolve) => {
        const timer = timers.setTimeout(() => die("the Windows CPU helper was stopped"), graceMs);
        exitWaiters.push(() => {
          timers.clearTimeout(timer);
          resolve();
        });
        try {
          current.end();
        } catch {
          // Closed already.
        }
      });
    },
  };
}

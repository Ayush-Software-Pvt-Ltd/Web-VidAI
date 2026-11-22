// The CPU budget of a heavy job enforced on its process tree on macOS (and Linux), docs/SPEC.md
// section 9, CPU: every `intervalMs` (half a second) the governor sums the CPU time the job's
// DESCENDANT processes used since the last sample and suspends them (SIGSTOP) while the job is
// ahead of its budget, resuming them (SIGCONT) when it is within it again.
//
// The accounting is one number per job, the balance in CPU seconds:
//
//   balance = min(cap, balance + budget * elapsedSeconds - cpuUsedSinceLastSample)
//
// The processes are held while the balance is below zero. After a burst of 8 processors for half a
// second against a budget of 0.5 the balance is -3.75 and the tree stays held for 7.5 seconds, so
// the long-run average is the budget; the error is bounded by one interval of use (not
// proportional to the run length). The tests pin the average to within 5 percent over 10 minutes.
//
// The burst cap: `cap = burstSeconds * budget`, with `burstSeconds` 2 by default (four
// intervals). Without a cap a job that was idle for ten minutes would own ten minutes of credit
// and could then run flat out for as long, which is not a budget. Two seconds of credit absorb
// the jitter of a sample (a process that starts, works and ends between two samples) and let a
// build step that wakes up run at full speed briefly, but no longer.
//
// What is measured and signalled:
//  - The agent program itself (`rootPid` with `exempt: true`) is never signalled and its CPU is
//    not counted, so its connection to the model never stalls; only its descendants are. A render
//    (`exempt: false`) counts and holds its whole tree, root included.
//  - Processes are signalled one pid at a time, never by group, and never the server itself.
//  - The tree is collected from ONE `ps` snapshot (`processes.snapshot`) with `collectTree` of
//    `process.posix.js`: descendants by parent id, members of the root's group, and processes
//    seen before that were handed to another parent. Processes that appear between samples are
//    picked up at the next sample (a process that started and ended inside one interval is never
//    seen: its CPU is not counted, a limit of sampling); one that vanished is forgotten.
//  - Pid reuse: a process is (pid, start time) from the same snapshot. CPU deltas are taken only
//    against the same (pid, start); a held process whose pid now has another start time is
//    dropped without a signal; the root's identity is recorded at the first sample and when it
//    no longer matches, the root and its group are not trusted (a stranger that reused the pid
//    is not adopted), only known members still matching (pid, start) are. Signals go out in the
//    same tick as the snapshot (no await between), so what is left is the few milliseconds the
//    kernel needs, and a pid cannot be reused that fast.
//  - A job that someone else froze (the job manager's pause: the root is in state T and not
//    held by us) is left alone and not charged until it runs again.
//
// Never leave anything stopped: `remove`, `resumeAll` and `stop` send SIGCONT to everything held
// at once and synchronously (by pid; a SIGCONT to a pid that was reused in the last half second
// is harmless unless the user had stopped that stranger by hand); an exception in one job's
// sample resumes that job and the other jobs go on; a `ps` that cannot run resumes every held
// job; `stop()` also runs on the `exit` event of the process, so a normal server exit resumes
// everything.
//
// If the server is KILLED (SIGKILL, power loss) while a tree is held, nothing can run: the held
// processes stay stopped (state T) and the job's agent waits on them forever. At the next start,
// recovery (SPEC section 8, Recovery) ends leftover trees through the registry of started
// processes; stopped processes do not react to SIGTERM until continued, so recovery must call
// `resumeLeftovers(pids)` first (it continues the whole tree of each pid), then end the trees.
// On Windows the Job Object ends the tree when the helper dies (see `jobobject.js`).

import { collectTree } from "../platform/process.posix.js";
import { systemProcessTable } from "../platform/cpu.js";
import { realTimers } from "./timers.js";

/**
 * @typedef {import("../platform/cpu.js").ProcessTable} ProcessTable
 * @typedef {import("../platform/cpu.js").ProcessRow} ProcessRow
 * @typedef {import("./timers.js").Timers} Timers
 */

/** @typedef {{ info(message: string, detail?: unknown): void, warn(message: string, detail?: unknown): void }} Log */

/**
 * @typedef {object} GovernorOptions
 * @property {{ now(): number }} clock
 * @property {Timers} [timers]
 * @property {number} [intervalMs] Time between samples (default 500).
 * @property {ProcessTable} [processes] The process table (default: this computer's).
 * @property {Log} [log]
 * @property {number} [burstSeconds] Seconds of budget a job may bank (default 2, see above).
 * @property {{ on(event: "exit", listener: () => void): unknown, off(event: "exit", listener: () => void): unknown } | null} [exitSource]
 *   Where the normal-exit event comes from (default: `process`; `null` registers nothing).
 */

/**
 * @typedef {object} Job
 * @property {string} key
 * @property {number} rootPid
 * @property {boolean} exempt
 * @property {number} budget Processors; `Infinity` while none is set (nothing is held).
 * @property {number} balance CPU seconds the job may still use (negative: ahead of its budget).
 * @property {number | null} lastAt Clock time of the last accounted sample (of the `add`
 *   before the first); `null` when there is no history to count from.
 * @property {string | null | undefined} rootStart Start time of the root at the first sample
 *   (`null`: the root was already gone then; `undefined`: not looked at yet).
 * @property {Map<number, { start: string, cpu: number }>} seen Measured processes at the last sample.
 * @property {Map<number, string>} held Processes this governor stopped, with their start times.
 */

/** @param {unknown} error */
const message = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {GovernorOptions} options
 */
export function createCpuGovernor({
  clock,
  timers = realTimers,
  intervalMs = 500,
  processes = systemProcessTable,
  log,
  burstSeconds = 2,
  exitSource = process,
}) {
  /** @type {Map<string, Job>} */
  const jobs = new Map();
  /** @type {unknown} */
  let timer = null;
  let sampling = false;
  let stopped = false;

  /** @param {string} text @param {unknown} [detail] */
  const warn = (text, detail) => {
    try {
      log?.warn(text, detail);
    } catch {
      // A broken log must not break the governor.
    }
  };

  /**
   * Continues everything the job holds, at once, by pid. Never throws.
   * @param {Job} job
   */
  function releaseNow(job) {
    for (const pid of job.held.keys()) {
      try {
        processes.signal(pid, "SIGCONT");
      } catch (error) {
        warn(`CPU limit: could not continue process ${pid}: ${message(error)}`);
      }
    }
    job.held.clear();
  }

  function onExit() {
    stop();
  }

  function ensureTimer() {
    if (timer !== null || stopped) return;
    timer = timers.setInterval(() => tick(), intervalMs);
    exitSource?.on("exit", onExit);
  }

  function dropTimer() {
    if (timer === null) return;
    timers.clearInterval(timer);
    timer = null;
    exitSource?.off("exit", onExit);
  }

  /**
   * The processes of the job to measure and hold, from one snapshot.
   * @param {Job} job
   * @param {ProcessRow[]} rows
   * @param {Map<number, ProcessRow>} byPid
   * @returns {{ rows: ProcessRow[], rootRow: ProcessRow | null }}
   */
  function measuredRows(job, rows, byPid) {
    const row = byPid.get(job.rootPid);
    if (job.rootStart === undefined) {
      job.rootStart = row !== undefined && !row.zombie ? row.start : null;
    }
    const rootRow = row !== undefined && !row.zombie && row.start === job.rootStart ? row : null;
    /** @type {number[]} */
    const known = [];
    for (const [pid, entry] of job.seen) {
      const other = byPid.get(pid);
      if (other !== undefined && other.start === entry.start) known.push(pid);
    }
    // Pid 0 is no process: a dead (or reused) root brings neither itself nor its group in.
    const tree = collectTree(rows, rootRow === null ? 0 : job.rootPid, { knownPids: known });
    /** @type {ProcessRow[]} */
    const measured = [];
    for (const pid of tree.pids) {
      if (job.exempt && pid === job.rootPid) continue;
      const member = byPid.get(pid);
      if (member !== undefined) measured.push(member);
    }
    return { rows: measured, rootRow };
  }

  /**
   * One sample of one job.
   * @param {Job} job
   * @param {ProcessRow[]} rows
   * @param {Map<number, ProcessRow>} byPid
   * @param {number} now
   */
  function sampleJob(job, rows, byPid, now) {
    if (!Number.isFinite(job.budget)) {
      // No limit: nothing is held and no history is kept.
      releaseNow(job);
      job.seen.clear();
      job.lastAt = null;
      job.balance = 0;
      return;
    }
    const { rows: measured, rootRow } = measuredRows(job, rows, byPid);
    if (rootRow === null) {
      // The root is gone: the job is ending. A frozen tree would ignore SIGTERM, so let it go.
      releaseNow(job);
      job.lastAt = null;
      job.seen = new Map(measured.map((row) => [row.pid, { start: row.start, cpu: row.cpu }]));
      return;
    }
    if (rootRow.stopped === true && !job.held.has(job.rootPid)) {
      // Frozen by the job manager (a pause): not ours to touch, and the frozen time is no credit.
      job.lastAt = null;
      for (const row of measured) job.seen.set(row.pid, { start: row.start, cpu: row.cpu });
      return;
    }

    const first = job.lastAt === null;
    let used = 0;
    /** @type {Map<number, { start: string, cpu: number }>} */
    const seen = new Map();
    for (const row of measured) {
      const before = job.seen.get(row.pid);
      if (before !== undefined && before.start === row.start) {
        used += Math.max(0, row.cpu - before.cpu);
      } else if (!first) {
        // A process that began since the last sample: all it has used is new.
        used += row.cpu;
      }
      seen.set(row.pid, { start: row.start, cpu: row.cpu });
    }
    job.seen = seen;
    for (const [pid, start] of [...job.held]) {
      // A held process that vanished, or whose pid belongs to another process now, is forgotten.
      const row = byPid.get(pid);
      if (row === undefined || row.zombie || row.start !== start) job.held.delete(pid);
    }

    const elapsed = first || job.lastAt === null ? 0 : Math.max(0, (now - job.lastAt) / 1000);
    job.lastAt = now;
    job.balance = Math.min(job.budget * burstSeconds, job.balance + job.budget * elapsed - used);

    if (job.balance < 0) {
      for (const row of measured) {
        // Already stopped (by us before, or by someone else): nothing to do. Held by us but
        // running again (the job manager continued the tree): stop it again.
        if (row.stopped) continue;
        if (processes.signal(row.pid, "SIGSTOP")) job.held.set(row.pid, row.start);
      }
    } else if (job.held.size > 0) {
      for (const [pid, start] of [...job.held]) {
        const row = byPid.get(pid);
        if (row !== undefined && row.start === start) processes.signal(pid, "SIGCONT");
        job.held.delete(pid);
      }
    }
  }

  async function sample() {
    /** @type {ProcessRow[] | null} */
    let rows = null;
    try {
      rows = await processes.snapshot();
    } catch (error) {
      warn(`CPU limit: the process table could not be read: ${message(error)}`);
    }
    if (stopped) return;
    if (rows === null) {
      // Without a table nothing can be measured: never keep processes frozen blind.
      for (const job of jobs.values()) releaseNow(job);
      return;
    }
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const now = clock.now();
    for (const job of [...jobs.values()]) {
      if (jobs.get(job.key) !== job) continue;
      try {
        sampleJob(job, rows, byPid, now);
      } catch (error) {
        warn(`CPU limit: sampling the job ${job.key} failed: ${message(error)}`);
        releaseNow(job);
      }
    }
  }

  /** One sample, never overlapping the previous one. Never rejects. */
  async function tick() {
    if (sampling || stopped) return;
    sampling = true;
    try {
      await sample();
    } catch (error) {
      warn(`CPU limit: a sample failed: ${message(error)}`);
      for (const job of jobs.values()) releaseNow(job);
    } finally {
      sampling = false;
    }
  }

  /** Continues everything of every job, forgets all, stops the timer. Never throws. */
  function stop() {
    stopped = true;
    for (const job of jobs.values()) releaseNow(job);
    jobs.clear();
    dropTimer();
  }

  return {
    /**
     * Starts watching the tree of a job. Until `setBudget` gives a number nothing is limited.
     * Adding a key again replaces the job (everything it held is continued first).
     * @param {string} jobKey
     * @param {{ rootPid: number, exempt: boolean }} options `exempt: true` for an agent program
     *   (its own process is never measured or signalled), `false` for a render (the whole tree).
     */
    add(jobKey, { rootPid, exempt }) {
      if (stopped) return;
      const old = jobs.get(jobKey);
      if (old) releaseNow(old);
      jobs.set(jobKey, {
        key: jobKey,
        rootPid,
        exempt,
        budget: Number.POSITIVE_INFINITY,
        balance: 0,
        // The accounting starts now: a job is added right after its process was spawned, so
        // all the CPU its tree has used so far is the job's own.
        lastAt: clock.now(),
        rootStart: undefined,
        seen: new Map(),
        held: new Map(),
      });
      ensureTimer();
    },

    /**
     * The processors the job may use now (fractions allowed); `Infinity` lifts the limit. The
     * balance stays, cut to the new burst cap.
     * @param {string} jobKey
     * @param {number} processors
     */
    setBudget(jobKey, processors) {
      const job = jobs.get(jobKey);
      if (job === undefined) return;
      const budget = processors > 0 ? processors : Number.POSITIVE_INFINITY;
      job.budget = budget;
      if (Number.isFinite(budget)) job.balance = Math.min(job.balance, budget * burstSeconds);
    },

    /**
     * Continues everything held, then forgets the job.
     * @param {string} jobKey
     */
    remove(jobKey) {
      const job = jobs.get(jobKey);
      if (job === undefined) return;
      releaseNow(job);
      jobs.delete(jobKey);
      if (jobs.size === 0) dropTimer();
    },

    /**
     * Continues everything the job holds, now; the job stays watched. Call it before a pause, a
     * stop or the end of the job (SPEC section 9).
     * @param {string} jobKey
     */
    resumeAll(jobKey) {
      const job = jobs.get(jobKey);
      if (job !== undefined) releaseNow(job);
    },

    stop,

    /**
     * What the governor knows of a job (tests and the System page).
     * @param {string} jobKey
     * @returns {{ budget: number, balance: number, held: number[], measured: number[] } | null}
     */
    inspect(jobKey) {
      const job = jobs.get(jobKey);
      if (job === undefined) return null;
      return {
        budget: job.budget,
        balance: job.balance,
        held: [...job.held.keys()].sort((a, b) => a - b),
        measured: [...job.seen.keys()].sort((a, b) => a - b),
      };
    },

    /** Runs one sample now and waits for it (tests drive time with this and a fake clock). */
    sample: tick,
  };
}

/**
 * Continues the whole tree of each pid (SIGCONT), for the start of the server after a crash:
 * see the file head. The registry of started processes gives the pids; call this before ending
 * the leftover trees, because a stopped process ignores SIGTERM. A SIGCONT to a process that is
 * not stopped does nothing, so a pid that was reused meanwhile is not harmed. Never throws.
 * @param {readonly number[]} pids
 * @param {{ processes?: ProcessTable, log?: Log }} [options]
 * @returns {Promise<number>} How many processes were sent the signal.
 */
export async function resumeLeftovers(pids, { processes = systemProcessTable, log } = {}) {
  let sent = 0;
  try {
    const rows = await processes.snapshot();
    /** @type {Set<number>} */
    const targets = new Set();
    for (const pid of pids) {
      targets.add(pid);
      if (rows !== null) for (const member of collectTree(rows, pid).pids) targets.add(member);
    }
    for (const pid of targets) {
      if (processes.signal(pid, "SIGCONT")) sent += 1;
    }
  } catch (error) {
    try {
      log?.warn(`CPU limit: continuing leftover processes failed: ${message(error)}`);
    } catch {
      // Nothing more to do.
    }
  }
  return sent;
}

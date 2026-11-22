// One CPU limiter for both systems (docs/SPEC.md section 9, CPU), so that the job manager never
// tests the platform: on macOS (and Linux) the governor of `throttle.js` suspends and resumes the
// job's descendants; on Windows the Job Object with a hard CPU rate limit does it through the
// PowerShell helper of `jobobject.js`.
//
// What differs, and what the job manager can rely on in both:
//  - `add(jobKey, { rootPid, exempt })`: macOS never touches the root when `exempt` (the agent
//    program); Windows puts the root and its tree into the Job Object, so the whole job is limited
//    by a rate (SPEC: "the job's process tree runs in a Job Object"). `exempt` is ignored there.
//  - `resumeAll(jobKey)`: continues everything the governor froze (macOS); nothing is ever frozen
//    on Windows, so it does nothing.
//  - `terminate(jobKey)`: the Windows Job Object ends the tree; on macOS it does nothing and the
//    caller's `endTree` does the work. Always call `endTree` too.
//  - `remove(jobKey)`: macOS continues everything and forgets the job; Windows closes the job,
//    which (kill on close) ends what is still in it.
// None of them throws; Windows requests are queued in order per job and their failures only reach
// the log (a limit that cannot be applied must not stop a job).

import { listTree as systemListTree } from "../platform/process.js";
import { jobRate, createJobObjectClient } from "./jobobject.js";
import { createCpuGovernor, resumeLeftovers } from "./throttle.js";
import { realTimers } from "./timers.js";

/**
 * @typedef {object} CpuLimiter
 * @property {(jobKey: string, options: { rootPid: number, exempt: boolean }) => void} add
 * @property {(jobKey: string, processors: number) => void} setBudget Processors the job may use
 *   (fractions allowed; `Infinity` lifts the limit).
 * @property {(jobKey: string) => void} remove
 * @property {(jobKey: string) => void} resumeAll
 * @property {(jobKey: string) => Promise<boolean>} terminate Whether the system ended the tree.
 * @property {() => Promise<void>} stop Resumes and closes everything; never rejects.
 * @property {(pids: readonly number[]) => Promise<number>} resumeLeftovers For the start after
 *   a crash: continues the trees of leftover processes (macOS; nothing to do on Windows).
 * @property {(jobKey: string) => unknown} inspect What the limiter knows of a job (diagnostics).
 */

/**
 * @typedef {object} LimiterOptions
 * @property {string} platform `process.platform`; `"win32"` picks the Job Object.
 * @property {number} processors Logical processors (the Windows rate is a share of them).
 * @property {{ now(): number }} clock
 * @property {import("./timers.js").Timers} [timers]
 * @property {import("./throttle.js").Log} [log]
 * @property {import("../platform/cpu.js").ProcessTable} [processes] Test seam of the governor.
 * @property {number} [intervalMs] Test seam of the governor.
 * @property {import("./throttle.js").GovernorOptions["exitSource"]} [exitSource] Test seam.
 * @property {import("./jobobject.js").ClientOptions["spawnHelper"]} [spawnHelper] Test seam of
 *   the Windows helper.
 * @property {(rootPid: number) => Promise<number[]>} [listTree] Test seam of the Windows tree.
 */

/**
 * @param {LimiterOptions} options
 * @returns {CpuLimiter}
 */
export function createCpuLimiter(options) {
  return options.platform === "win32" ? createWindowsLimiter(options) : createPosixLimiter(options);
}

/**
 * @param {LimiterOptions} options
 * @returns {CpuLimiter}
 */
function createPosixLimiter({ clock, timers, log, processes, intervalMs, exitSource }) {
  const governor = createCpuGovernor({
    clock,
    ...(timers ? { timers } : {}),
    ...(log ? { log } : {}),
    ...(processes ? { processes } : {}),
    ...(intervalMs === undefined ? {} : { intervalMs }),
    ...(exitSource === undefined ? {} : { exitSource }),
  });
  return {
    add: (jobKey, opts) => governor.add(jobKey, opts),
    setBudget: (jobKey, processors) => governor.setBudget(jobKey, processors),
    remove: (jobKey) => governor.remove(jobKey),
    resumeAll: (jobKey) => governor.resumeAll(jobKey),
    terminate: async () => false,
    stop: async () => governor.stop(),
    resumeLeftovers: (pids) =>
      resumeLeftovers(pids, { ...(processes ? { processes } : {}), ...(log ? { log } : {}) }),
    inspect: (jobKey) => governor.inspect(jobKey),
  };
}

/**
 * @typedef {object} WindowsJob
 * @property {Promise<boolean>} chain Requests of the job run one after another; resolves to
 *   whether the job exists in the helper (false after a failed create).
 * @property {number | null} budget
 */

/**
 * @param {LimiterOptions} options
 * @returns {CpuLimiter}
 */
function createWindowsLimiter({
  processors,
  timers = realTimers,
  log,
  spawnHelper,
  listTree = systemListTree,
}) {
  if (spawnHelper === undefined) {
    throw new Error("the Windows limiter needs a way to start its helper");
  }
  const client = createJobObjectClient({ spawnHelper, timers, ...(log ? { log } : {}) });
  /** @type {Map<string, WindowsJob>} */
  const jobs = new Map();

  /** @param {string} text @param {unknown} error */
  const warn = (text, error) => {
    try {
      log?.warn(`CPU limit: ${text}: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      // A broken log must not break the limiter.
    }
  };

  /**
   * Runs `step` after the job's earlier requests, only while the job exists in the helper.
   * @param {WindowsJob} job
   * @param {string} what
   * @param {() => Promise<void>} step
   */
  function queue(job, what, step) {
    job.chain = job.chain.then(async (exists) => {
      if (!exists) return false;
      try {
        await step();
      } catch (error) {
        warn(what, error);
      }
      return true;
    });
  }

  return {
    add(jobKey, { rootPid }) {
      const old = jobs.get(jobKey);
      if (old) queue(old, `closing the replaced job ${jobKey}`, () => client.close(jobKey));
      /** @type {WindowsJob} */
      const job = { chain: Promise.resolve(true), budget: null };
      jobs.set(jobKey, job);
      // Replacing a job: the old one's close is queued first, then the new one is created.
      job.chain = (old ? old.chain : Promise.resolve(true)).then(async () => {
        try {
          await client.create(jobKey);
        } catch (error) {
          warn(`creating the Job Object of ${jobKey}`, error);
          return false;
        }
        try {
          await client.assign(jobKey, rootPid);
        } catch (error) {
          warn(`putting process ${rootPid} into the Job Object of ${jobKey}`, error);
        }
        // Children that started before the root was assigned are not in the job yet.
        try {
          for (const pid of await listTree(rootPid)) {
            if (pid === rootPid) continue;
            await client.assign(jobKey, pid).catch(() => {});
          }
        } catch (error) {
          warn(`listing the processes of ${jobKey}`, error);
        }
        return true;
      });
    },

    setBudget(jobKey, budget) {
      const job = jobs.get(jobKey);
      if (job === undefined) return;
      const value = budget > 0 && Number.isFinite(budget) ? budget : processors;
      job.budget = value;
      queue(job, `setting the CPU rate of ${jobKey}`, () =>
        client.setRate(jobKey, jobRate(value, processors)),
      );
    },

    remove(jobKey) {
      const job = jobs.get(jobKey);
      if (job === undefined) return;
      jobs.delete(jobKey);
      queue(job, `closing the Job Object of ${jobKey}`, () => client.close(jobKey));
    },

    resumeAll() {},

    async terminate(jobKey) {
      const job = jobs.get(jobKey);
      if (job === undefined) return false;
      let ended = false;
      queue(job, `ending the Job Object of ${jobKey}`, async () => {
        await client.terminate(jobKey);
        ended = true;
      });
      await job.chain;
      return ended;
    },

    async stop() {
      try {
        await Promise.all([...jobs.values()].map((job) => job.chain));
        jobs.clear();
        await client.stop();
      } catch (error) {
        warn("stopping the helper", error);
      }
    },

    resumeLeftovers: async () => 0,
    inspect: (jobKey) => {
      const job = jobs.get(jobKey);
      return job === undefined ? null : { budget: job.budget };
    },
  };
}

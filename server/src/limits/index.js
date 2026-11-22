// The limits module (docs/SPEC.md section 9, resource limits): the CPU budget of every heavy job
// (told to its tools, enforced on its process tree) and the approximate GPU limit as slot files.
// `createLimitsModule(deps)` is plugged into the composition root like the storage module:
// `start()` and `stop()` into the server's life, `api` into the job manager.
//
// What the job manager calls, and when:
//  - Before it starts a heavy job's process: `envFor(jobKey)` for the environment
//    (`VE_CPU_CORES`, `VE_GPU_SLOTS_DIR`, `VE_JOB_ID`) and, for a render, `renderWorkers`.
//  - Right after the process is spawned: `jobStarted(jobKey, { rootPid, kind })`. A heavy job is
//    an agent job (`edit`, `reEdit`, `timelineEdit`), a `render` or a preview-copy job (`proxy`);
//    `rootPid` is `null` for work that runs inside the server (nothing to limit, it still counts).
//    It recomputes every running job's budget.
//  - Before it pauses, stops or ends a job: `resumeAll(jobKey)`.
//  - When the process is gone (any way): `jobEnded(jobKey)` (continues and forgets the tree, frees
//    the job's GPU slots, recomputes the others).
//  - For a render that wants a GPU: `acquireGpuSlot(jobKey, signal)`.
//  - On the start of the server, before ending leftover trees: `resumeLeftovers(pids)`.

import os from "node:os";
import path from "node:path";
import { gpuSlots, cpuBudget, cpuCoresEnv, renderWorkers } from "./budget.js";
import { createGpuSlotKeeper, acquireGpuSlot } from "./gpuSlots.js";
import { createCpuLimiter } from "./limiter.js";
import { realTimers } from "./timers.js";
import { dataPaths } from "../config.js";
import { spawnJobHelper } from "../platform/jobobject.windows.js";

export { createCpuLimiter } from "./limiter.js";

/** The job kinds whose root process is an agent program (never suspended itself on macOS). */
const AGENT_KINDS = new Set(["edit", "reEdit", "timelineEdit"]);

/**
 * @typedef {object} LimitsDeps
 * @property {{ getAll(): import("../../../src/lib/wire.ts").AdminSettings }} settings
 * @property {string} dataDir
 * @property {import("../db/open.js").Clock} clock
 * @property {import("./timers.js").Timers} [timers]
 * @property {import("../log.js").Logger} log
 * @property {string} [platform] Only tests pass it (default: the running system).
 * @property {number} [processors] Logical processors (default: this computer's).
 * @property {{ subscribe(who: { userId: string, role: "admin" | "user" }, listener: (event: { event: string }) => void): () => void }} [events]
 *   The event bus: `settings-changed` makes the limits recompute at once. Without it the
 *   composition root calls `api.refresh()` after a change.
 * @property {(pid: number) => boolean} [isAlive] Test seam of the GPU slots.
 * @property {Omit<import("./limiter.js").LimiterOptions, "platform" | "processors" | "clock" | "timers" | "log">} [limiterOptions]
 *   Test seams of the CPU limiter (a fake process table, a fake Windows helper).
 */

/**
 * @typedef {object} JobLimits What a job is started with.
 * @property {number} budget Processors it may use now (may be fractional).
 * @property {number} cpuCores `VE_CPU_CORES`: the budget rounded up, at least 1.
 * @property {number} renderWorkers `hyperframes render --workers` for this budget.
 */

/**
 * @param {LimitsDeps} deps
 */
export function createLimitsModule({
  settings,
  dataDir,
  clock,
  timers = realTimers,
  log,
  platform = process.platform,
  processors = os.availableParallelism(),
  events,
  isAlive,
  limiterOptions = {},
}) {
  const gpuDir = path.join(dataPaths(dataDir).locksDir, "gpu");
  const slots = createGpuSlotKeeper({
    dir: gpuDir,
    clock,
    timers,
    log,
    ...(isAlive ? { isAlive } : {}),
  });
  const limiter = createCpuLimiter({
    platform,
    processors,
    clock,
    timers,
    log,
    ...(platform === "win32" ? { spawnHelper: () => spawnJobHelper() } : {}),
    ...limiterOptions,
  });
  /** The heavy jobs running now, in the order they started. @type {Map<string, { kind: string, rootPid: number | null }>} */
  const jobs = new Map();
  /** @type {string | null} */
  let writtenLimits = null;
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  let started = false;

  /** @param {number} running */
  function budgetFor(running) {
    const all = settings.getAll();
    return cpuBudget({
      processors,
      perEditPercent: all.cpuPerEditPercent,
      totalPercent: all.cpuTotalPercent,
      running,
    });
  }

  /** @param {number} budget @returns {JobLimits} */
  function limitsOf(budget) {
    return { budget, cpuCores: cpuCoresEnv(budget), renderWorkers: renderWorkers(budget) };
  }

  /** Gives every running job its budget for the number of jobs running. */
  function applyBudgets() {
    const budget = budgetFor(jobs.size);
    for (const [jobKey, job] of jobs) {
      if (job.rootPid !== null) limiter.setBudget(jobKey, budget >= processors ? Infinity : budget);
    }
  }

  /** Writes `limits.json` when the settings changed it (or when `force`). @param {boolean} force */
  function applyGpuLimits(force) {
    const all = settings.getAll();
    const next = gpuSlots({
      perEditPercent: all.gpuPerEditPercent,
      totalPercent: all.gpuTotalPercent,
    });
    const text = JSON.stringify(next);
    if (!force && text === writtenLimits) return;
    try {
      slots.setLimits(next);
      writtenLimits = text;
    } catch (error) {
      log.warn("GPU slots: limits.json could not be written", error);
    }
  }

  function refresh() {
    applyBudgets();
    applyGpuLimits(false);
  }

  return {
    name: "limits",

    /** Writes `limits.json`, starts the sweep of GPU slots and listens for settings changes. */
    start() {
      if (started) return;
      started = true;
      applyGpuLimits(true);
      slots.start();
      if (events) {
        unsubscribe = events.subscribe({ userId: "limits-module", role: "user" }, (event) => {
          if (event.event === "settings-changed") refresh();
        });
      }
    },

    /** Continues every frozen process, closes the Windows helper and stops the sweep. */
    async stop() {
      started = false;
      unsubscribe?.();
      unsubscribe = null;
      slots.stop();
      await limiter.stop();
    },

    /** What the job manager builds on. */
    api: {
      /**
       * A heavy job's process was spawned: counts it, limits its tree and recomputes every
       * running job's budget. Calling it again for a key (a new process of the same job)
       * replaces the old tree.
       * @param {string} jobKey The job id.
       * @param {{ rootPid: number | null, kind: string }} job
       * @returns {JobLimits}
       */
      jobStarted(jobKey, { rootPid, kind }) {
        jobs.set(jobKey, { kind, rootPid });
        if (rootPid !== null) {
          limiter.add(jobKey, { rootPid, exempt: AGENT_KINDS.has(kind) });
        } else {
          limiter.remove(jobKey);
        }
        applyBudgets();
        return limitsOf(budgetFor(jobs.size));
      },

      /**
       * The job's process is gone: continues and forgets its tree, frees its GPU slots, gives the
       * others their larger budgets.
       * @param {string} jobKey
       */
      jobEnded(jobKey) {
        const had = jobs.delete(jobKey);
        limiter.remove(jobKey);
        slots.endJob(jobKey);
        if (had) applyBudgets();
      },

      /**
       * The environment variables of a job's programs. Callable before `jobStarted`: the budget is
       * then the one the job will have once it is counted.
       * @param {string} jobKey
       * @returns {{ VE_CPU_CORES: string, VE_GPU_SLOTS_DIR: string, VE_JOB_ID: string }}
       */
      envFor(jobKey) {
        return {
          VE_CPU_CORES: String(
            limitsOf(budgetFor(jobs.has(jobKey) ? jobs.size : jobs.size + 1)).cpuCores,
          ),
          VE_GPU_SLOTS_DIR: gpuDir,
          VE_JOB_ID: jobKey,
        };
      },

      /**
       * What a job would be started with now (see `envFor`).
       * @param {string} jobKey
       * @returns {JobLimits}
       */
      limitsFor: (jobKey) => limitsOf(budgetFor(jobs.has(jobKey) ? jobs.size : jobs.size + 1)),

      /**
       * Continues everything frozen for the job; call it before a pause, a stop or an end.
       * @param {string} jobKey
       */
      resumeAll: (jobKey) => limiter.resumeAll(jobKey),

      /**
       * Ends the job's tree through the system where it can (the Windows Job Object); on macOS
       * the caller's `endTree` does it. Always call `endTree` as well.
       * @param {string} jobKey
       * @returns {Promise<boolean>}
       */
      terminate: (jobKey) => limiter.terminate(jobKey),

      /**
       * Takes a GPU slot for the job's render and holds it until `release()` or `signal` aborts.
       * @param {string} jobKey
       * @param {AbortSignal} [signal]
       * @returns {Promise<import("./gpuSlots.js").HeldSlot>}
       */
      acquireGpuSlot: (jobKey, signal) =>
        acquireGpuSlot({
          dir: gpuDir,
          jobId: jobKey,
          ...(signal ? { signal } : {}),
          clock,
          timers,
          log,
          ...(isAlive ? { isAlive } : {}),
        }),

      /**
       * For the System page: the GPU limits and who holds which slot.
       * @returns {{ total: number, perJob: number, slots: import("./gpuSlots.js").GpuSlotView[] }}
       */
      gpuState() {
        const all = settings.getAll();
        const limits = gpuSlots({
          perEditPercent: all.gpuPerEditPercent,
          totalPercent: all.gpuTotalPercent,
        });
        return { ...limits, slots: slots.list() };
      },

      /**
       * For the System page: the CPU limits now.
       * @returns {{ processors: number, running: number, budget: number }}
       */
      cpuState: () => ({ processors, running: jobs.size, budget: budgetFor(jobs.size) }),

      /**
       * Recomputes the budgets and `limits.json` from the settings now (also done on
       * `settings-changed` when the event bus was given).
       */
      refresh,

      /**
       * For the start of the server after a crash: continues the trees of the leftover processes
       * so they can be ended (a stopped process ignores SIGTERM). Call it before `endTree`.
       * @param {readonly number[]} pids
       * @returns {Promise<number>}
       */
      resumeLeftovers: (pids) => limiter.resumeLeftovers(pids),
    },
  };
}

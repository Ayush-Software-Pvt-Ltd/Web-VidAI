// The jobs module (docs/SPEC.md sections 8 and 9): the job manager, the queue service and their
// RPC functions. `createJobsModule(deps)` is plugged into the composition root like the library
// and the timeline; it returns `{ name, rpc, hooks, start, stop, api }`.
//
// Deps (everything the manager touches is injected; the defaults are the real thing):
// - `db`, `dataDir`, `clock`, `timers`, `log`, `events` as everywhere;
// - `settings`: the admin settings (`getAll()`); `users`: the users repository (default: made from `db`);
// - `harness`: `createHarnessModule(...)` (`launchFor`, `jobEnv`, `ensureReady`, `secretsToScrub`);
// - `claude`: the Claude module (`locate`, `forgetLogin`, `recordRateLimitEvent`);
// - `limits`: `limits.api`; `library`: `library.api`; `timeline`: `timeline.api`;
// - `toolkit`: `{ folder, python }` (the `CLAUDE_VE_ALL` folder and the toolkit's Python: platform
//   dependent, so it is given, never computed here);
// - `machine`: `createMachineProbe()`; `hyperframesBin`, `nodePath`, `baseEnv`: what the agent's
//   environment gets (defaults: the pinned HyperFrames, this Node.js, the Claude agent environment);
// - `renderRunner`: `{ run(job, facts) => { done, stop() } }` (`render.runner`); null: render jobs fail;
// - `describeNotes(videoKey, notes) => Promise<PromptRequest[]>`: turns taken change requests into
//   prompt requests (pictures, clips, words); default: clips from `timeline.clipsAt`, no pictures;
// - `editLog`: `{ record({ userId, videoKey, event, message }) }`, optional;
// - `programs`: `{ claudeCode, opencode2 }` returning the command (default: the located ones);
// - test seams: `startAgent`, `agentTimings`, `driverTimings`, `registry`, `sink`, `logStore`,
//   `history`, `shutdownMs` (default 20 s), `maxWaitMs`.
//
// Wiring notes for `app.js` (build order: harness, claude, limits, then library and timeline with
// late-bound functions into the jobs module, then the jobs module):
//   const library = createLibraryModule({ ..., jobsFor: (keys) => jobs.api.jobsFor(keys) });
//   const timeline = createTimelineModule({ ..., library: library.api,
//     activeJob: (k) => jobs.api.activeJob(k),
//     requestTimelineEdit: (r) => jobs.api.requestTimelineEdit(r) });
//   const jobs = createJobsModule({ ..., library: library.api, timeline: timeline.api });
//   `jobs.hooks` goes into `createRpc({ hooks })`, `jobs.rpc` into `rpc.register`, and the RPC layer
//   gets `eventsKickingOnSettings(events, jobs.api.kick)`. Call `jobs.start()` after the toolkit is
//   ready and `jobs.stop()` on shutdown, before the limits and the log are closed.

import fs from "node:fs";
import path from "node:path";
import { dataPaths } from "../config.js";
import { agentEnv } from "../agents/claude/env.js";
import { createLaunchesRepo } from "../db/launches.js";
import { createJobsRepo } from "../db/jobs.js";
import { createProgressHistory } from "../db/progressHistory.js";
import { createUsersRepo } from "../db/users.js";
import { createVideosRepo } from "../db/videos.js";
import { isAlive } from "../platform/process.js";
import { endTree } from "../platform/process.js";
import { findHyperframesCli } from "../timeline/lint.js";
import { jobsFunctions } from "../rpc/jobs.js";
import { queueFunctions } from "../rpc/queue.js";
import { createJobManager } from "./manager.js";
import { createRuns } from "./managerRuns.js";
import { createLogSink, createLogStore, realTimers } from "./log.js";
import { createProcessRegistry } from "./registry.js";
import { createQueueService, eventsKickingOnSettings } from "./queueService.js";

export { eventsKickingOnSettings };

/** The default `describeNotes`: the clips at each frame, no pictures and no spoken words. */
/**
 * @param {import("./managerDeps.js").ManagerDeps["timeline"]} timeline
 * @returns {import("./managerDeps.js").ManagerDeps["describeNotes"]}
 */
function defaultDescribeNotes(timeline) {
  return (videoKey, notes) =>
    Promise.all(
      notes.map(async (note) => ({
        frame: note.frame,
        shape: note.shape,
        elementId: note.elementId,
        prompt: note.prompt,
        pictures: { frame: null, closeup: null, marked: null },
        clips: await timeline.clipsAt(videoKey, note.frame),
        spoken: null,
      })),
    );
}

/**
 * @typedef {object} JobsDeps
 * @property {import("../db/open.js").Database} db
 * @property {string} dataDir
 * @property {import("../db/open.js").Clock} clock
 * @property {import("./managerDeps.js").ManagerDeps["timers"]} [timers]
 * @property {import("../log.js").Logger} log
 * @property {{ emit(event: { event: string, payload: unknown, userId: string | null, admins: boolean }): void }} events
 * @property {import("./managerDeps.js").ManagerDeps["settings"]} settings
 * @property {import("./managerDeps.js").ManagerDeps["harness"]} harness
 * @property {import("./managerDeps.js").ManagerDeps["claude"]} claude
 * @property {import("./managerDeps.js").ManagerDeps["limits"]} limits
 * @property {import("./managerDeps.js").ManagerDeps["library"]} library
 * @property {import("./managerDeps.js").ManagerDeps["timeline"]} timeline
 * @property {import("./managerDeps.js").ManagerDeps["toolkit"]} toolkit
 * @property {import("./managerDeps.js").ManagerDeps["machine"]} machine
 * @property {string} [hyperframesBin]
 * @property {string} [nodePath]
 * @property {Record<string, string | undefined>} [baseEnv]
 * @property {import("./managerDeps.js").ManagerDeps["renderRunner"]} [renderRunner]
 * @property {import("./managerDeps.js").ManagerDeps["describeNotes"]} [describeNotes]
 * @property {import("./managerDeps.js").ManagerDeps["editLog"]} [editLog]
 * @property {import("./managerDeps.js").ManagerDeps["programs"]} [programs]
 * @property {import("./managerDeps.js").ManagerDeps["startAgent"]} [startAgent]
 * @property {import("./managerDeps.js").ManagerDeps["agentTimings"]} [agentTimings]
 * @property {import("./managerDeps.js").ManagerDeps["driverTimings"]} [driverTimings]
 * @property {import("./managerDeps.js").ManagerDeps["registry"]} [registry]
 * @property {import("./managerDeps.js").ManagerDeps["sink"]} [sink]
 * @property {import("./managerDeps.js").ManagerDeps["logStore"]} [logStore]
 * @property {import("./managerDeps.js").ManagerDeps["history"]} [history]
 * @property {import("./managerDeps.js").ManagerDeps["isBusy"]} [isBusy]
 * @property {number} [shutdownMs]
 * @property {number} [maxWaitMs]
 */

/** @param {JobsDeps} deps */
export function createJobsModule(deps) {
  const { db, dataDir, clock, log, events, library } = deps;
  const timers = deps.timers ?? realTimers;
  const paths = dataPaths(dataDir);
  const jobs = createJobsRepo(db, { clock });
  const videos = createVideosRepo(db, { clock });
  const users = createUsersRepo(db, { clock });
  const logStore = deps.logStore ?? createLogStore({ dir: paths.logsDir });
  const sink =
    deps.sink ??
    createLogSink({
      store: logStore,
      clock,
      timers,
      onError: (error) => log.warn(`Could not write a job log: ${String(error)}`),
      // SPEC section 14: the log goes to the owner only. A job without a row has no owner, and a
      // null `userId` would mean everybody, so nothing is sent then.
      notify: ({ videoId, jobId, entries }) => {
        const userId = jobs.get(jobId)?.userId;
        if (!userId) return;
        events.emit({
          event: "job-log",
          payload: { videoId, jobId, entries },
          userId,
          admins: false,
        });
      },
    });
  const registry =
    deps.registry ??
    createProcessRegistry({
      file: path.join(dataDir, "processes.json"),
      isAlive,
      endTree,
      clock,
      log,
    });

  // The queue launches through the manager, which needs the queue: closed over a slot.
  /** @type {{ current: ReturnType<typeof createJobManager> | null }} */
  const slot = { current: null };
  const queues = createQueueService({
    jobs,
    launches: createLaunchesRepo(db),
    settings: deps.settings,
    events,
    launch: (job) => slot.current?.launch(job),
    describeVideo: (key) => library.describeKey(key) ?? undefined,
    clock,
    timers,
    log,
    usersMayMarkUrgent: (userId) => users.byId(userId)?.mayMarkUrgent ?? false,
    sessionOf: (key) => videos.byKey(key)?.sessionId ?? null,
    removeLogs: (ids) => {
      for (const id of ids) fs.rmSync(logStore.path(id), { force: true });
    },
    ...(deps.maxWaitMs === undefined ? {} : { maxWaitMs: deps.maxWaitMs }),
  });

  const manager = createJobManager({
    jobs,
    videos,
    users,
    queues,
    settings: deps.settings,
    harness: deps.harness,
    claude: deps.claude,
    limits: deps.limits,
    library,
    timeline: deps.timeline,
    runs: createRuns(),
    sink,
    logStore,
    registry,
    history: deps.history ?? createProgressHistory(db),
    machine: deps.machine,
    toolkit: deps.toolkit,
    dataDir,
    hyperframesBin: deps.hyperframesBin ?? findHyperframesCli() ?? "",
    nodePath: deps.nodePath ?? process.execPath,
    baseEnv: deps.baseEnv ?? agentEnv(process.env),
    clock,
    ...(deps.timers ? { timers: deps.timers } : {}),
    log,
    renderRunner: deps.renderRunner ?? null,
    describeNotes: deps.describeNotes ?? defaultDescribeNotes(deps.timeline),
    editLog: deps.editLog ?? null,
    programs: deps.programs ?? {},
    ...(deps.startAgent ? { startAgent: deps.startAgent } : {}),
    ...(deps.agentTimings ? { agentTimings: deps.agentTimings } : {}),
    ...(deps.driverTimings ? { driverTimings: deps.driverTimings } : {}),
    ...(deps.isBusy ? { isBusy: deps.isBusy } : {}),
    shutdownMs: deps.shutdownMs ?? 20_000,
  });

  slot.current = manager;

  return {
    name: "jobs",
    rpc: [
      ...queueFunctions({
        queues,
        jobs,
        users,
        describeVideo: (key) => library.describeKey(key) ?? undefined,
      }),
      ...jobsFunctions({ manager }),
    ],
    hooks: {
      activeJobCount: (/** @type {string} */ userId) => manager.activeJobCount(userId),
      onUserDisabled: (/** @type {string} */ userId) => manager.stopJobsOf(userId),
      onUserRemoved: (/** @type {string} */ userId) => manager.stopJobsOf(userId),
    },
    start: () => manager.start(),
    stop: async () => {
      await manager.stop();
      sink.close();
    },
    api: {
      queues,
      kick: () => queues.kick(),
      activeJob: manager.activeJob,
      activeJobOf: manager.activeJob,
      jobsFor: manager.jobsFor,
      requestTimelineEdit: manager.requestTimelineEdit,
      enqueue: queues.enqueue,
      sink,
      registry,
      logStore,
    },
  };
}

/** @typedef {ReturnType<typeof createJobsModule>} JobsModule */

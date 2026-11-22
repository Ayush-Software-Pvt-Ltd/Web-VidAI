// The collaborators of the job manager (types only; the list is documented in `index.js`).

/**
 * @typedef {object} ManagerDeps
 * @property {ReturnType<typeof import("../db/jobs.js").createJobsRepo>} jobs
 * @property {ReturnType<typeof import("../db/videos.js").createVideosRepo>} videos
 * @property {ReturnType<typeof import("../db/users.js").createUsersRepo>} users
 * @property {ReturnType<typeof import("./queueService.js").createQueueService>} queues
 * @property {{ getAll(): import("../../../src/lib/wire.ts").AdminSettings }} settings
 * @property {ReturnType<typeof import("../agents/index.js").createHarnessModule>} harness
 * @property {{ locate(): Promise<{ path: string } | null> | { path: string } | null, forgetLogin(): void, recordRateLimitEvent(raw: unknown): void }} claude
 * @property {ReturnType<typeof import("../limits/index.js").createLimitsModule>["api"]} limits
 * @property {import("../library/index.js").LibraryModule["api"]} library
 * @property {import("../timeline/index.js").TimelineModule["api"]} timeline
 * @property {import("./managerRuns.js").Runs} runs
 * @property {ReturnType<typeof import("./logSink.js").createLogSink>} sink
 * @property {ReturnType<typeof import("./logStore.js").createLogStore>} logStore
 * @property {ReturnType<typeof import("./registry.js").createProcessRegistry>} registry
 * @property {import("./progressPacing.js").ProgressHistory} history
 * @property {{ facts(): Promise<import("./promptHeader.js").PromptContext["machine"] & object> }} machine
 * @property {{ folder: string, python: string, env?: () => Record<string, string> }} toolkit
 *   `env`: the toolkit's own variables (`VE_FFMPEG`, `VE_FFPROBE`, `VE_NPX`, ...; `toolkit.api.env()`).
 * @property {string} dataDir
 * @property {string} hyperframesBin
 * @property {string} nodePath
 * @property {Record<string, string | undefined>} baseEnv
 * @property {import("../db/open.js").Clock} clock
 * @property {import("./driverMailbox.js").Timers} [timers]
 * @property {Partial<import("../log.js").Logger>} log
 * @property {import("./managerTypes.js").RenderRunner | null} renderRunner
 * @property {(videoKey: string, notes: Awaited<ReturnType<import("../timeline/index.js").TimelineModule["api"]["takeNotes"]>>) => Promise<import("./promptTimeline.js").PromptRequest[]>} describeNotes
 * @property {{ record(entry: import("./managerTypes.js").EditLogEntry): void } | null} editLog
 * @property {Partial<Record<"claudeCode" | "opencode2", () => Promise<string | null> | string | null>>} programs
 * @property {typeof import("../agents/start.js").startAgent} [startAgent]
 * @property {Partial<import("../agents/opencode/child.js").Timings>} [agentTimings] Start and exit timings of the OpenCode child.
 * @property {Partial<import("./driverState.js").DriverTimings>} [driverTimings]
 * @property {(videoKey: string) => boolean} [isBusy] The working files of the video are being deleted (Disk Cleanup).
 * @property {number} shutdownMs
 */

export {};

// The engine of the server: builds every feature module from the `AppContext` and says in which
// order they start and stop (docs/SPEC.md sections 2, 3, 8 and 14). `app.js` calls `createEngine`
// and owns nothing else about the modules.
//
// CONSTRUCTION is not the same as START. Several modules need each other (the timeline asks the
// job manager for the active job and the job manager asks the timeline for its notes, the render
// runner counts itself in the manager's process registry and the manager starts renders), so the
// modules are built in the order that needs the fewest forward references and the few remaining
// ones are late-bound (`late`, closures over `let jobs`), never a second copy of anything.
//
// START ORDER (`modules`, each line says why it is before the next one):
//   1. storage     - uploads cleanup only; no dependency, and everything below reads its folders.
//   2. harness     - reads the saved setup; its usage schedule is harmless without the others.
//   3. claude      - model list and usage meter; needs the harness only through the settings.
//   4. limits      - writes limits.json and resumes frozen processes of a crash BEFORE any job
//                    starts (the manager also calls `resumeLeftovers`), and listens for settings.
//   5. toolkit     - installs the toolkit and starts Prepare; jobs and renders need its folder and
//                    its `prepared()`/`renderReady()` gates, which are read at launch, never cached.
//   6. library     - the first scan; the manager's recovery and the timeline look videos up in it.
//   7. maintenance - sweeps the preview tokens and copies; needs nothing from the modules above
//                    but belongs before the first timeline opens.
//   8. timeline    - rpc only (no start).
//   9. render      - `runner.sweep()` removes half-written renders; MUST run before any job runs,
//                    so it is before `jobs`.
//  10. editLog, disk - rpc only; disk has no start.
//  11. jobs        - last: its start recovers the jobs of a crash or shutdown (they need all of the
//                    above ready) and then fills the queues.
// STOP ORDER is the reverse: jobs first (they pause their agents, which still need limits, the
// toolkit and the library to write their last state), then render, timeline, library, toolkit,
// limits, claude, harness, storage; `app.js` closes the HTTP server and the database after that.
import fsp from "node:fs/promises";
import path from "node:path";
import { createClaudeModule } from "./agents/claude/index.js";
import { dataPaths } from "./config.js";
import { opencodeStatus } from "./agents/opencode/locate.js";
import { createHarnessModule } from "./agents/index.js";
import { createJobsRepo } from "./db/jobs.js";
import { createNotesRepo } from "./db/notes.js";
import { createSettingsRepo } from "./db/settings.js";
import { createVideosRepo } from "./db/videos.js";
import { createDiskModule } from "./disk/index.js";
import { createEditLog } from "./editLog.js";
import { createJobsModule } from "./jobs/index.js";
import { createLibraryModule } from "./library/index.js";
import { createLimitsModule } from "./limits/index.js";
import { createRenderModule } from "./render/index.js";
import { editLogFunctions } from "./rpc/editLog.js";
import { createEncoders } from "./platform/encoders.js";
import { createMachineProbe } from "./platform/machine.js";
import { runHelper } from "./platform/process.js";
import { findFfmpeg, findFfprobe } from "./platform/tools.js";
import { createStorageModule } from "./storage/index.js";
import { createDescribeNotes } from "./timeline/describeNotes.js";
import { createNotePictures } from "./timeline/notePictures.js";
import { createPlayerRoutes } from "./http/player.js";
import { createPreview } from "./timeline/preview.js";
import { createPreviewCopies } from "./timeline/proxy.js";
import { createTimelineModule } from "./timeline/index.js";
import { findHyperframesCli } from "./timeline/lint.js";
import { createToolkitModule } from "./toolkit/index.js";

/** Preview tokens are swept every 10 minutes, preview copies once a day. */
const TOKEN_SWEEP_MS = 10 * 60 * 1000;
const COPY_SWEEP_MS = 24 * 60 * 60 * 1000;
/** The admin setting `proxyCacheGb` is in gigabytes of 1024^3 bytes. */
const BYTES_PER_GB = 1024 ** 3;

/**
 * Test seams: a partial dependency bag per module, merged over the real wiring. Nothing here is
 * read in production (`app.js` passes it only when `AppOptions.engine` is given).
 * @typedef {object} EngineOptions
 * @property {Record<string, unknown>} [storage]
 * @property {Record<string, unknown>} [library]
 * @property {Record<string, unknown>} [harness]
 * @property {Record<string, unknown>} [claude]
 * @property {Record<string, unknown>} [limits]
 * @property {Record<string, unknown>} [toolkit]
 * @property {Record<string, unknown>} [timeline]
 * @property {Record<string, unknown>} [render]
 * @property {Record<string, unknown>} [jobs]
 * @property {Record<string, unknown>} [disk]
 * @property {Record<string, unknown>} [copies]
 * @property {Record<string, unknown>} [pictures]
 * @property {Record<string, unknown>} [preview]
 * @property {number} [tokenSweepMs]
 * @property {number} [copySweepMs]
 * @property {number} [bytesPerGb] Bytes of one `proxyCacheGb` gigabyte (tests use small numbers).
 *
 * @typedef {import("./app.js").AppContext} AppContext
 */

/**
 * A late-bound view of an object that exists only after the module that needs it: every property
 * is looked up on the target when used.
 * @template {object} T
 * @param {() => T} target
 * @returns {T}
 */
function late(target) {
  return /** @type {T} */ (
    new Proxy(
      {},
      {
        get(_, key) {
          const value = Reflect.get(target(), key);
          return typeof value === "function" ? value.bind(target()) : value;
        },
      },
    )
  );
}

/**
 * @param {AppContext} context
 * @param {EngineOptions} [options]
 * @returns {import("./app.js").AppModule[] & { api: Record<string, any>, sessionEnded: (sessionId: string) => void }} In start order.
 */
export function createEngine(context, options = {}) {
  const { db, clock, log, events, settings, secrets, paths, env, version } = context;
  const dataDir = paths.dataDir;
  const platform = process.platform;
  const programEnv = env;

  // ---- construction order (see the file comment) ----

  const jobsRepo = createJobsRepo(db, { clock });
  const videosRepo = createVideosRepo(db, { clock });
  const notesRepo = createNotesRepo(db, { clock });

  // Storage tells the library about changes with a `library-changed` of no payload: a request to
  // scan, not news for the page (the library sends the real event when the result differs).
  const storageEvents = {
    emit(/** @type {import("./events.js").BusEvent} */ event) {
      if (
        event.event === "library-changed" &&
        (event.payload === null || event.payload === undefined)
      ) {
        if (event.userId) void library.api.rescan(event.userId);
        else void library.api.rescanAll();
        return;
      }
      events.emit(event);
    },
  };

  const storage = createStorageModule({
    db,
    settings,
    events: storageEvents,
    dataDir,
    clock,
    log,
    hasActiveJobs: (channelId) =>
      jobsRepo.active().some((job) => videosRepo.byKey(job.videoKey)?.channelId === channelId),
    // The channel's video rows went with it; their folders under `<data dir>/projects/` go now.
    onChannelRemoved: () => sweepOrphansQuietly(),
    ...options.storage,
  });

  /** @type {ReturnType<typeof createHarnessModule>} */
  const harness = createHarnessModule({
    settingsRepo: createSettingsRepo(db),
    settings,
    secrets,
    events,
    clock,
    version,
    probes: {
      locateClaude: async () => (await claude.locate()) !== null,
      claudeLoggedIn: () => claude.claudeLoggedIn(),
      locateOpencode: () => opencodeStatus(programEnv),
      toolkitPrepared: async () => toolkit.api.prepared(),
    },
    claudeModels: () => claude.claudeModels(),
    detectRouting: () => claude.routing(),
    ...options.harness,
  });

  /**
   * The installed Claude Code offers other models than before: the admin's saved model and effort
   * may name something that is gone. The harness settings fix and announce the selection
   * (`settings-changed`); the admin pages also learn through `system-changed`.
   * @param {import("../../src/lib/wire/usage.ts").ClaudeInfo} info
   */
  function onClaudeModelsChange(info) {
    harness
      .recheckClaudeSelection(info)
      .then((changed) => {
        if (changed) {
          events.emit({ event: "system-changed", payload: null, userId: "", admins: true });
        }
      })
      .catch((error) => log.warn("Checking the saved Claude model failed.", error));
  }

  /** @type {ReturnType<typeof createClaudeModule>} */
  const claude = createClaudeModule({
    events,
    dataDir,
    env: programEnv,
    clock,
    log,
    setupOf: () => settings.getAll().setup,
    opencodeUsage: (refresh) => (refresh ? harness.usage.refresh() : harness.usage.usage()),
    onInfoChange: onClaudeModelsChange,
    ...options.claude,
  });

  const limits = createLimitsModule({
    settings,
    dataDir,
    clock,
    log,
    events,
    ...options.limits,
  });

  const hyperframesBin = findHyperframesCli();

  /** @type {ReturnType<typeof createToolkitModule>} */
  const toolkit = createToolkitModule({
    dataDir,
    clock,
    log,
    events,
    version,
    db,
    limits: limits.api,
    env: programEnv,
    probes: {
      claude: async () => {
        const found = await claude.locate();
        return found
          ? { found: true, path: found.path, version: found.version }
          : { found: false, note: "Claude Code is not installed on this computer." };
      },
      opencode: async () => {
        const cli = await opencodeStatus(programEnv);
        return cli.found
          ? { found: true, path: cli.path, version: cli.version }
          : { found: false, note: cli.installCommand };
      },
    },
    ensureBrowser: () => render.prepare.ensureBrowser(),
    testRender: () => render.prepare.testRender(),
    hyperframesBin,
    ...options.toolkit,
  });

  /** @type {ReturnType<typeof createLibraryModule>} */
  const library = createLibraryModule({
    db,
    channels: storage.api.channelsRepo,
    storage: storage.api,
    events,
    clock,
    log,
    env: programEnv,
    jobsFor: (keys) => jobs.api.jobsFor(keys),
    watchers: () => events.watching().userIds,
    editLog: { record: (entry) => editLog.record(entry) },
    ...options.library,
  });

  const editLog = createEditLog({
    db,
    users: context.users,
    clock,
    log,
    describeVideo: (key) => library.api.describeKey(key),
  });

  // Preview: tokens, and copies of heavy media that the preview serves instead of the originals.
  // The cache limit is the admin setting `proxyCacheGb`, read at every sweep (so it is the current
  // one at start and after each change); `glue` sweeps at once when it is lowered.
  const bytesPerGb = options.bytesPerGb ?? BYTES_PER_GB;
  const copyCacheLimit = () => settings.getAll().proxyCacheGb * bytesPerGb;
  const jobsRegistry = late(() => jobs.api.registry);
  const copies = createPreviewCopies({
    dataDir,
    limits: limits.api,
    registry: jobsRegistry,
    events,
    clock,
    log,
    ffmpeg: findFfmpeg,
    ffprobe: findFfprobe,
    maxBytes: copyCacheLimit,
    encoders: createEncoders({
      ffmpeg: findFfmpeg,
      helper: runHelper,
      platform,
      ...(env.VE_HW ? { forced: env.VE_HW } : {}),
      log,
    }),
    ...options.copies,
  });
  const preview = createPreview({
    clock,
    log,
    proxyFor: copies.proxyFor,
    ...options.preview,
  });

  /** @type {ReturnType<typeof createTimelineModule>} */
  const timeline = createTimelineModule({
    db,
    clock,
    log,
    events,
    dataDir,
    library: library.api,
    activeJob: (key) => jobs.api.activeJob(key),
    requestTimelineEdit: async (request) => {
      await jobs.api.requestTimelineEdit(request);
    },
    preview: { open: (request) => preview.open(request) },
    previewCopies: copies,
    ...(hyperframesBin ? { hyperframesBin } : {}),
    ...options.timeline,
  });

  /** @type {ReturnType<typeof createRenderModule>} */
  const render = createRenderModule({
    dataDir,
    clock,
    log,
    limits: limits.api,
    registry: jobsRegistry,
    sink: late(() => jobs.api.sink),
    library: library.api,
    timeline: timeline.api,
    activeJob: (key) => jobs.api.activeJob(key),
    enqueue: (...args) => jobs.api.enqueue(...args),
    renderReady: () => toolkit.api.renderReady(),
    ...options.render,
  });

  // One capturer for the whole server (a second one would allow two captures at a time). Built at
  // the first capture so it knows the browser Prepare found by then.
  const pictureOptions = options.pictures ?? {};
  /** @type {ReturnType<typeof createNotePictures> | null} */
  let capturer = null;
  const pictures = {
    capture: (
      /** @type {Parameters<ReturnType<typeof createNotePictures>["capture"]>[0]} */ request,
    ) => {
      capturer ??= createNotePictures({
        cli: hyperframesBin,
        ffmpeg: findFfmpeg(),
        workDir: path.join(dataDir, "cache", "snapshot"),
        browserPath: render.prepare.browserPath(),
        env: programEnv,
        log,
        ...pictureOptions,
      });
      return capturer.capture(request);
    },
    stop: async () => {
      await capturer?.stop();
    },
  };
  const describeNotes = createDescribeNotes({
    clipsAt: (key, frame) => timeline.api.clipsAt(key, frame),
    projectDir: (key) => timeline.api.projectDir(key),
    noteDir: (key, noteId) => timeline.api.noteDir(key, noteId),
    pictures: /** @type {never} */ (pictures),
    log,
  });

  const disk = createDiskModule({
    channels: storage.api.channelsRepo,
    folders: storage.api.folders,
    videos: library.api.videos,
    library: library.api,
    activeJob: (key) => jobs.api.activeJob(key) !== null,
    editLog,
    events,
    clock,
    log,
    rescanLibrary: (userId) => void library.api.rescan(userId),
    ...options.disk,
  });

  // What the manager sees of the timeline: the same, plus the cleanup of change request pictures
  // when their job ends and the preview copies after a job (the project changed).
  const takenBy = new Map();
  const timelineForJobs = {
    ...timeline.api,
    async takeNotes(/** @type {string} */ key, /** @type {string} */ jobId) {
      const taken = await timeline.api.takeNotes(key, jobId);
      takenBy.set(jobId, { key, ids: taken.map((note) => note.id) });
      return taken;
    },
    finishNotes(
      /** @type {string} */ jobId,
      /** @type {"done" | "failed"} */ state,
      /** @type {string | null} */ error = null,
    ) {
      const result = timeline.api.finishNotes(jobId, state, error);
      const taken = takenBy.get(jobId);
      takenBy.delete(jobId);
      if (taken) for (const id of taken.ids) void describeNotes.removeFor(taken.key, id);
      return result;
    },
    async videoFreed(/** @type {string} */ key) {
      await timeline.api.videoFreed(key);
      const keep = notesRepo
        .listForVideo(key)
        .filter((note) => note.state === "pending" || note.state === "running")
        .map((note) => note.id);
      await describeNotes.sweep(key, keep);
    },
    async removeVideo(/** @type {string} */ key) {
      copies.cancelFor(key);
      preview.closeVideo(key);
      await timeline.api.removeVideo(key);
    },
  };

  // The server's own folder of a video (`<data dir>/projects/<videoKey>/`) lives as long as the
  // video's row (SPEC section 6). Rows go with their channel or user (cascade); this sweep then
  // removes every folder without a row: after a channel's removal, after a user's deletion, and
  // at start for what earlier versions left. Keys are random per row, so a channel added again
  // on the same directory gets new rows and new folders, never one this sweep is deleting.
  const projectsDir = dataPaths(dataDir).projectsDir;
  /** @type {Promise<number>} */
  let sweeping = Promise.resolve(0);
  /** Removes the folders of videos that have no row; one sweep at a time. @returns {Promise<number>} */
  function sweepOrphanProjects() {
    sweeping = sweeping
      .catch(() => 0)
      .then(async () => {
        /** @type {string[]} */
        let names;
        try {
          names = await fsp.readdir(projectsDir);
        } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return 0;
          throw error;
        }
        let removed = 0;
        for (const name of names) {
          if (videosRepo.byKey(name)) continue;
          await timelineForJobs.removeVideo(name);
          removed += 1;
        }
        return removed;
      });
    return sweeping;
  }
  /** The sweep after a removal that already happened: a failure is logged, never thrown at the
   * person whose removal succeeded (the next start sweeps again). */
  async function sweepOrphansQuietly() {
    try {
      await sweepOrphanProjects();
    } catch (error) {
      log.warn("Removing the timeline folders of removed videos failed.", error);
    }
  }

  /** @type {ReturnType<typeof createJobsModule>} */
  const jobs = createJobsModule({
    db,
    dataDir,
    clock,
    log,
    events,
    settings,
    harness,
    claude,
    limits: limits.api,
    library: library.api,
    timeline: /** @type {never} */ (timelineForJobs),
    toolkit: {
      get folder() {
        return toolkit.api.paths().toolkitFolder;
      },
      get python() {
        return toolkit.api.paths().python;
      },
      env: () => toolkit.api.env(),
    },
    machine: createMachineProbe(),
    renderRunner: render.runner,
    describeNotes,
    editLog,
    isBusy: (key) => disk.api.isCleaning(key),
    ...(hyperframesBin ? { hyperframesBin } : {}),
    ...options.jobs,
  });

  // ---- glue: the modules react to each other's events ----
  /** @type {Array<() => void>} */
  const unlisten = [];
  /** @param {import("./events.js").BusEvent} event */
  const isTerminal = (event) => {
    const state = /** @type {{ state?: string } | null} */ (event.payload)?.state;
    return state === "completed" || state === "failed" || state === "stopped";
  };
  let lastRunning = false;
  /** Whether a job runs is what the usage meter's schedule wants to know. */
  function syncJobsRunning() {
    const running = jobsRepo.active().some((job) => job.state === "running");
    if (running !== lastRunning) {
      lastRunning = running;
      claude.setJobsRunning(running);
    }
  }
  const maintenance = createMaintenance({
    sweepTokens: () => preview.sweep(),
    sweepCopies: () => copies.sweep(),
    tokenMs: options.tokenSweepMs ?? TOKEN_SWEEP_MS,
    copyMs: options.copySweepMs ?? COPY_SWEEP_MS,
    log,
  });

  let lastCacheLimit = copyCacheLimit();
  /** A lower cache limit takes effect now, not at the next daily sweep (SPEC section 11 says
   * "checked at start and daily"; this is a third moment, raised in the report). */
  function syncCopyCacheLimit() {
    const limit = copyCacheLimit();
    const lowered = limit < lastCacheLimit;
    lastCacheLimit = limit;
    if (!lowered) return;
    copies.sweep().catch((error) => {
      log.warn("Sweeping the preview copies after a lower cache limit failed.", error);
    });
  }

  /** @type {import("./app.js").AppModule} */
  const glue = {
    name: "glue",
    start() {
      lastCacheLimit = copyCacheLimit();
      unlisten.push(
        events.listen((event) => {
          if (event.event === "settings-changed") {
            jobs.api.kick();
            syncCopyCacheLimit();
          }
          if (event.event === "job-updated") {
            if (isTerminal(event) && event.userId) disk.api.invalidate(event.userId);
            syncJobsRunning();
          }
          if (event.event === "queue-changed") syncJobsRunning();
        }),
        events.onWatchersChange((count) => claude.setWatchers(count)),
      );
    },
    stop() {
      for (const off of unlisten.splice(0)) off();
    },
  };

  /** Ends the preview tokens of a session that ended (`app.js` calls it, see `sessionEnds.js`). */
  const sessionEnded = (/** @type {string} */ sessionId) => preview.closeSession(sessionId);

  /** @type {import("./app.js").AppModule[]} */
  const modules = [
    glue,
    storage,
    harness,
    claude,
    limits,
    toolkit,
    library,
    {
      name: "preview",
      routes: preview.routes,
      start: () => maintenance.start(),
      stop: () => maintenance.stop(),
    },
    {
      ...timeline,
      async start() {
        const removed = await sweepOrphanProjects();
        if (removed > 0)
          log.info(`Removed ${removed} timeline folder(s) of videos that no longer exist.`);
      },
      hooks: { afterUserRemoved: () => sweepOrphansQuietly() },
    },
    {
      ...render,
      async start() {
        await render.runner.sweep();
        // Before any job starts a browser: the preference outlives a server restart, but the
        // browser may have been installed by an earlier version of VidAI.
        await render.gpuPreference.apply();
      },
    },
    { name: "player", routes: createPlayerRoutes() },
    { name: "editLog", rpc: editLogFunctions({ editLog }) },
    disk,
    {
      name: "preview-copies",
      async stop() {
        await copies.stop();
        await describeNotes.stop();
        preview.stop();
      },
    },
    jobs,
  ];
  return Object.assign(modules, {
    api: {
      storage,
      library,
      harness,
      claude,
      limits,
      toolkit,
      timeline,
      render,
      jobs,
      disk,
      copies,
      preview,
      editLog,
    },
    sessionEnded,
  });
}

/**
 * The two sweeps on timers (preview tokens often, preview copies daily; the copies once at start).
 * @param {{ sweepTokens: () => void, sweepCopies: () => Promise<unknown>, tokenMs: number, copyMs: number, log: import("./log.js").Logger }} deps
 */
function createMaintenance({ sweepTokens, sweepCopies, tokenMs, copyMs, log }) {
  /** @type {Array<ReturnType<typeof setInterval>>} */
  let timers = [];
  const copies = () =>
    sweepCopies().catch((error) => {
      log.warn("Sweeping the preview copies failed.", error);
    });
  return {
    start() {
      void copies();
      timers = [
        setInterval(() => {
          try {
            sweepTokens();
          } catch (error) {
            log.warn("Sweeping the preview addresses failed.", error);
          }
        }, tokenMs),
        setInterval(() => void copies(), copyMs),
      ];
      for (const timer of timers) timer.unref();
    },
    stop() {
      for (const timer of timers) clearInterval(timer);
      timers = [];
    },
  };
}

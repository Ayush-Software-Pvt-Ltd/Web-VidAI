// Preview copies of heavy video files (docs/SPEC.md section 11, Preview, Preview copies).
//
// The timeline screen plays the project's original media in the browser. Camera files (HEVC, 4K, a
// long key frame distance, a high bit rate) play badly there, so the server makes a lighter copy of
// each heavy file in the background and the preview route serves the copy instead. Renders always
// use the originals.
//
// `createPreviewCopies(deps)` returns:
//  - `proxyFor(realPath)`: the copy to serve instead of the original, or null (synchronous, cheap;
//    hand it to `createPreview({ proxyFor })`);
//  - `ensureFor(videoKey, projectDir, scope, { first })`: lists the project's media, probes the new
//    ones and queues the heavy ones without a copy (call it after an edit completes and whenever a
//    timeline is opened; do not wait for it, copies take minutes);
//  - `state(videoKey)`: `{ total, done, running }` for "Preparing smooth preview (1 of 3)";
//  - `cancelFor(videoKey)` when a video is removed; `sweep()`, `usage()`, `stop()`.
// A change of a video's state is published to its owner as the event `preview-copies-changed`.
import fsp from "node:fs/promises";
import path from "node:path";
import { dataPaths } from "../config.js";
import { createEncoders } from "../platform/encoders.js";
import { runHelper } from "../platform/process.js";
import { findFfmpeg, findFfprobe } from "../platform/tools.js";
import { createCopyMaker } from "./proxyRun.js";
import { isNotVideoName, heavyReasons, probeFile } from "./proxyProbe.js";
import { createCopyQueue } from "./proxyQueue.js";
import { createCopyStore } from "./proxyStore.js";
import { resolvePreviewFile } from "./previewPaths.js";

/** The event that tells a video's owner that the preview copies changed. */
export const PREVIEW_COPIES_EVENT = "preview-copies-changed";

/**
 * @typedef {import("../../../src/lib/wire/timeline.ts").PreviewCopiesState} PreviewCopiesState
 *
 * @typedef {object} CopyScope Where a video's files may be and whom to tell.
 * @property {string} videoDir
 * @property {string} channelDir
 * @property {string} videoId `<channelId>/<folder name>` (the event's `videoId`).
 * @property {string} userId The owner, who gets the events.
 *
 * @typedef {object} PreviewCopiesDeps
 * @property {string} dataDir
 * @property {Pick<ReturnType<typeof import("../limits/index.js").createLimitsModule>["api"], "envFor" | "jobStarted" | "jobEnded" | "acquireGpuSlot">} limits
 * @property {{ add(entry: { jobId: string, pid: number }): Promise<void>, remove(pid: number): Promise<void> }} registry
 * @property {{ emit(event: { event: string, payload: unknown, userId: string | null, admins: boolean }): void }} events
 * @property {import("../db/open.js").Clock} clock
 * @property {import("../limits/timers.js").Timers} [timers]
 * @property {import("../log.js").Logger} log
 * @property {() => string | null} [ffmpeg] Default: `findFfmpeg()`.
 * @property {() => string | null} [ffprobe] Default: `findFfprobe()`.
 * @property {ReturnType<typeof createEncoders>} [encoders] Default: probes this computer's ffmpeg.
 * @property {(options: { command: string, args: readonly string[], timeoutMs: number }) => Promise<import("../platform/process.js").HelperResult>} [helper]
 *   Runs ffprobe (default: `runHelper`).
 * @property {import("./proxyRun.js").StartCopy} [run] Starts ffmpeg for a copy (default: a real process).
 * @property {() => number | null} [maxBytes] The cache size cap in bytes (`proxyCacheGb`); null: none.
 * @property {number} [gpuWaitMs]
 * @property {number} [statTtlMs]
 */

/** @param {PreviewCopiesState} a @param {PreviewCopiesState} b */
const sameState = (a, b) => a.total === b.total && a.done === b.done && a.running === b.running;

/** @type {PreviewCopiesState} */
const NOTHING = Object.freeze({ total: 0, done: 0, running: false });

/**
 * @param {PreviewCopiesDeps} deps
 */
export function createPreviewCopies(deps) {
  const { clock, events, log } = deps;
  const findProgram = deps.ffmpeg ?? (() => findFfmpeg());
  const findProbe = deps.ffprobe ?? (() => findFfprobe());
  const helper = deps.helper ?? runHelper;
  const encoders =
    deps.encoders ??
    createEncoders({
      ffmpeg: findProgram,
      helper,
      platform: process.platform,
      ...(process.env["VE_HW"] === undefined ? {} : { forced: process.env["VE_HW"] }),
      log,
    });
  const store = createCopyStore({
    dir: dataPaths(deps.dataDir).proxyCacheDir,
    clock,
    log,
    ...(deps.maxBytes ? { maxBytes: deps.maxBytes } : {}),
    ...(deps.statTtlMs === undefined ? {} : { statTtlMs: deps.statTtlMs }),
  });

  /** What each video needs: its heavy files and whom to tell. @type {Map<string, { files: Map<string, { name: string, realPath: string }>, scope: CopyScope }>} */
  const videos = new Map();
  /** The last state published per video. @type {Map<string, PreviewCopiesState>} */
  const published = new Map();
  /** Bumped by `cancelFor`, so an `ensureFor` that was running stops. @type {Map<string, number>} */
  const generations = new Map();
  /** One `ensureFor` at a time per video. @type {Map<string, Promise<unknown>>} */
  const chains = new Map();
  /** What was found about files this run. @type {Map<string, import("./proxyStore.js").FactsRecord>} */
  const records = new Map();
  /** ffprobe calls one after the other. @type {Promise<unknown>} */
  let probing = Promise.resolve();
  let warnedNoProbe = false;

  const queue = createCopyQueue({
    log,
    run: createCopyMaker({
      store,
      limits: deps.limits,
      registry: deps.registry,
      ffmpeg: findProgram,
      encoders,
      ...(deps.run ? { run: deps.run } : {}),
      ...(deps.timers ? { timers: deps.timers } : {}),
      ...(deps.gpuWaitMs === undefined ? {} : { gpuWaitMs: deps.gpuWaitMs }),
      log,
    }),
    onChange: () => {
      for (const videoKey of videos.keys()) publish(videoKey);
    },
  });

  /** @param {string} videoKey @returns {PreviewCopiesState} */
  function state(videoKey) {
    const video = videos.get(videoKey);
    if (!video) return NOTHING;
    let total = 0;
    let done = 0;
    let running = false;
    for (const { name } of video.files.values()) {
      // A copy that failed is not waited for: its original is served.
      if (queue.hasFailed(name) && !store.has(name)) continue;
      total += 1;
      if (store.has(name)) done += 1;
      else if (queue.isRunning(name)) running = true;
    }
    return { total, done, running };
  }

  /** Tells the owner when the state differs from the one told last. @param {string} videoKey */
  function publish(videoKey) {
    const video = videos.get(videoKey);
    if (!video) return;
    const now = state(videoKey);
    if (sameState(published.get(videoKey) ?? NOTHING, now)) return;
    published.set(videoKey, now);
    events.emit({
      event: PREVIEW_COPIES_EVENT,
      payload: { videoId: video.scope.videoId, copies: now },
      userId: video.scope.userId,
      admins: false,
    });
  }

  /**
   * What is known about a file: from memory, from the disk, else probed now.
   * @param {{ name: string, size: number, mtimeMs: number }} id
   * @param {string} realPath
   * @returns {Promise<import("./proxyStore.js").FactsRecord | null>} null: cannot be probed now.
   */
  async function recordOf(id, realPath) {
    const known = records.get(id.name) ?? (await store.readFacts(id.name));
    if (known && known.realPath === realPath) {
      records.set(id.name, known);
      return known;
    }
    const command = findProbe();
    if (command === null) {
      if (!warnedNoProbe) log.warn("preview copies: ffprobe was not found, so none are made");
      warnedNoProbe = true;
      return null;
    }
    const probe = probing.then(() => probeFile({ command, file: realPath, helper }));
    probing = probe.catch(() => {});
    try {
      const facts = await probe;
      /** @type {import("./proxyStore.js").FactsRecord} */
      const record = {
        realPath,
        size: id.size,
        mtimeMs: id.mtimeMs,
        facts,
        reasons: facts ? heavyReasons(facts) : [],
      };
      await store.writeFacts(id.name, record).catch((error) => {
        log.warn("preview copies: what ffprobe found could not be saved", error);
      });
      if (records.size > 20_000) records.clear();
      records.set(id.name, record);
      return record;
    } catch (error) {
      log.warn(`preview copies: ${realPath} could not be probed`, error);
      return null;
    }
  }

  /**
   * The real files of a project's `assets/media` that a preview may reach.
   * @param {string} projectDir
   * @param {CopyScope} scope
   * @returns {Promise<string[]>}
   */
  async function mediaOf(projectDir, scope) {
    /** @type {string[]} */
    let names;
    try {
      names = await fsp.readdir(path.join(projectDir, "assets", "media"));
    } catch {
      return [];
    }
    /** @type {Set<string>} */
    const found = new Set();
    for (const name of names.sort()) {
      if (name.startsWith(".") || isNotVideoName(name)) continue;
      const real = await resolvePreviewFile(["assets", "media", name], {
        projectDir,
        videoDir: scope.videoDir,
        channelDir: scope.channelDir,
      });
      if (real !== null) found.add(real);
    }
    return [...found];
  }

  /**
   * @param {string} videoKey
   * @param {string} projectDir
   * @param {CopyScope} scope
   * @param {boolean} first
   * @returns {Promise<PreviewCopiesState>}
   */
  async function ensure(videoKey, projectDir, scope, first) {
    const generation = generations.get(videoKey) ?? 0;
    const cancelled = () => (generations.get(videoKey) ?? 0) !== generation;
    /** @type {Map<string, { name: string, realPath: string }>} */
    const files = new Map();
    /** @type {{ name: string, realPath: string, facts: import("./proxyProbe.js").MediaFacts }[]} */
    const items = [];
    for (const realPath of await mediaOf(projectDir, scope)) {
      if (cancelled()) return NOTHING;
      const id = await store.identify(realPath);
      if (id === null) continue;
      const record = await recordOf(id, realPath);
      if (record?.facts && record.reasons.length > 0) {
        files.set(id.name, { name: id.name, realPath });
        items.push({ name: id.name, realPath, facts: record.facts });
      }
    }
    if (cancelled()) return NOTHING;
    videos.set(videoKey, { files, scope });
    for (const item of items) {
      if (!store.has(item.name)) queue.want(item, videoKey, { first });
    }
    publish(videoKey);
    return state(videoKey);
  }

  return {
    proxyFor: (/** @type {string} */ realPath) => store.proxyFor(realPath),

    /**
     * Lists the project's media, probes the ones not known yet and queues the heavy ones that have
     * no copy. Resolves with the state once that is done (not once the copies are).
     * @param {string} videoKey
     * @param {string} projectDir
     * @param {CopyScope} scope
     * @param {{ first?: boolean }} [options] `first`: the user has this video open, so its copies go
     *   ahead of those already waiting.
     * @returns {Promise<PreviewCopiesState>}
     */
    ensureFor(videoKey, projectDir, scope, { first = false } = {}) {
      const run = (chains.get(videoKey) ?? Promise.resolve())
        .catch(() => {})
        .then(() => ensure(videoKey, projectDir, scope, first));
      const settled = run.catch(() => NOTHING);
      chains.set(videoKey, settled);
      void settled.then(() => {
        if (chains.get(videoKey) === settled) chains.delete(videoKey);
      });
      return run.catch((error) => {
        log.warn("preview copies: a project's media could not be listed", error);
        return state(videoKey);
      });
    },

    /** @param {string} videoKey @returns {PreviewCopiesState} */
    state,

    /**
     * A video was removed: its queued copies are dropped (a running one ends when no other video
     * wants it) and nothing more is published for it.
     * @param {string} videoKey
     */
    cancelFor(videoKey) {
      generations.set(videoKey, (generations.get(videoKey) ?? 0) + 1);
      videos.delete(videoKey);
      published.delete(videoKey);
      queue.cancelVideo(videoKey);
    },

    /** Deletes old, orphaned and surplus copies. @returns {Promise<{ deleted: number, freedBytes: number }>} */
    sweep: () => store.sweep(),

    /** What the copies take, for the System page. @returns {Promise<{ files: number, bytes: number }>} */
    usage: () => store.usage(),

    /** Waits until nothing is queued or running (tests, a clean shutdown of a script). @returns {Promise<void>} */
    idle: () => queue.idle(),

    /** Ends the running ffmpeg and forgets the queue; resolves when it is over. @returns {Promise<void>} */
    stop: () => queue.stop(),
  };
}

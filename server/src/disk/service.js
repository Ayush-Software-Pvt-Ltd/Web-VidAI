// The Disk Cleanup service (docs/SPEC.md section 13): the sizes of a user's videos, measured in the
// background and cached per folder, and deleting the working files of one video.
//
// How `getDiskUse` answers: it lists the user's videos (every channel, archived ones included),
// returns at once what the cache knows, and queues every video whose cache entry is missing or not
// checked for `verifyAfterMs`. One background task at a time (a task is one fingerprint, then, only
// when the folder changed, one measurement) so the disk is never loaded; between tasks the
// injected scheduler decides when the next one runs. After a task the page is told with the event
// `disk-use-changed` (payload: the whole `DiskUse`, like `library-changed` carries the library),
// at most once per `eventIntervalMs` and always after the last task of a user.

import path from "node:path";
import { conflict } from "../errors.js";
import { scanChannelDirectory } from "../library/scan.js";
import { createSizeCache } from "./cache.js";
import { checkedWorkingFolder, emptyFolder } from "./clean.js";
import { formatBytes } from "./format.js";
import { fingerprintVideoFolder, measureVideoFolder } from "./measure.js";

/** @typedef {import("../../../src/lib/wire/disk.ts").DiskUse} DiskUse */
/** @typedef {import("../../../src/lib/wire/disk.ts").DiskSizes} DiskSizes */
/** @typedef {import("../../../src/lib/wire/disk.ts").DiskVideo} DiskVideo */
/** @typedef {import("../../../src/lib/wire/disk.ts").CleanResult} CleanResult */

/** The name of the event the page listens to. */
export const DISK_EVENT = "disk-use-changed";

/**
 * Runs the background tasks one after the other; injected so tests decide when.
 * @typedef {object} Scheduler
 * @property {(task: () => void | Promise<void>) => () => void} later Runs `task` soon, once;
 *   returns what cancels it.
 */

/** @type {Scheduler} */
export const realScheduler = {
  later(task) {
    const handle = setImmediate(task);
    return () => clearImmediate(handle);
  },
};

/**
 * The file system work, replaceable in tests.
 * @typedef {object} DiskOps
 * @property {(dir: string, folderName: string, signal: AbortSignal) => Promise<DiskSizes | null>} measure
 * @property {(dir: string, signal: AbortSignal) => Promise<string | null>} fingerprint
 */

/** @type {DiskOps} */
const realOps = { measure: measureVideoFolder, fingerprint: fingerprintVideoFolder };

/**
 * @typedef {object} Listed
 * @property {string} videoId
 * @property {string} channelId
 * @property {string} channelName
 * @property {string} folderName
 * @property {boolean} archived
 * @property {string} dir Real path of the video folder.
 */

/** @returns {DiskSizes} */
const noSizes = () => ({ working: 0, project: 0, finals: 0, sources: 0, total: 0 });

/**
 * @typedef {object} DiskServiceDeps
 * @property {import("../db/channels.js").ChannelsRepo} channels
 * @property {import("../storage/videoFolder.js").VideoFolders} folders
 * @property {{ listArchived(channelIds: readonly string[]): { channelId: string, folderName: string }[] }} videos
 * @property {{ videoByWireId(userId: string, videoId: unknown): Promise<{ key: string, dir: string, folderName: string, channel: { name: string } }> }} library
 * @property {(videoKey: string) => boolean} activeJob Whether the video has a job that is queued,
 *   running or paused.
 * @property {{ record(entry: { userId: string | null, videoKey?: string | null, videoLabel?: string | null, event: string, message: string }): unknown }} editLog
 * @property {{ emit(event: { event: string, payload: unknown, userId: string | null, admins: boolean }): void }} events
 * @property {import("../db/open.js").Clock} clock
 * @property {import("../log.js").Logger} log
 * @property {(userId: string) => void} [rescanLibrary] Told after a cleanup so the library drops
 *   the "Disk Cleanup" action (`library.api.rescan`).
 * @property {Scheduler} [scheduler]
 * @property {DiskOps} [ops]
 * @property {number} [verifyAfterMs] Default 30 seconds.
 * @property {number} [maxAgeMs] Default 10 minutes.
 * @property {number} [eventIntervalMs] Default 500.
 */

/**
 * @param {DiskServiceDeps} deps
 */
export function createDiskService({
  channels,
  folders,
  videos,
  library,
  activeJob,
  editLog,
  events,
  clock,
  log,
  rescanLibrary = () => {},
  scheduler = realScheduler,
  ops = realOps,
  verifyAfterMs = 30_000,
  maxAgeMs = 600_000,
  eventIntervalMs = 500,
}) {
  const cache = createSizeCache();
  /** @type {Map<string, { dir: string, folderName: string, userId: string, dirty: boolean }>} */
  const pending = new Map();
  /** @type {string[]} */
  const order = [];
  /** @type {Map<string, Listed[]>} */
  const listings = new Map();
  /** @type {Map<string, number>} */
  const lastEmit = new Map();
  /** Video keys being cleaned right now. @type {Set<string>} */
  const cleaning = new Set();
  /** @type {(() => void) | null} */
  let cancelScheduled = null;
  /** @type {AbortController | null} */
  let abort = null;
  let running = false;
  /** @type {string | null} */
  let runningDir = null;
  let stopped = false;

  /**
   * Every video of the user, in channel order and newest folder first, with its real path.
   * @param {string} userId
   * @returns {Promise<Listed[]>}
   */
  async function list(userId) {
    const userChannels = channels.listForUser(userId);
    const archived = new Set(
      videos
        .listArchived(userChannels.map((channel) => channel.id))
        .map((row) => `${row.channelId}/${row.folderName}`),
    );
    /** @type {Listed[]} */
    const result = [];
    for (const channel of userChannels) {
      /** @type {string} */
      let channelDir;
      try {
        ({ dir: channelDir } = await folders.channelDir(userId, channel.id));
      } catch {
        continue;
      }
      const scan = await scanChannelDirectory(channelDir, { skip: () => true });
      for (const folderName of scan.folderNames) {
        const videoId = `${channel.id}/${folderName}`;
        result.push({
          videoId,
          channelId: channel.id,
          channelName: channel.name,
          folderName,
          archived: archived.has(videoId),
          dir: path.join(channelDir, folderName),
        });
      }
    }
    return result;
  }

  /** @param {string} userId @returns {DiskUse} */
  function build(userId) {
    const listed = listings.get(userId) ?? [];
    const totals = noSizes();
    /** @type {DiskVideo[]} */
    const result = listed.map((item) => {
      const entry = cache.get(item.dir);
      if (entry) {
        totals.working += entry.sizes.working;
        totals.project += entry.sizes.project;
        totals.finals += entry.sizes.finals;
        totals.sources += entry.sizes.sources;
      }
      return {
        videoId: item.videoId,
        channelId: item.channelId,
        channelName: item.channelName,
        folderName: item.folderName,
        archived: item.archived,
        sizes: entry ? { ...entry.sizes } : null,
        measuring: pending.has(item.dir),
        measuredAt: entry ? entry.measuredAt : null,
      };
    });
    totals.total = totals.working + totals.project + totals.finals + totals.sources;
    return { videos: result, totals, measuring: result.some((video) => video.measuring) };
  }

  /** @param {string} userId @param {boolean} force */
  function emit(userId, force) {
    if (!listings.has(userId)) return;
    const now = clock.now();
    if (!force && now - (lastEmit.get(userId) ?? Number.NEGATIVE_INFINITY) < eventIntervalMs)
      return;
    lastEmit.set(userId, now);
    events.emit({ event: DISK_EVENT, payload: build(userId), userId, admins: false });
  }

  /** @param {string} userId */
  const hasPending = (userId) => [...pending.values()].some((task) => task.userId === userId);

  function pump() {
    if (stopped || running || cancelScheduled || order.length === 0) return;
    cancelScheduled = scheduler.later(runOne);
  }

  /** @param {Listed} item @param {string} userId */
  function enqueue(item, userId) {
    if (stopped || pending.has(item.dir)) return;
    pending.set(item.dir, { dir: item.dir, folderName: item.folderName, userId, dirty: false });
    order.push(item.dir);
  }

  async function runOne() {
    cancelScheduled = null;
    if (stopped) return;
    const dir = order.shift();
    const task = dir === undefined ? undefined : pending.get(dir);
    if (dir === undefined || !task) {
      pump();
      return;
    }
    running = true;
    runningDir = dir;
    const control = new AbortController();
    abort = control;
    let finished = false;
    // Disk Cleanup changed the folder while it was being looked at: what was read is out of date.
    let again = false;
    try {
      const fingerprint = await ops.fingerprint(dir, control.signal);
      if (fingerprint !== null) {
        const entry = cache.get(dir);
        if (
          entry &&
          entry.fingerprint === fingerprint &&
          clock.now() - entry.measuredAt < maxAgeMs
        ) {
          entry.checkedAt = clock.now();
          finished = true;
        } else {
          const sizes = await ops.measure(dir, task.folderName, control.signal);
          if (sizes !== null) {
            const now = clock.now();
            if (!task.dirty)
              cache.set(dir, { fingerprint, sizes, measuredAt: now, checkedAt: now });
            finished = true;
          }
        }
        again = task.dirty;
      }
    } catch (error) {
      // The numbers stay as they were; the next look at the page tries again.
      log.warn(`Disk Cleanup: could not measure ${task.folderName}.`, error);
      finished = true;
    } finally {
      pending.delete(dir);
      running = false;
      runningDir = null;
      abort = null;
    }
    if (again && !stopped) {
      pending.set(dir, { dir, folderName: task.folderName, userId: task.userId, dirty: false });
      order.push(dir);
    }
    if (stopped || !finished) return;
    emit(task.userId, !hasPending(task.userId));
    pump();
  }

  const service = {
    /**
     * The user's videos with what is known about their sizes; queues the rest.
     * @param {string} userId
     * @returns {Promise<DiskUse>}
     */
    async getDiskUse(userId) {
      const listed = await list(userId);
      if (stopped) return { videos: [], totals: noSizes(), measuring: false };
      listings.set(userId, listed);
      const now = clock.now();
      for (const item of listed) {
        const entry = cache.get(item.dir);
        if (!entry || now - entry.checkedAt >= verifyAfterMs) enqueue(item, userId);
      }
      pump();
      return build(userId);
    },

    /**
     * Deletes everything inside `<video>/CLAUDE_VE/` (SPEC section 13).
     * @param {{ id: string, role: "admin" | "user" }} user The signed-in user; an admin may clean
     *   any user's video, anybody else only their own.
     * @param {unknown} videoId
     * @returns {Promise<CleanResult>}
     * @throws {import("../errors.js").AppError} `notFound` for a video that is not the user's,
     *   `conflict` for an active job, a link, a missing or misplaced working folder.
     */
    async cleanWorkingFiles(user, videoId) {
      const ownerId = ownerOf(user, videoId);
      const found = await library.videoByWireId(ownerId, videoId);
      if (activeJob(found.key)) {
        throw conflict(
          "This video has a job that has not finished. Stop it or wait until it ends, then try again.",
        );
      }
      if (cleaning.has(found.key)) {
        throw conflict("The working files of this video are already being deleted.");
      }
      cleaning.add(found.key);
      /** @type {CleanResult} */
      let result;
      try {
        const working = await checkedWorkingFolder(found.dir);
        // Checked again right before deleting: the checks above waited for the disk.
        if (activeJob(found.key)) {
          throw conflict(
            "This video has a job that has not finished. Stop it or wait until it ends, then try again.",
          );
        }
        result = await emptyFolder(working);
      } finally {
        cleaning.delete(found.key);
      }
      cache.delete(found.dir);
      const byAdmin = ownerId !== user.id ? " (by an admin)" : "";
      const rest =
        result.leftover > 0
          ? ` (${result.leftover} ${result.leftover === 1 ? "item" : "items"} could not be removed)`
          : "";
      // The line belongs to the video's owner, who reads their own log; it says who did it.
      editLog.record({
        userId: ownerId,
        videoKey: found.key,
        videoLabel: `${found.channel.name} / ${found.folderName}`,
        event: "diskCleanup",
        message: `Disk Cleanup freed ${formatBytes(result.freedBytes)}${rest}${byAdmin}`,
      });
      const listed = listings.get(ownerId)?.find((item) => item.dir === found.dir);
      if (listed) {
        const inProgress = pending.get(found.dir);
        if (inProgress && runningDir === found.dir) inProgress.dirty = true;
        else enqueue(listed, ownerId);
        pump();
        emit(ownerId, true);
      }
      try {
        rescanLibrary(ownerId);
      } catch (error) {
        log.warn("Disk Cleanup: the library could not be told.", error);
      }
      return result;
    },

    /**
     * Makes the user's cached sizes be checked at the next look (a job ended, files changed).
     * @param {string} userId
     */
    invalidate(userId) {
      for (const item of listings.get(userId) ?? []) cache.stale(item.dir);
    },

    /** Forgets what is kept for a removed user. @param {string} userId */
    forgetUser(userId) {
      listings.delete(userId);
      lastEmit.delete(userId);
      for (const [dir, task] of pending) {
        if (task.userId !== userId) continue;
        pending.delete(dir);
        const index = order.indexOf(dir);
        if (index >= 0) order.splice(index, 1);
      }
    },

    /** Whether a video's working files are being deleted now. @param {string} videoKey */
    isCleaning: (videoKey) => cleaning.has(videoKey),

    /** Cancels the measuring in progress and everything queued; later calls only list. */
    stop() {
      stopped = true;
      abort?.abort();
      cancelScheduled?.();
      cancelScheduled = null;
      pending.clear();
      order.length = 0;
    },

    /** For tests: how many folders wait or are being measured. */
    pendingCount: () => pending.size,
  };

  /**
   * Whose video it is: the signed-in user's own, or for an admin the owner of the channel.
   * @param {{ id: string, role: "admin" | "user" }} user
   * @param {unknown} videoId
   */
  function ownerOf(user, videoId) {
    if (user.role !== "admin") return user.id;
    const { channelId } = folders.parseVideoId(videoId);
    return channels.byId(channelId)?.userId ?? user.id;
  }

  return service;
}

/** @typedef {ReturnType<typeof createDiskService>} DiskService */

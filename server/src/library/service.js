// The library of one user (docs/SPEC.md sections 6, 8 and 14): the scanner's result for every
// channel, joined with what the database remembers (type override, archive), the latest job of
// each video and the uploads in progress, shaped as the `Library` of `src/lib/wire/library.ts`.
//
// Rescans: `rescan(userId)` after job events, uploads and channel changes, and a timer every 5
// seconds for users with an open event stream. `library-changed` goes only to the owner and only
// when the result differs from what the owner was last sent. Rescans of one user never overlap:
// a request that arrives meanwhile makes the running one go round again once (coalescing).

import { conflict, notFound } from "../errors.js";
import { isActiveState, computeActions } from "./actions.js";
import { mapLimit } from "./mapLimit.js";
import { resolveVideoType } from "./media.js";
import { scanChannelDirectory, scanVideoFolder } from "./scan.js";

/** @typedef {import("../../../src/lib/wire/library.ts").Library} Library */
/** @typedef {import("../../../src/lib/wire/library.ts").VideoView} VideoView */
/** @typedef {import("../../../src/lib/wire/library.ts").ArchivedVideo} ArchivedVideo */
/** @typedef {import("../../../src/lib/wire/channels.ts").VideoType} VideoType */
/** @typedef {import("../../../src/lib/wire/jobs.ts").JobView} JobView */
/** @typedef {import("../db/channels.js").ChannelRecord} ChannelRecord */
/** @typedef {import("../db/videos.js").VideoRecord} VideoRecord */
/** @typedef {"admin" | "user"} Role */

/** How often users with an open event stream are scanned again (SPEC section 6). */
export const RESCAN_INTERVAL_MS = 5000;

/**
 * @typedef {object} Timers
 * @property {(fn: () => void, ms: number) => unknown} setInterval
 * @property {(handle: unknown) => void} clearInterval
 */

/** @type {Timers} */
export const realTimers = {
  setInterval(fn, ms) {
    const handle = setInterval(fn, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(/** @type {NodeJS.Timeout} */ (handle)),
};

/**
 * @typedef {object} LibraryServiceDeps
 * @property {import("../db/videos.js").VideosRepo} videos
 * @property {import("../db/channels.js").ChannelsRepo} channels
 * @property {import("../storage/videoFolder.js").VideoFolders} folders
 * @property {import("./media.js").Media} media
 * @property {(channelId: string, folderName: string) => boolean | number} uploadsInProgress
 * @property {(videoKeys: string[]) => Map<string, JobView>} jobsFor The latest job of each video.
 * @property {(userId: string) => Role | null} roleOf `null` for an account that is gone.
 * @property {{ emit(event: { event: string, payload: unknown, userId: string | null, admins: boolean }): void }} events
 * @property {import("../db/open.js").Clock} clock
 * @property {import("../log.js").Logger} log
 * @property {() => string[]} watchers User ids with an open event stream.
 * @property {Timers} timers
 * @property {number} intervalMs
 * @property {number} concurrency Channels and videos scanned at once.
 * @property {{ record(entry: { userId: string, videoKey: string, event: "archived" | "unarchived", message: string }): unknown } | null} [editLog]
 *   Archive and unarchive are written to the edit log (SPEC section 16); default: not logged.
 */

/**
 * @param {LibraryServiceDeps} deps
 */
export function createLibraryService({
  videos,
  channels,
  folders,
  media,
  uploadsInProgress,
  jobsFor,
  roleOf,
  events,
  clock,
  log,
  watchers,
  timers,
  intervalMs,
  concurrency,
  editLog = null,
}) {
  /** What each user was last sent (as JSON), to emit only real changes. */
  /** @type {Map<string, string>} */
  const lastSent = new Map();
  /** @type {Map<string, { again: boolean, done: Promise<void> }>} */
  const running = new Map();
  /** @type {unknown} */
  let timer = null;

  const missingVideo = () => notFound("That video was not found.");

  /**
   * @param {ChannelRecord} channel
   * @param {Map<string, VideoRecord>} rows The rows of this channel by folder name.
   * @param {Map<string, JobView>} jobs
   * @param {string} userId
   * @param {Role} role
   * @returns {Promise<import("../../../src/lib/wire/library.ts").ChannelLibrary>}
   */
  async function buildChannel(channel, rows, jobs, userId, role) {
    const unavailable = { channelId: channel.id, available: false, videos: [] };
    /** @type {string} */
    let dir;
    try {
      ({ dir } = await folders.channelDir(userId, channel.id));
    } catch {
      return unavailable;
    }
    const scan = await scanChannelDirectory(dir, {
      concurrency,
      skip: (name) => (rows.get(name)?.archivedAt ?? null) !== null,
    });
    // A directory that cannot be read says nothing about its videos: never prune from it.
    if (!scan.available) return unavailable;

    // An archived video whose folder is gone leaves the archive, but only while the channel
    // directory itself can be read (an unplugged drive removes nothing).
    const present = new Set(scan.folderNames);
    for (const row of rows.values()) {
      if (row.archivedAt !== null && !present.has(row.folderName))
        videos.setArchived(row.key, null);
    }

    const views = await mapLimit(scan.videos, concurrency, async (scanned) => {
      const row = rows.get(scanned.folderName);
      const detectedType = scanned.mainAroll ? await media.detectType(scanned.mainAroll) : null;
      return viewOf(channel, scanned, row, detectedType, jobs, role);
    });
    return { channelId: channel.id, available: true, videos: views };
  }

  /**
   * @param {ChannelRecord} channel
   * @param {import("./scan.js").ScannedVideo} scanned
   * @param {VideoRecord | undefined} row
   * @param {VideoType | null} detectedType
   * @param {Map<string, JobView>} jobs
   * @param {Role} role
   * @returns {VideoView}
   */
  function viewOf(channel, scanned, row, detectedType, jobs, role) {
    const job = (row && jobs.get(row.key)) ?? null;
    const typeOverride = row?.typeOverride ?? null;
    const { videoType, typeSource } = resolveVideoType(
      typeOverride,
      channel.videoType,
      detectedType,
    );
    const uploading = Boolean(uploadsInProgress(channel.id, scanned.folderName));
    const edited = scanned.output.project !== null;
    return {
      id: `${channel.id}/${scanned.folderName}`,
      channelId: channel.id,
      folderName: scanned.folderName,
      createdAt: scanned.createdAt,
      detectedType,
      typeOverride,
      channelType: channel.videoType,
      videoType,
      typeSource,
      arollCount: scanned.arollFiles.length,
      output: scanned.output,
      edited,
      finalRendered: scanned.output.finals.length > 0,
      uploading,
      job,
      actions: computeActions({
        job: job ? { state: job.state, startsAt: job.startsAt } : null,
        edited,
        uploading,
        workingFiles: scanned.workingFiles,
        admin: role === "admin",
      }),
    };
  }

  /**
   * Rows by channel and folder name, for the user's channels.
   * @param {ChannelRecord[]} userChannels
   * @returns {Map<string, Map<string, VideoRecord>>}
   */
  function rowsByChannel(userChannels) {
    /** @type {Map<string, Map<string, VideoRecord>>} */
    const byChannel = new Map(userChannels.map((channel) => [channel.id, new Map()]));
    for (const row of videos.listForChannels(userChannels.map((channel) => channel.id))) {
      byChannel.get(row.channelId)?.set(row.folderName, row);
    }
    return byChannel;
  }

  /**
   * @param {string} userId
   * @param {Role} role
   * @returns {Promise<Library>}
   */
  async function buildLibrary(userId, role) {
    const userChannels = channels.listForUser(userId);
    const byChannel = rowsByChannel(userChannels);
    const keys = [...byChannel.values()].flatMap((rows) =>
      [...rows.values()].map((row) => row.key),
    );
    const jobs = keys.length > 0 ? jobsFor(keys) : new Map();
    const result = await mapLimit(userChannels, concurrency, (channel) =>
      buildChannel(channel, byChannel.get(channel.id) ?? new Map(), jobs, userId, role),
    );
    return { channels: result };
  }

  /**
   * Sends `library-changed` to the owner when the library differs from what they were last sent.
   * @param {string} userId
   * @param {Library} library
   * @returns {boolean} Whether an event went out.
   */
  function publish(userId, library) {
    const text = JSON.stringify(library);
    if (lastSent.get(userId) === text) return false;
    lastSent.set(userId, text);
    events.emit({ event: "library-changed", payload: library, userId, admins: false });
    return true;
  }

  /**
   * One scan of a user, published.
   * @param {string} userId
   */
  async function scanAndPublish(userId) {
    const role = roleOf(userId);
    if (role === null) {
      lastSent.delete(userId);
      return;
    }
    try {
      publish(userId, await buildLibrary(userId, role));
    } catch (error) {
      log.warn(`The library of user ${userId} could not be scanned.`, error);
    }
  }

  /**
   * @param {string} userId
   * @param {{ skipIfBusy?: boolean }} [options] `skipIfBusy`: the timer does not queue a second
   *   scan behind a slow one.
   * @returns {Promise<void>}
   */
  function rescan(userId, { skipIfBusy = false } = {}) {
    const current = running.get(userId);
    if (current) {
      if (!skipIfBusy) current.again = true;
      return current.done;
    }
    const state = { again: false, done: Promise.resolve() };
    state.done = (async () => {
      try {
        do {
          state.again = false;
          await scanAndPublish(userId);
        } while (state.again);
      } finally {
        running.delete(userId);
      }
    })();
    running.set(userId, state);
    return state.done;
  }

  /**
   * The folder of a video of this user, checked to exist.
   * @param {string} userId
   * @param {unknown} videoId
   */
  function resolve(userId, videoId) {
    return folders.resolveVideo(userId, videoId);
  }

  /** @param {string} userId @returns {Role} */
  function roleOrThrow(userId) {
    const role = roleOf(userId);
    if (role === null) throw missingVideo();
    return role;
  }

  const service = {
    /**
     * The user's library, scanned now.
     * @param {string} userId
     * @param {Role} role
     * @returns {Promise<Library>}
     */
    async getLibrary(userId, role) {
      const library = await buildLibrary(userId, role);
      // Other open pages learn of what this scan found; this page gets it in the answer.
      publish(userId, library);
      return library;
    },

    rescan,

    /** Scans every user that has channels. @returns {Promise<void>} */
    async rescanAll() {
      const users = [...new Set(channels.listAll().map((channel) => channel.userId))];
      await mapLimit(users, 2, (userId) => rescan(userId));
    },

    /** Forgets what a user was sent (account removed). @param {string} userId */
    forgetUser(userId) {
      lastSent.delete(userId);
    },

    /** Starts the 5 second timer for users with an open event stream. */
    start() {
      if (timer !== null) return;
      timer = timers.setInterval(() => {
        for (const userId of watchers()) void rescan(userId, { skipIfBusy: true });
      }, intervalMs);
    },

    /** Stops the timer. */
    stop() {
      if (timer === null) return;
      timers.clearInterval(timer);
      timer = null;
    },

    /**
     * One of the user's videos as the page shows it.
     * @param {string} userId
     * @param {Role} role
     * @param {unknown} videoId
     * @returns {Promise<VideoView>}
     */
    async videoView(userId, role, videoId) {
      const { channel, folderName, dir, channelDir } = await resolve(userId, videoId);
      const scanned = await scanVideoFolder(dir, folderName, channelDir);
      if (!scanned) throw missingVideo();
      const row = videos.find(channel.id, folderName);
      const detectedType = scanned.mainAroll ? await media.detectType(scanned.mainAroll) : null;
      const jobs = row ? jobsFor([row.key]) : new Map();
      return viewOf(channel, scanned, row, detectedType, jobs, role);
    },

    /**
     * Sets or clears the video's own Long or Short choice. Jobs that exist keep their type.
     * @param {string} userId
     * @param {Role} role
     * @param {unknown} videoId
     * @param {VideoType | null} type
     * @returns {Promise<VideoView>}
     */
    async setTypeOverride(userId, role, videoId, type) {
      const { channel, folderName } = await resolve(userId, videoId);
      const existing = videos.find(channel.id, folderName);
      if (existing || type !== null) {
        videos.setTypeOverride(videos.ensure(channel.id, folderName).key, type);
      }
      await rescan(userId);
      return service.videoView(userId, role, videoId);
    },

    /**
     * What was remembered for the video (the defaults when nothing was).
     * @param {string} userId
     * @param {unknown} videoId
     * @returns {Promise<import("../../../src/lib/wire/library.ts").VideoInputs>}
     */
    async getInputs(userId, videoId) {
      const { channel, folderName } = await resolve(userId, videoId);
      return (
        videos.find(channel.id, folderName)?.inputs ?? {
          productLinks: "",
          notes: "",
          promptSlot: 0,
          styleSlot: 0,
        }
      );
    },

    /**
     * Remembers the inputs of the video.
     * @param {string} userId
     * @param {unknown} videoId
     * @param {unknown} inputs
     * @returns {Promise<import("../../../src/lib/wire/library.ts").VideoInputs>}
     */
    async setInputs(userId, videoId, inputs) {
      const { channel, folderName } = await resolve(userId, videoId);
      return videos.setInputs(videos.ensure(channel.id, folderName).key, inputs);
    },

    /**
     * Removes a video from the main list. Refused while a job of the video is active.
     * @param {string} userId
     * @param {unknown} videoId
     * @returns {Promise<void>}
     */
    async archive(userId, videoId) {
      const { channel, folderName } = await resolve(userId, videoId);
      const row = videos.ensure(channel.id, folderName);
      const job = jobsFor([row.key]).get(row.key);
      if (job && isActiveState(job.state)) {
        throw conflict("This video has an edit in progress. Stop it before archiving the video.");
      }
      if (row.archivedAt === null) {
        videos.setArchived(row.key, clock.now());
        editLog?.record({ userId, videoKey: row.key, event: "archived", message: "Archived" });
      }
      await rescan(userId);
    },

    /**
     * Puts an archived video back in the main list. Doing it twice is fine.
     * @param {string} userId
     * @param {unknown} videoId
     * @returns {Promise<void>}
     */
    async unarchive(userId, videoId) {
      const { channelId, folderName } = folders.parseVideoId(videoId);
      if (!channels.byIdForUser(channelId, userId)) throw missingVideo();
      const row = videos.find(channelId, folderName);
      if (row && row.archivedAt !== null) {
        videos.setArchived(row.key, null);
        editLog?.record({ userId, videoKey: row.key, event: "unarchived", message: "Unarchived" });
      }
      await rescan(userId);
    },

    /**
     * The user's archived videos, most recently archived first. Rows whose folder vanished are
     * dropped from the archive, but only while the channel directory can be read; a channel that
     * cannot be reached lists nothing.
     * @param {string} userId
     * @returns {Promise<ArchivedVideo[]>}
     */
    async getArchived(userId) {
      const userChannels = channels.listForUser(userId);
      const rows = videos.listArchived(userChannels.map((channel) => channel.id));
      /** @type {ArchivedVideo[]} */
      const result = [];
      for (const channel of userChannels) {
        const mine = rows.filter((row) => row.channelId === channel.id);
        if (mine.length === 0) continue;
        /** @type {string} */
        let dir;
        try {
          ({ dir } = await folders.channelDir(userId, channel.id));
        } catch {
          continue;
        }
        const scan = await scanChannelDirectory(dir, { skip: () => true });
        if (!scan.available) continue;
        const present = new Set(scan.folderNames);
        for (const row of mine) {
          if (!present.has(row.folderName)) {
            videos.setArchived(row.key, null);
            continue;
          }
          result.push({
            videoId: `${channel.id}/${row.folderName}`,
            channelId: channel.id,
            channelName: channel.name,
            folderName: row.folderName,
            archivedAt: /** @type {number} */ (row.archivedAt),
          });
        }
      }
      return result.sort(
        (a, b) => b.archivedAt - a.archivedAt || a.folderName.localeCompare(b.folderName),
      );
    },

    /**
     * A video of this user with its folder and its row (made when there is none): what the job
     * engine and the timeline start from.
     * @param {string} userId
     * @param {unknown} videoId
     */
    async videoByWireId(userId, videoId) {
      roleOrThrow(userId);
      const resolved = await resolve(userId, videoId);
      const row = videos.ensure(resolved.channel.id, resolved.folderName);
      return { ...resolved, key: row.key, row };
    },

    /**
     * The effective type of a video now, from a live read of its main A-roll (a job starts with
     * this and keeps it).
     * @param {string} userId
     * @param {unknown} videoId
     * @returns {Promise<{ videoType: VideoType, typeSource: import("../../../src/lib/wire/library.ts").TypeSource, detectedType: VideoType | null }>}
     */
    async resolveVideoType(userId, videoId) {
      const { channel, folderName, dir, channelDir } = await resolve(userId, videoId);
      const scanned = await scanVideoFolder(dir, folderName, channelDir);
      const detectedType = scanned?.mainAroll ? await media.detectType(scanned.mainAroll) : null;
      const row = videos.find(channel.id, folderName);
      return {
        ...resolveVideoType(row?.typeOverride ?? null, channel.videoType, detectedType),
        detectedType,
      };
    },

    /**
     * Who a video key (a `videos.id`) belongs to, without touching the disk.
     * @param {string} key
     * @returns {{ key: string, videoId: string, channelId: string, channelName: string, folderName: string, userId: string } | undefined}
     */
    describeKey(key) {
      const row = videos.byKey(key);
      const channel = row && channels.byId(row.channelId);
      if (!row || !channel) return undefined;
      return {
        key: row.key,
        videoId: `${channel.id}/${row.folderName}`,
        channelId: channel.id,
        channelName: channel.name,
        folderName: row.folderName,
        userId: channel.userId,
      };
    },
  };
  return service;
}

/** @typedef {ReturnType<typeof createLibraryService>} LibraryService */

// The library module (docs/SPEC.md sections 6, 8 and 14): scanning a user's channels into the list
// of videos, Long or Short detection, the actions a row offers, archive, and the library RPC
// functions. `createLibraryModule(deps)` is plugged into the composition root like the storage
// module: `rpc` into `rpc.register`, `start()` and `stop()` into the server's life.
//
// Wiring notes for the composition root:
// - the storage module emits `library-changed` with a `null` payload after channel changes and
//   uploads; give it an `events` adapter that calls `library.api.rescan(userId)` for that event
//   instead, so every `library-changed` carries the library;
// - call `api.rescan(userId)` after job events and `onUserRemoved` hooks (`forgetUser`).

import { createUsersRepo } from "../db/users.js";
import { createVideosRepo } from "../db/videos.js";
import { libraryFunctions } from "../rpc/library.js";
import { createMedia } from "./media.js";
import { createLibraryService, realTimers, RESCAN_INTERVAL_MS } from "./service.js";

/**
 * @typedef {object} LibraryDeps
 * @property {import("../db/open.js").Database} db
 * @property {import("../db/channels.js").ChannelsRepo} channels `storage.api.channelsRepo`.
 * @property {{ folders: import("../storage/videoFolder.js").VideoFolders, uploadsInProgress: (channelId: string, folderName: string) => boolean | number }} storage
 *   `storage.api` of the storage module: the video folders and the uploads in progress.
 * @property {{ emit(event: { event: string, payload: unknown, userId: string | null, admins: boolean }): void }} events
 * @property {import("../db/open.js").Clock} clock
 * @property {import("../log.js").Logger} log
 * @property {Readonly<Record<string, string | undefined>>} [env] For `ffprobe` (default: this process).
 * @property {(videoKeys: string[]) => Map<string, import("../../../src/lib/wire/jobs.ts").JobView>} [jobsFor]
 *   The latest job of each video key; the job manager supplies it (default: no jobs).
 * @property {import("./service.js").LibraryServiceDeps["editLog"]} [editLog] Archive and unarchive are logged.
 * @property {() => string[]} [watchers] User ids with an open event stream (default: nobody).
 * @property {import("./service.js").Timers} [timers]
 * @property {number} [intervalMs] Default 5000.
 * @property {number} [concurrency] Channels and videos scanned at once; default 6.
 * @property {Pick<import("./media.js").MediaDeps, "ffprobeTimeoutMs" | "cacheLimit" | "locate" | "run">} [mediaOptions]
 *   Test seams of the media probe.
 */

/**
 * @param {LibraryDeps} deps
 */
export function createLibraryModule({
  db,
  channels,
  storage,
  events,
  clock,
  log,
  env = process.env,
  jobsFor = () => new Map(),
  watchers = () => [],
  editLog = null,
  timers = realTimers,
  intervalMs = RESCAN_INTERVAL_MS,
  concurrency = 6,
  mediaOptions = {},
}) {
  const videos = createVideosRepo(db, { clock });
  const users = createUsersRepo(db, { clock });
  const media = createMedia({ env, ...mediaOptions });
  const service = createLibraryService({
    videos,
    channels,
    folders: storage.folders,
    media,
    uploadsInProgress: storage.uploadsInProgress,
    jobsFor,
    roleOf: (userId) => users.byId(userId)?.role ?? null,
    events,
    clock,
    log,
    watchers,
    editLog,
    timers,
    intervalMs,
    concurrency,
  });

  return {
    name: "library",
    rpc: libraryFunctions({ service }),

    /** Starts the rescan timer. */
    start: () => service.start(),
    stop: () => service.stop(),

    /** Account hook (`rpc/index.js` `Hooks`): forget what the removed user was sent. */
    hooks: { onUserRemoved: (/** @type {string} */ userId) => service.forgetUser(userId) },

    /** What other modules (jobs, timeline, disk cleanup) build on. */
    api: {
      videos,
      media,
      /** Scans a user's channels again and sends `library-changed` when the result changed. */
      rescan: service.rescan,
      /** The same for every user that has channels. */
      rescanAll: service.rescanAll,
      /**
       * A video of the user with its folder and its database row (made when missing).
       * `notFound` for a foreign or missing video.
       */
      videoByWireId: service.videoByWireId,
      /** The effective type of a video now: `{ videoType, typeSource, detectedType }`. */
      resolveVideoType: service.resolveVideoType,
      /** Who a video key belongs to, without touching the disk. */
      describeKey: service.describeKey,
      /** One of the user's videos as the page shows it. */
      videoView: service.videoView,
      forgetUser: service.forgetUser,
    },
  };
}

/** @typedef {ReturnType<typeof createLibraryModule>} LibraryModule */

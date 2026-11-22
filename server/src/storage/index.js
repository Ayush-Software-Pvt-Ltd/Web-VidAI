// The storage module (docs/SPEC.md sections 3 and 6): path safety, the admin's folder picker,
// channels, video folders and uploads. `createStorageModule(deps)` is plugged into the
// composition root with one line: `rpc` into `rpc.register`, `routes` into the HTTP server,
// `start()` and `stop()` into the server's life.

import { createChannelsRepo } from "../db/channels.js";
import { createUploadsRepo } from "../db/uploads.js";
import { createChannelsService } from "../channels.js";
import { createPlaces } from "../platform/places.js";
import { storageFunctions } from "../rpc/storage.js";
import { workspaceFunctions } from "../rpc/workspace.js";
import { createBrowser } from "./browse.js";
import { createPathGuard } from "./paths.js";
import { createStorageRoutes } from "./routes.js";
import { createUploads } from "./uploads.js";
import { createVideoFolders } from "./videoFolder.js";

/**
 * @typedef {object} StorageDeps
 * @property {import("../db/open.js").Database} db
 * @property {{ getAll(): import("../../../src/lib/wire.ts").AdminSettings, publicView(): import("../../../src/lib/wire.ts").PublicSettings }} settings
 * @property {{ emit(event: { event: string, payload: unknown, userId: string | null, admins: boolean }): void }} events
 * @property {string} dataDir
 * @property {import("../db/open.js").Clock} clock
 * @property {import("../log.js").Logger} log
 * @property {(channelId: string) => boolean} [hasActiveJobs] The jobs module says whether a job of
 *   the channel's videos is active; until it is wired nothing is.
 * @property {(channelId: string) => unknown} [onChannelRemoved] Called after a channel's row
 *   (and with it its videos' rows) is gone; the composition root removes their timeline folders.
 * @property {string} [platform] Only tests pass it (default: the running system).
 * @property {import("../platform/places.js").PlacesOptions} [placesOptions] Only tests pass it:
 *   the home folder and, on a Mac, the root and volumes folders the picker reads.
 * @property {string[]} [defaultPromptPaths]
 * @property {Omit<Parameters<typeof createUploads>[0], "repo" | "folders" | "settings" | "events" | "clock" | "log" | "platform">} [uploadOptions]
 *   Test seams and timings of the uploads (`statfs`, `hooks`, `idleMs`, `staleMs`...).
 */

/**
 * @param {StorageDeps} deps
 */
export function createStorageModule({
  db,
  settings,
  events,
  dataDir,
  clock,
  log,
  hasActiveJobs,
  onChannelRemoved,
  platform = process.platform,
  placesOptions = {},
  defaultPromptPaths,
  uploadOptions = {},
}) {
  const guard = createPathGuard({ dataDir, platform });
  const places = createPlaces({ platform, ...placesOptions });
  const channelsRepo = createChannelsRepo(db, { clock });
  const uploadsRepo = createUploadsRepo(db, { clock });
  const folders = createVideoFolders({ channels: channelsRepo, guard, platform });
  const browser = createBrowser({ guard, channels: channelsRepo, places, platform });
  const uploads = createUploads({
    repo: uploadsRepo,
    folders,
    settings,
    events,
    clock,
    log,
    platform,
    ...uploadOptions,
  });
  const channels = createChannelsService({
    db,
    channels: channelsRepo,
    guard,
    uploads,
    events,
    clock,
    ...(hasActiveJobs ? { hasActiveJobs } : {}),
    ...(onChannelRemoved ? { onRemoved: onChannelRemoved } : {}),
    ...(defaultPromptPaths ? { defaultPromptPaths } : {}),
    platform,
  });

  return {
    name: "storage",
    rpc: [...storageFunctions({ browser, uploads }), ...workspaceFunctions({ channels, settings })],
    routes: createStorageRoutes({ uploads, folders, guard, platform }),

    /** Cleans up stale uploads now and hourly. */
    start: () => uploads.start(),
    stop: () => uploads.stop(),

    /**
     * Hooks (`rpc/index.js` `Hooks`): the user's unfinished uploads end with their hidden part
     * files (channel rows follow with the account, files never).
     */
    hooks: {
      /** @param {string} userId */
      onUserRemoved: (userId) => uploads.cancelAllForUser(userId),
      /** @param {string} userId */
      onUserDisabled: (userId) => uploads.cancelAllForUser(userId),
    },

    /** What other modules (library, jobs, timeline) build on. */
    api: {
      guard,
      folders,
      uploads,
      channels,
      channelsRepo,
      /** The directory rule for a channel (`checkChannelDir` of the channels service). */
      checkChannelDir: channels.checkChannelDir,
      /**
       * How many uploads into the video's own `upload` folder are not complete: a video with one does not
       * offer Start Editing (uploads into the channel's folder block nothing).
       * @param {string} channelId
       * @param {string} folderName
       */
      uploadsInProgress: (channelId, folderName) =>
        uploadsRepo.countInProgress(channelId, folderName),
    },
  };
}

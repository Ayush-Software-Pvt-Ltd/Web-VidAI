// The Disk Cleanup module (docs/SPEC.md section 13): `createDiskModule(deps)` returns the app
// module `{ name: "disk", rpc, stop, api }`. Nothing runs until a page asks (`getDiskUse`), so
// there is no `start()`.
//
// Wiring notes for the composition root (`server/src/app.js`):
// - `channels: storage.api.channelsRepo`, `folders: storage.api.folders`,
//   `videos: library.api.videos`, `library: library.api`, `rescanLibrary: library.api.rescan`;
// - `activeJob: (videoKey) => ...` from the job manager (a job that is queued, running or paused);
//   the manager should also refuse to start a job while `disk.api.isCleaning(videoKey)`;
// - `editLog: editLog` (the service of `server/src/editLog.js`);
// - hooks: `onUserRemoved` into the account hooks; call `api.invalidate(userId)` when a job of the
//   user ends so the page's sizes are checked again;
// - the event `disk-use-changed` goes only to the user it concerns (add it to SPEC section 14).

import { diskFunctions } from "../rpc/disk.js";
import { createDiskService } from "./service.js";

/**
 * @param {import("./service.js").DiskServiceDeps} deps
 */
export function createDiskModule(deps) {
  const service = createDiskService(deps);
  return {
    name: "disk",
    rpc: diskFunctions({ service }),

    /** Cancels the measuring in progress and what is queued. */
    stop: () => service.stop(),

    /** Account hook (`rpc/index.js` `Hooks`). */
    hooks: { onUserRemoved: (/** @type {string} */ userId) => service.forgetUser(userId) },

    api: {
      /** Makes the user's cached sizes be checked again at the next look. */
      invalidate: service.invalidate,
      /** Whether the working files of a video (by key) are being deleted right now. */
      isCleaning: service.isCleaning,
      getDiskUse: service.getDiskUse,
      cleanWorkingFiles: service.cleanWorkingFiles,
    },
  };
}

/** @typedef {ReturnType<typeof createDiskModule>} DiskModule */

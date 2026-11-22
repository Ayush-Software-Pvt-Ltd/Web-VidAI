// The admin's folder picker (docs/SPEC.md section 6, "Folders on the server"): `fsPlaces`, `fsList`,
// `fsCreateFolder` over the server's whole file system. Folders only (files are not listed, only a
// count of video files), hidden entries left out. A folder that is, holds or lies inside a channel
// directory or the data directory is flagged `taken`.
// Only an admin may call them; the RPC layer checks that, nothing here knows about users.

import fsp from "node:fs/promises";
import { AppError, conflict, invalidInput, notFound } from "../errors.js";
import { foldName, pathApi } from "../platform/fsnames.js";
import { naturalCompare } from "./names.js";
import { DATA_DIR_MESSAGE } from "./paths.js";

/** @typedef {import("../../../src/lib/wire/storage.ts").FsPlace} FsPlace */
/** @typedef {import("../../../src/lib/wire/storage.ts").FsListing} FsListing */
/** @typedef {import("../../../src/lib/wire/storage.ts").FsEntry} FsEntry */

/** Video files, for the count in a listing and for what an upload accepts as video. */
export const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "mkv", "mts", "m2ts", "avi", "webm"];

/** @param {string} name */
function isVideoFile(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && VIDEO_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

/**
 * @param {{
 *   guard: import("./paths.js").PathGuard,
 *   channels: import("../db/channels.js").ChannelsRepo,
 *   places: import("../platform/places.js").Places,
 *   platform?: string,
 * }} deps
 */
export function createBrowser({ guard, channels, places, platform = process.platform }) {
  const api = pathApi(platform);

  /**
   * The directories that make a folder `taken`: every channel's and the data directory.
   * @returns {Promise<string[]>}
   */
  async function reservedDirs() {
    return [...channels.listAll().map((channel) => channel.dir), await guard.dataPath()];
  }

  /**
   * @param {string} real
   * @param {string[]} dirs
   * @returns {boolean} Whether `real` is, contains or lies inside one of them.
   */
  const touches = (real, dirs) =>
    dirs.some((dir) => guard.isInside(dir, real) || guard.isInside(real, dir));

  return {
    /**
     * The places the picker starts from: home, the drives, on a Mac the other volumes.
     * @returns {Promise<FsPlace[]>}
     */
    fsPlaces() {
      return places.list();
    },

    /**
     * The folders inside one folder.
     * @param {string | null} path `null` lists the home folder.
     * @returns {Promise<FsListing>}
     * @throws {AppError} `notFound` for a folder that does not exist or cannot be read.
     */
    async fsList(path) {
      const real = await guard.resolve(path ?? places.homeDir);
      /** @type {import("node:fs").Dirent[]} */
      let items;
      try {
        items = await fsp.readdir(real, { withFileTypes: true });
      } catch {
        throw notFound("This folder does not exist or cannot be read.");
      }
      const dirs = await reservedDirs();
      const hidden = await places.hiddenNames(real);
      let videoCount = 0;
      /** @type {FsEntry[]} */
      const entries = [];
      for (const item of items) {
        if (item.name.startsWith(".")) continue;
        if (item.isFile()) {
          if (isVideoFile(item.name)) videoCount += 1;
          continue;
        }
        if (hidden.has(foldName(item.name, platform))) continue;
        let entryPath = api.join(real, item.name);
        if (item.isSymbolicLink()) {
          // A link to a folder is offered under its own name but stands for its target.
          const target = await fsp.realpath(entryPath).catch(() => null);
          const stat = target === null ? null : await fsp.stat(target).catch(() => null);
          if (target === null || !stat?.isDirectory()) continue;
          entryPath = target;
        } else if (!item.isDirectory()) {
          continue;
        }
        entries.push({ name: item.name, path: entryPath, taken: touches(entryPath, dirs) });
      }
      entries.sort((a, b) => naturalCompare(a.name, b.name));

      return {
        path: real,
        parent: places.isDriveTop(real) ? null : api.dirname(real),
        videoCount,
        entries,
      };
    },

    /**
     * Makes one new folder, anywhere but inside the data directory.
     * @param {string} parent
     * @param {string} name
     * @returns {Promise<{ path: string }>}
     */
    async fsCreateFolder(parent, name) {
      const real = await guard.resolve(parent);
      const folderName = guard.safeName(name, { maxChars: 120 });
      if (await guard.insideData(real)) throw invalidInput(DATA_DIR_MESSAGE, "parent");
      const target = api.join(real, folderName);
      try {
        await fsp.mkdir(target);
      } catch (error) {
        const code = /** @type {{ code?: string }} */ (error).code;
        if (code === "EEXIST") throw conflict("A folder with this name already exists here.");
        if (code === "ENOENT" || code === "ENOTDIR") {
          throw invalidInput("The folder to put it in does not exist.", "parent");
        }
        throw new AppError("io", "The server cannot make this folder.", { cause: error });
      }
      return { path: target };
    },
  };
}

/** @typedef {ReturnType<typeof createBrowser>} Browser */

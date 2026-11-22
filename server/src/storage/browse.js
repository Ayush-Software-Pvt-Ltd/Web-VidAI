// The in-page folder picker (docs/SPEC.md section 6): `fsPlaces`, `fsList`, `fsCreateFolder`. It only
// shows storage folders and what is inside them, folders only (files are not listed, only a count of
// video files), hidden entries (leading dot) left out. A folder that is or contains a channel
// directory is flagged `taken` without saying whose channel it is.

import fsp from "node:fs/promises";
import { AppError, conflict, invalidInput } from "../errors.js";
import { pathApi } from "../platform/fsnames.js";
import { naturalCompare } from "./names.js";
import { USER_ID_PATTERN } from "./roots.js";

/** @typedef {import("../../../src/lib/wire/storage.ts").FsPlace} FsPlace */
/** @typedef {import("../../../src/lib/wire/storage.ts").FsListing} FsListing */
/** @typedef {import("../../../src/lib/wire/storage.ts").FsEntry} FsEntry */

/** Video files, for the count in a listing and for what an upload accepts as video. */
export const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "mkv", "mts", "m2ts", "avi", "webm"];

export const TAKEN_MESSAGE = "This folder already belongs to a channel.";

/** What the picker calls the user's own folder. */
export const PERSONAL_NAME = "My folder";

/** @param {string} name */
function isVideoFile(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && VIDEO_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

/**
 * @param {{
 *   roots: import("./roots.js").StorageRoots,
 *   guard: import("./paths.js").PathGuard,
 *   channels: import("../db/channels.js").ChannelsRepo,
 *   platform?: string,
 * }} deps
 */
export function createBrowser({ roots, guard, channels, platform = process.platform }) {
  const api = pathApi(platform);

  /** The directories of every channel of every user. @returns {string[]} */
  const channelDirs = () => channels.listAll().map((channel) => channel.dir);

  /**
   * @param {string} real
   * @param {string[]} dirs
   * @returns {{ inside: boolean, contains: boolean }} Whether `real` is or lies inside a channel
   *   directory, whether it is or contains one.
   */
  function relationToChannels(real, dirs) {
    return {
      inside: dirs.some((dir) => guard.isInside(dir, real)),
      contains: dirs.some((dir) => guard.isInside(real, dir)),
    };
  }

  return {
    /**
     * The places the picker starts from: the user's personal folder first, then each storage folder.
     * @param {{ id: string }} user
     * @returns {Promise<FsPlace[]>}
     */
    async fsPlaces(user) {
      /** @type {FsPlace[]} */
      const places = [
        {
          name: PERSONAL_NAME,
          path: await roots.personalFolder(user.id),
          kind: "personal",
          available: true,
        },
      ];
      for (const root of await roots.list()) {
        places.push({
          name: root.name,
          path: root.path,
          kind: "storage",
          available: root.available,
        });
      }
      return places;
    },

    /**
     * The folders inside one folder.
     * @param {string | null} path `null` lists the personal folder.
     * @param {{ id: string }} user
     * @returns {Promise<FsListing>}
     * @throws {AppError} `forbidden` outside the storage folders, `conflict` inside a channel of
     *   another account (the same sentence as for a folder that is simply taken).
     */
    async fsList(path, user) {
      const asked = path ?? (await roots.personalFolder(user.id));
      const real = await guard.resolveFor(asked, user.id);
      const dirs = channelDirs();
      const own = new Set(channels.listForUser(user.id).map((channel) => channel.dir));
      const relation = relationToChannels(real, dirs);
      if (relation.inside) {
        // Inside a channel of this user is theirs to look at; a stranger's is not.
        const insideOwn = [...own].some((dir) => guard.isInside(dir, real));
        if (!insideOwn) throw conflict(TAKEN_MESSAGE);
      }

      /** @type {import("node:fs").Dirent[]} */
      let items;
      try {
        items = await fsp.readdir(real, { withFileTypes: true });
      } catch (error) {
        const code = /** @type {{ code?: string }} */ (error).code;
        if (code === "ENOTDIR") throw invalidInput("This is not a folder.");
        if (code === "ENOENT") throw invalidInput("This folder does not exist.");
        throw new AppError("io", "The server cannot read this folder.", { cause: error });
      }
      const media = await roots.mediaPath();
      const atMedia = guard.isSame(media, real);
      let videoCount = 0;
      /** @type {FsEntry[]} */
      const entries = [];
      for (const item of items) {
        if (item.isFile()) {
          if (isVideoFile(item.name)) videoCount += 1;
          continue;
        }
        // A link may lead anywhere; it is not offered (and would be refused when opened).
        if (!item.isDirectory() || item.name.startsWith(".")) continue;
        if (atMedia && USER_ID_PATTERN.test(item.name) && item.name !== user.id) continue;
        const entryPath = api.join(real, item.name);
        const entryRelation = relationToChannels(entryPath, dirs);
        entries.push({
          name: item.name,
          path: entryPath,
          taken: entryRelation.inside || entryRelation.contains,
        });
      }
      entries.sort((a, b) => naturalCompare(a.name, b.name));

      const root = await guard.rootOf(real);
      const parent = root === null || guard.isSame(root, real) ? null : api.dirname(real);
      return { path: real, parent, videoCount, entries };
    },

    /**
     * Makes one new folder.
     * @param {string} parent
     * @param {string} name
     * @param {{ id: string }} user
     * @returns {Promise<{ path: string }>}
     */
    async fsCreateFolder(parent, name, user) {
      const real = await guard.resolveFor(parent, user.id);
      const folderName = guard.safeName(name, { maxChars: 120 });
      if (relationToChannels(real, channelDirs()).inside) throw conflict(TAKEN_MESSAGE);
      const target = api.join(real, folderName);
      try {
        await fsp.mkdir(target);
      } catch (error) {
        const code = /** @type {{ code?: string }} */ (error).code;
        if (code === "EEXIST") throw conflict("A folder with this name already exists here.");
        if (code === "ENOENT" || code === "ENOTDIR") {
          throw invalidInput("The folder to put it in does not exist.");
        }
        throw new AppError("io", "The server cannot make this folder.", { cause: error });
      }
      return { path: target };
    },
  };
}

/** @typedef {ReturnType<typeof createBrowser>} Browser */

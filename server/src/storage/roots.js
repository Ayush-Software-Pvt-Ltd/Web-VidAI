// The storage folders (docs/SPEC.md sections 5 and 6): the admin's `storageRoots` setting plus the
// always present `<data dir>/media`, each taken at its real path. A folder that cannot be reached
// right now (an unmounted share) is reported with `available: false`, never an error. Each user
// has a personal folder `<data dir>/media/<user id>/`, made on demand.

import fsp from "node:fs/promises";
import path from "node:path";
import { AppError } from "../errors.js";
import { foldName } from "../platform/fsnames.js";

/**
 * @typedef {object} StorageRoot
 * @property {string} name What the folder picker shows.
 * @property {string} path The real path when reachable, else the path as the admin wrote it.
 * @property {boolean} available
 * @property {boolean} isMedia True for `<data dir>/media`, the default storage folder.
 */

/** User ids are 16 random bytes in hex; a personal folder is named like that. */
export const USER_ID_PATTERN = /^[0-9a-f]{32}$/;

/** The name the picker shows for the default storage folder. */
export const MEDIA_NAME = "Server storage";

/**
 * @param {{
 *   settings: { getAll(): { storageRoots: string[] } },
 *   dataDir: string,
 *   platform?: string,
 * }} deps `platform` only decides how paths are compared (default: the running system).
 */
export function createStorageRoots({ settings, dataDir, platform = process.platform }) {
  const mediaConfigured = path.join(dataDir, "media");

  /**
   * @param {string} target
   * @returns {Promise<string | null>} The real path of an existing directory, else null.
   */
  async function realDirectory(target) {
    try {
      const real = await fsp.realpath(target);
      return (await fsp.stat(real)).isDirectory() ? real : null;
    } catch {
      return null;
    }
  }

  /** @param {string} configured */
  function displayName(configured) {
    const base = path.basename(configured);
    return base === "" ? configured : base;
  }

  const roots = {
    /**
     * Every storage folder in the order the picker shows them: the default one first, then the
     * admin's in the order of the setting. Duplicates (the same real folder twice) appear once.
     * @returns {Promise<StorageRoot[]>}
     */
    async list() {
      /** @type {StorageRoot[]} */
      const result = [];
      const seen = new Set();
      await fsp.mkdir(mediaConfigured, { recursive: true }).catch(() => {});
      const candidates = [
        { configured: mediaConfigured, isMedia: true },
        ...settings.getAll().storageRoots.map((configured) => ({ configured, isMedia: false })),
      ];
      for (const { configured, isMedia } of candidates) {
        const real = await realDirectory(configured);
        const key = foldName(real ?? configured, platform);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
          name: isMedia ? MEDIA_NAME : displayName(configured),
          path: real ?? configured,
          available: real !== null,
          isMedia,
        });
      }
      return result;
    },

    /** The real paths of the storage folders that can be reached now. @returns {Promise<string[]>} */
    async realPaths() {
      return (await roots.list()).filter((root) => root.available).map((root) => root.path);
    },

    /** The real path of `<data dir>/media`, made when missing. @returns {Promise<string>} */
    async mediaPath() {
      await fsp.mkdir(mediaConfigured, { recursive: true });
      return fsp.realpath(mediaConfigured);
    },

    /** The real path of the data directory. @returns {Promise<string>} */
    dataPath() {
      return fsp.realpath(dataDir);
    },

    /**
     * The user's personal folder, made when it does not exist yet.
     * @param {string} userId
     * @returns {Promise<string>} Its real path.
     */
    async personalFolder(userId) {
      if (!USER_ID_PATTERN.test(userId)) {
        throw new AppError("internal", "This account has no personal folder.");
      }
      const folder = path.join(await roots.mediaPath(), userId);
      await fsp.mkdir(folder, { recursive: true });
      return fsp.realpath(folder);
    },
  };
  return roots;
}

/** @typedef {ReturnType<typeof createStorageRoots>} StorageRoots */

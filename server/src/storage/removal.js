// Taking a storage folder away from the admin's list (docs/SPEC.md sections 5 and 6): refused while
// users have channel folders inside it, because those channels would lie outside every storage
// folder and the path guard would turn all of their videos away. The default folder
// `<data dir>/media` is never in the list (`roots.js` always adds it), so it cannot be removed.
// Folders are compared by real path, like the path guard does.

import fsp from "node:fs/promises";
import path from "node:path";
import { conflict } from "../errors.js";
import { isInside } from "./paths.js";

/**
 * The real path of `target`, or the path as written when it cannot be reached right now (an
 * unmounted share) - a channel on it still counts as being there.
 * @param {string} target
 * @returns {Promise<string>}
 */
async function realOrWritten(target) {
  try {
    return await fsp.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * @param {number} count
 * @param {string} one
 * @param {string} many
 */
const counted = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/**
 * @param {{
 *   settings: { getAll(): { storageRoots: string[] } },
 *   channels: { listAll(): Array<{ dir: string, userId: string }> },
 *   dataDir: string,
 *   platform?: string,
 * }} deps
 */
export function createRootsRemoval({ settings, channels, dataDir, platform = process.platform }) {
  return {
    /**
     * Refuses a new list of storage folders that drops a folder holding channels.
     * @param {string[]} next The cleaned list the admin wants.
     * @returns {Promise<void>}
     * @throws {import("../errors.js").AppError} `conflict`, naming the folder and how many
     *   channels of how many users are inside it.
     */
    async check(next) {
      const before = settings.getAll().storageRoots;
      const kept = new Set(next);
      const removed = before.filter((folder) => !kept.has(folder));
      if (removed.length === 0) return;

      const stays = await Promise.all(
        [path.join(dataDir, "media"), ...next].map((folder) => realOrWritten(folder)),
      );
      const places = await Promise.all(
        channels.listAll().map(async (channel) => ({
          userId: channel.userId,
          real: await realOrWritten(channel.dir),
        })),
      );
      for (const folder of removed) {
        const real = await realOrWritten(folder);
        // A folder that is still listed under another spelling is not gone.
        if (
          stays.some((other) => isInside(other, real, platform) && isInside(real, other, platform))
        )
          continue;
        const inside = places.filter(
          (place) =>
            isInside(real, place.real, platform) &&
            // Still inside a storage folder that stays (a folder within the removed one).
            !stays.some((other) => isInside(other, place.real, platform)),
        );
        if (inside.length === 0) continue;
        const users = new Set(inside.map((place) => place.userId)).size;
        throw conflict(
          `${counted(inside.length, "channel", "channels")} of ${counted(users, "user", "users")} ` +
            `${inside.length === 1 ? "is" : "are"} in ${folder}. ` +
            `Move or remove ${inside.length === 1 ? "it" : "them"} first.`,
        );
      }
    },
  };
}

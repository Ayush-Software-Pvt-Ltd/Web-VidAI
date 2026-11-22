// Deleting the working files of a video (docs/SPEC.md sections 6 and 13): everything inside
// `<video>/CLAUDE_VE/` goes, the empty folder stays. This is one of the two places where VidAI
// deletes anything in a channel directory, so it is strict:
//
// - `CLAUDE_VE` must be a real folder (not a link, junction included) whose real path is exactly
//   `<video>/CLAUDE_VE` (`isSame` of the path guard), else nothing is touched;
// - deleting never follows a link: a link inside is removed itself, its target is untouched, and
//   a folder is only entered after `lstat` says it is a folder and `realpath` agrees that it is
//   still where it was seen (so it cannot have been swapped for a link meanwhile);
// - a file that cannot be removed is counted and skipped, the rest goes on;
// - nothing outside the working folder is ever named in a delete call.

import fsp from "node:fs/promises";
import path from "node:path";
import { conflict } from "../errors.js";
import { isSame } from "../storage/paths.js";
import { WORKING_DIR } from "./layout.js";

/** @typedef {import("../../../src/lib/wire/disk.ts").CleanResult} CleanResult */

/** @param {unknown} error */
const code = (error) => /** @type {{ code?: string }} */ (error)?.code;

/**
 * Checks the working folder of a video.
 * @param {string} videoDir The video folder's real path.
 * @returns {Promise<string>} The working folder's path, safe to empty.
 * @throws {import("../errors.js").AppError} `conflict` when there is nothing to delete or the
 *   folder is not what it must be.
 */
export async function checkedWorkingFolder(videoDir) {
  const top = path.join(videoDir, WORKING_DIR);
  /** @type {import("node:fs").Stats} */
  let stat;
  try {
    stat = await fsp.lstat(top);
  } catch (error) {
    if (code(error) === "ENOENT" || code(error) === "ENOTDIR") {
      throw conflict("There are no working files to delete.");
    }
    throw conflict("The working files of this video cannot be reached right now.");
  }
  if (stat.isSymbolicLink()) {
    throw conflict("The working folder of this video is a link, so nothing was deleted.");
  }
  if (!stat.isDirectory()) {
    throw conflict("The working folder of this video is not a folder, so nothing was deleted.");
  }
  /** @type {string} */
  let real;
  let realVideo;
  try {
    real = await fsp.realpath(top);
    realVideo = await fsp.realpath(videoDir);
  } catch {
    throw conflict("The working files of this video cannot be reached right now.");
  }
  if (!isSame(real, path.join(realVideo, WORKING_DIR))) {
    throw conflict("The working folder of this video is not inside the video folder.");
  }
  return real;
}

/**
 * Empties a folder that `checkedWorkingFolder` approved.
 * @param {string} root
 * @returns {Promise<CleanResult>}
 */
export async function emptyFolder(root) {
  let freedBytes = 0;
  let leftover = 0;
  /** Hard-linked files: bytes are freed only when the last link is gone. @type {Map<string, { size: number, nlink: number, removed: number }>} */
  const linked = new Map();

  /**
   * @param {string} dir
   * @returns {Promise<boolean>} Everything in it was removed.
   */
  async function empty(dir) {
    /** @type {string[]} */
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch (error) {
      if (code(error) === "ENOENT") return true;
      leftover += 1;
      return false;
    }
    let allGone = true;
    for (const name of names) {
      const full = path.join(dir, name);
      /** @type {import("node:fs").BigIntStats} */
      let stat;
      try {
        stat = await fsp.lstat(full, { bigint: true });
      } catch (error) {
        if (code(error) === "ENOENT") continue;
        leftover += 1;
        allGone = false;
        continue;
      }
      if (stat.isDirectory()) {
        if (!(await stillThere(full))) {
          leftover += 1;
          allGone = false;
          continue;
        }
        if (!(await empty(full))) {
          allGone = false;
          continue;
        }
        try {
          await fsp.rmdir(full);
        } catch (error) {
          if (code(error) === "ENOENT") continue;
          leftover += 1;
          allGone = false;
        }
        continue;
      }
      try {
        await fsp.unlink(full);
      } catch (error) {
        if (code(error) === "ENOENT") continue;
        leftover += 1;
        allGone = false;
        continue;
      }
      if (!stat.isFile()) continue;
      const size = Number(stat.size);
      if (stat.nlink <= 1n) {
        freedBytes += size;
        continue;
      }
      const id = `${stat.dev}:${stat.ino}`;
      const entry = linked.get(id) ?? { size, nlink: Number(stat.nlink), removed: 0 };
      entry.removed += 1;
      linked.set(id, entry);
      if (entry.removed === entry.nlink) freedBytes += size;
    }
    return allGone;
  }

  await empty(root);
  return { freedBytes, leftover };
}

/**
 * A folder seen by `lstat` is still that folder at that place, not a link put there since.
 * @param {string} dir
 */
async function stillThere(dir) {
  try {
    return isSame(await fsp.realpath(dir), dir);
  } catch {
    return false;
  }
}

/**
 * Deletes the working files of one video.
 * @param {string} videoDir The video folder's real path.
 * @returns {Promise<CleanResult>}
 * @throws {import("../errors.js").AppError} `conflict`, see `checkedWorkingFolder`.
 */
export async function cleanWorkingFolder(videoDir) {
  return emptyFolder(await checkedWorkingFolder(videoDir));
}

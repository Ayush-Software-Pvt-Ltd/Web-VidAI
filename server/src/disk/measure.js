// Measuring a video folder (docs/SPEC.md section 13). Reads only metadata, one entry after the
// other (so it never loads the disk), never follows a link (a link counts as nothing and is not
// entered), counts a hard-linked file once, and goes on when a file or folder vanishes or cannot
// be read meanwhile.
//
// Sizes are the files' sizes (`st_size`), not the blocks they occupy: that is what Finder and
// Explorer show as "size" and what a person expects to get back.
//
// A hard-linked file is counted in the part where it is found first: the files of a folder in code
// point order of their names, then its sub-folders in the same order, so the answer does not depend
// on directory order (a copy next to the video's A-roll counts as source, not as working file).

import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { partOf } from "./layout.js";

/** @typedef {import("../../../src/lib/wire/disk.ts").DiskSizes} DiskSizes */

/** @param {unknown} error */
const isAbort = (error) => error instanceof Error && error.name === "AbortError";

/** @param {AbortSignal | undefined} signal */
function checkAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("Measuring was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

/** @param {string} a @param {string} b */
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {string} dir
 * @returns {Promise<string[] | null>} Sorted names; `null` when the folder cannot be read.
 */
async function namesOf(dir) {
  try {
    return (await fsp.readdir(dir)).sort(byName);
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @returns {Promise<import("node:fs").BigIntStats | null>} `null` when it vanished or cannot be read.
 */
async function lstatOrNull(file) {
  try {
    return await fsp.lstat(file, { bigint: true });
  } catch {
    return null;
  }
}

/**
 * The sizes of the four parts of one video folder.
 * @param {string} videoDir The video folder's real path.
 * @param {string} folderName
 * @param {AbortSignal} [signal]
 * @returns {Promise<DiskSizes | null>} `null` when cancelled.
 */
export async function measureVideoFolder(videoDir, folderName, signal) {
  const sizes = { working: 0, project: 0, finals: 0, sources: 0, total: 0 };
  /** @type {Set<string>} */
  const hardLinks = new Set();
  /** @type {{ dir: string, segments: string[] }[]} */
  const stack = [{ dir: videoDir, segments: [] }];
  try {
    while (stack.length > 0) {
      const { dir, segments } = /** @type {{ dir: string, segments: string[] }} */ (stack.pop());
      const names = await namesOf(dir);
      if (names === null) continue;
      /** @type {{ dir: string, segments: string[] }[]} */
      const folders = [];
      for (const name of names) {
        checkAborted(signal);
        const full = path.join(dir, name);
        const stat = await lstatOrNull(full);
        if (stat === null) continue;
        const here = [...segments, name];
        if (stat.isDirectory()) {
          folders.push({ dir: full, segments: here });
        } else if (stat.isFile()) {
          if (stat.nlink > 1n) {
            const id = `${stat.dev}:${stat.ino}`;
            if (hardLinks.has(id)) continue;
            hardLinks.add(id);
          }
          sizes[partOf(here, folderName)] += Number(stat.size);
        }
      }
      // The files of this folder are done; its sub-folders follow in name order.
      for (const folder of folders.reverse()) stack.push(folder);
    }
  } catch (error) {
    if (isAbort(error)) return null;
    throw error;
  }
  sizes.total = sizes.working + sizes.project + sizes.finals + sizes.sources;
  return sizes;
}

/**
 * "Folder time" of a video folder: a short text that changes when something in it changed, found
 * without reading the whole tree. A folder's own modified time only moves when entries are added
 * or removed directly inside it, so the fingerprint takes the size and modified time (to the
 * nanosecond) of the folder itself, of every entry in it, and of every entry of its sub-folders
 * (the working folder, `output/`, the B-roll folder): a file written two levels down changes its
 * folder's time or its own size and is noticed; a change deeper than that is caught by the
 * cache's maximum age instead (`service.js`).
 * @param {string} videoDir
 * @param {AbortSignal} [signal]
 * @returns {Promise<string | null>} `null` when cancelled. Folders that cannot be read
 *   contribute nothing (a vanished folder therefore changes the fingerprint too).
 */
export async function fingerprintVideoFolder(videoDir, signal) {
  const hash = createHash("sha1");
  /** @param {string} label @param {import("node:fs").BigIntStats} stat */
  const add = (label, stat) =>
    hash.update(`${label}|${stat.isDirectory() ? "d" : "f"}|${stat.size}|${stat.mtimeNs}\n`);
  try {
    const top = await lstatOrNull(videoDir);
    if (top) add(".", top);
    const names = (await namesOf(videoDir)) ?? [];
    for (const name of names) {
      checkAborted(signal);
      const stat = await lstatOrNull(path.join(videoDir, name));
      if (stat === null) continue;
      add(name, stat);
      if (!stat.isDirectory()) continue;
      for (const inner of (await namesOf(path.join(videoDir, name))) ?? []) {
        checkAborted(signal);
        const innerStat = await lstatOrNull(path.join(videoDir, name, inner));
        if (innerStat) add(`${name}/${inner}`, innerStat);
      }
    }
  } catch (error) {
    if (isAbort(error)) return null;
    throw error;
  }
  return hash.digest("hex");
}

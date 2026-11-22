// The scanner (docs/SPEC.md section 6, "Videos"; ported from `src-tauri/src/scanner.rs`): one
// channel directory in, the videos in it out. Pure with respect to the database and the job
// engine: it only reads folders. Detection of Long or Short, the latest job and the actions are
// added by the library service.
//
// - A video is a folder directly inside the channel directory. Names starting with `.` or
//   `CLAUDE_VE`, and the asset folders (`Style`, `sample`, ...), are not videos (`names.js`).
//   Videos are listed newest first: the natural order of the names, descending.
// - A-roll files are regular files directly in the video folder with a video extension; the
//   main one is the largest (a tie goes to the smaller name).
// - `createdAt` is the folder's creation time, its modified time when the system keeps none.
// - Nothing is read inside `CLAUDE_VE*` except the one cheap question whether the working
//   folder `CLAUDE_VE` holds any file (Disk Cleanup, SPEC section 13).
// - A channel directory that is missing or unreadable gives `available: false`: no videos, and
//   nobody may conclude from it that a video was deleted.
// - A link is used only when it leads to a place inside the channel directory (`entries.js`);
//   a video folder that is a link is not a video.

import fsp from "node:fs/promises";
import path from "node:path";
import { brollFolderName, isReservedChannelEntry, naturalCompare } from "../storage/names.js";
import { extensionOf, readEntriesOrNull, statFile } from "./entries.js";
import { mapLimit } from "./mapLimit.js";
import { scanOutput, workingFolderHasFiles } from "./outputs.js";

/** A-roll file extensions (SPEC-desktop section 2), compared ignoring case. */
export const AROLL_EXTENSIONS = ["mp4", "mov", "m4v", "mkv", "mts", "m2ts", "avi", "webm"];

/**
 * @typedef {object} ArollFile
 * @property {string} name
 * @property {string} path Full path on the server (never leaves the server).
 * @property {number} size
 * @property {number} modifiedMs
 */

/**
 * @typedef {object} ScannedVideo
 * @property {string} folderName
 * @property {string} dir Real path of the video folder.
 * @property {number} createdAt Milliseconds.
 * @property {ArollFile[]} arollFiles
 * @property {ArollFile | null} mainAroll
 * @property {string} brollFolder The name of the B-roll folder (`Broll` when the video has none).
 * @property {import("../../../src/lib/wire/library.ts").VideoOutput} output
 * @property {boolean} workingFiles `CLAUDE_VE` holds at least one file.
 */

/**
 * @typedef {object} ChannelScan
 * @property {boolean} available False when the channel directory is missing or unreadable.
 * @property {string[]} folderNames Every video folder name (also the skipped ones), newest first.
 * @property {ScannedVideo[]} videos The scanned videos, newest first; `skip`ped ones are left out.
 */

/**
 * True when `name` has one of the A-roll extensions.
 * @param {string} name
 * @returns {boolean}
 */
export function isArollName(name) {
  return AROLL_EXTENSIONS.includes(extensionOf(name));
}

/**
 * The main A-roll: the largest file; equal sizes are decided by name so the choice is stable.
 * @param {readonly ArollFile[]} files
 * @returns {ArollFile | null}
 */
export function mainAroll(files) {
  /** @type {ArollFile | null} */
  let best = null;
  for (const file of files) {
    if (
      best === null ||
      file.size > best.size ||
      (file.size === best.size && file.name < best.name)
    ) {
      best = file;
    }
  }
  return best;
}

/**
 * Creation time of a folder in milliseconds, else its modified time (not every file system keeps
 * a creation time; it then reads as 0).
 * @param {import("node:fs").Stats} stat
 * @returns {number}
 */
function createdMs(stat) {
  return Math.round(stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs);
}

/**
 * Scans one video folder.
 * @param {string} dir The video folder.
 * @param {string} folderName
 * @param {string} rootReal Real path of the channel directory.
 * @returns {Promise<ScannedVideo | null>} `null` when the folder vanished or cannot be read.
 */
export async function scanVideoFolder(dir, folderName, rootReal) {
  /** @type {import("node:fs").Stats} */
  let stat;
  try {
    stat = await fsp.stat(dir);
  } catch {
    return null;
  }
  const entries = await readEntriesOrNull(dir, rootReal);
  if (entries === null) return null;

  /** @type {ArollFile[]} */
  const arollFiles = [];
  /** @type {string[]} */
  const subfolders = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.kind === "dir") {
      subfolders.push(entry.name);
    } else if (isArollName(entry.name)) {
      const file = await statFile(entry.path);
      if (file) arollFiles.push({ name: entry.name, path: entry.path, ...file });
    }
  }
  arollFiles.sort((a, b) => naturalCompare(a.name, b.name));

  const [output, workingFiles] = await Promise.all([
    scanOutput(dir, folderName, rootReal, entries),
    workingFolderHasFiles(dir),
  ]);
  return {
    folderName,
    dir,
    createdAt: createdMs(stat),
    arollFiles,
    mainAroll: mainAroll(arollFiles),
    brollFolder: brollFolderName(subfolders),
    output,
    workingFiles,
  };
}

/**
 * Scans a channel directory.
 * @param {string} channelDir The channel's directory.
 * @param {{ skip?: (folderName: string) => boolean, concurrency?: number }} [options] `skip`: a
 *   folder that needs no scan (archived videos); it is still named in `folderNames`.
 * @returns {Promise<ChannelScan>}
 */
export async function scanChannelDirectory(channelDir, { skip, concurrency = 6 } = {}) {
  const unavailable = { available: false, folderNames: [], videos: [] };
  /** @type {string} */
  let rootReal;
  try {
    rootReal = await fsp.realpath(channelDir);
    if (!(await fsp.stat(rootReal)).isDirectory()) return unavailable;
  } catch {
    return unavailable;
  }
  const entries = await readEntriesOrNull(rootReal, rootReal);
  if (entries === null) return unavailable;

  const folders = entries
    .filter((entry) => entry.kind === "dir" && !entry.link && !isReservedChannelEntry(entry.name))
    .map((entry) => entry.name)
    // Newest first: natural order, descending.
    .sort((a, b) => naturalCompare(b, a));
  const wanted = folders.filter((name) => !(skip && skip(name)));
  const scanned = await mapLimit(wanted, concurrency, (name) =>
    scanVideoFolder(path.join(rootReal, name), name, rootReal),
  );
  return {
    available: true,
    folderNames: folders,
    videos: scanned.filter((video) => video !== null),
  };
}

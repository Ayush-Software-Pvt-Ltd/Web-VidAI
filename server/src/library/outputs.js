// What a video has produced (docs/SPEC.md section 6, "Videos"). New in the server; the desktop
// app looked for Final Cut Pro and Premiere Pro files instead.
//
//   <video>/output/<video folder name>.hf/index.html   the project (at most one)
//   <video>/output/*.mp4 | *.mov | *.m4v                finals
//   <video>/output/thumbnail-*.png | jpg | jpeg         thumbnails
//   <video>/output/meta.txt                              the title and description
//   <video>/info.txt                                     the agent's log
//
// Names starting with `.` are skipped, which also hides upload part files. Every path in the
// result is relative to the video folder (never a path on the server).

import fsp from "node:fs/promises";
import path from "node:path";
import { naturalCompare } from "../storage/names.js";
import { extensionOf, isInside, readEntries, statFile } from "./entries.js";

/** @typedef {import("../../../src/lib/wire/library.ts").VideoOutput} VideoOutput */
/** @typedef {import("../../../src/lib/wire/library.ts").OutputFile} OutputFile */

/** The folder inside a video folder that holds everything the agent produced. */
export const OUTPUT_DIR = "output";

const FINAL_EXTENSIONS = ["mp4", "mov", "m4v"];
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg"];

/** @returns {VideoOutput} */
export function emptyOutput() {
  return {
    project: null,
    finals: [],
    newestFinal: null,
    thumbnails: [],
    metaFile: null,
    infoFile: null,
  };
}

/**
 * The project of a video: `index.html` of the folder `output/<folder name>.hf`, a regular file.
 * A `.hf` folder with another name, or without `index.html`, is not the project. The relative
 * path is built from names so no path on the server can leak.
 * @param {readonly import("./entries.js").Entry[]} entries The entries of `output/`.
 * @param {string} folderName
 * @param {string} rootReal
 * @returns {Promise<VideoOutput["project"]>}
 */
async function findProject(entries, folderName, rootReal) {
  const projectName = `${folderName}.hf`;
  const folder = entries.find((entry) => entry.kind === "dir" && entry.name === projectName);
  if (!folder) return null;
  const inner = await readEntries(folder.path, rootReal);
  const index = inner.find((entry) => entry.kind === "file" && entry.name === "index.html");
  if (!index) return null;
  const stat = await statFile(index.path);
  if (!stat) return null;
  return {
    path: `${OUTPUT_DIR}/${projectName}/index.html`,
    modifiedAt: stat.modifiedMs,
  };
}

/**
 * The outputs of one video folder. Never fails: a missing or unreadable `output/` is an empty
 * output.
 * @param {string} videoDir The video folder (a real folder inside the channel directory).
 * @param {string} folderName The video folder's name (the project is named after it).
 * @param {string} rootReal Real path of the channel directory; links leading out of it are ignored.
 * @param {readonly import("./entries.js").Entry[]} [videoEntries] The entries of the video folder,
 *   when the caller has read them already.
 * @returns {Promise<VideoOutput>}
 */
export async function scanOutput(videoDir, folderName, rootReal, videoEntries) {
  const result = emptyOutput();

  // `info.txt` lives in the video folder.
  const infoEntries = videoEntries ?? (await readEntries(videoDir, rootReal));
  if (infoEntries.some((entry) => entry.kind === "file" && entry.name === "info.txt")) {
    result.infoFile = "info.txt";
  }

  const outputEntry = infoEntries.find(
    (entry) => entry.kind === "dir" && entry.name === OUTPUT_DIR,
  );
  if (!outputEntry) return result;
  const entries = await readEntries(outputEntry.path, rootReal);

  result.project = await findProject(entries, folderName, rootReal);

  /** @type {OutputFile[]} */
  const finals = [];
  /** @type {OutputFile[]} */
  const thumbnails = [];
  for (const entry of entries) {
    if (entry.kind !== "file" || entry.name.startsWith(".")) continue;
    const extension = extensionOf(entry.name);
    const isFinal = FINAL_EXTENSIONS.includes(extension);
    const isThumbnail =
      IMAGE_EXTENSIONS.includes(extension) && entry.name.toLowerCase().startsWith("thumbnail-");
    const isMeta = entry.name.toLowerCase() === "meta.txt";
    if (!isFinal && !isThumbnail && !isMeta) continue;
    if (isMeta) {
      result.metaFile = `${OUTPUT_DIR}/${entry.name}`;
      continue;
    }
    const stat = await statFile(entry.path);
    if (!stat) continue;
    /** @type {OutputFile} */
    const file = {
      name: entry.name,
      path: `${OUTPUT_DIR}/${entry.name}`,
      size: stat.size,
      modifiedAt: stat.modifiedMs,
    };
    (isFinal ? finals : thumbnails).push(file);
  }
  finals.sort((a, b) => naturalCompare(a.name, b.name));
  thumbnails.sort((a, b) => naturalCompare(a.name, b.name));
  result.finals = finals;
  result.thumbnails = thumbnails;
  // The newest one wins; equal times fall to the last in natural order, so the answer is stable.
  let newest = null;
  for (const file of finals) {
    if (newest === null || file.modifiedAt >= newest.modifiedAt) newest = file;
  }
  result.newestFinal = newest ? newest.name : null;
  return result;
}

/**
 * Whether the working folder of a video, `<video>/CLAUDE_VE/`, holds any file (docs/SPEC.md
 * section 13: the folder Disk Cleanup empties). Stops at the first file. A link, or a working
 * folder that does not resolve inside the video folder, counts as empty: Disk Cleanup refuses
 * those, so the action must not be offered.
 * @param {string} videoDir
 * @param {{ limit?: number }} [options] `limit`: the most folder entries looked at (a folder tree
 *   with no file in it must not keep a scan busy).
 * @returns {Promise<boolean>}
 */
export async function workingFolderHasFiles(videoDir, { limit = 5000 } = {}) {
  const top = path.join(videoDir, "CLAUDE_VE");
  try {
    const stat = await fsp.lstat(top);
    if (!stat.isDirectory()) return false;
    if (!isInside(await fsp.realpath(videoDir), await fsp.realpath(top))) return false;
  } catch {
    return false;
  }
  const stack = [top];
  let looked = 0;
  while (stack.length > 0 && looked < limit) {
    const dir = /** @type {string} */ (stack.pop());
    /** @type {import("node:fs").Dirent[]} */
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      looked += 1;
      // A file the Finder leaves behind is not "files to clean".
      if (dirent.name === ".DS_Store") continue;
      if (dirent.isFile() || dirent.isSymbolicLink()) return true;
      if (dirent.isDirectory()) stack.push(path.join(dir, dirent.name));
    }
  }
  return false;
}

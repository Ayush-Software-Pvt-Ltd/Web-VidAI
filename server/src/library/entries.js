// Reading folders for the scanner (docs/SPEC.md section 6). The scanner never follows a link
// out of the channel directory: a link is used only when its real target lies inside the
// channel's real directory, so a user cannot make the library list or serve files from
// somewhere else on the server.

import fsp from "node:fs/promises";
import path from "node:path";

/**
 * @typedef {object} Entry
 * @property {string} name
 * @property {string} path The path to open (under the folder that was read).
 * @property {"dir" | "file"} kind What it is after resolving an allowed link.
 * @property {boolean} link It is a link (to a place inside the root).
 */

/**
 * Whether `target` is `root` or lies inside it. Both are real paths. Uses the rules of the
 * running system's paths (case-insensitive on Windows).
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isInside(root, target) {
  const relative = path.relative(root, target);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/**
 * The entries of a folder that are plain folders or files, or links to such inside `rootReal`.
 * Links that point elsewhere, are broken, or lead to anything else are left out.
 * @param {string} dir
 * @param {string} rootReal Real path of the channel directory.
 * @returns {Promise<Entry[] | null>} `null` when the folder cannot be read.
 */
export async function readEntriesOrNull(dir, rootReal) {
  /** @type {import("node:fs").Dirent[]} */
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  /** @type {Entry[]} */
  const entries = [];
  for (const dirent of dirents) {
    const full = path.join(dir, dirent.name);
    if (dirent.isSymbolicLink()) {
      try {
        const real = await fsp.realpath(full);
        if (!isInside(rootReal, real)) continue;
        const stat = await fsp.stat(real);
        if (stat.isDirectory())
          entries.push({ name: dirent.name, path: full, kind: "dir", link: true });
        else if (stat.isFile())
          entries.push({ name: dirent.name, path: full, kind: "file", link: true });
      } catch {
        // A broken link: not an entry.
      }
    } else if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: full, kind: "dir", link: false });
    } else if (dirent.isFile()) {
      entries.push({ name: dirent.name, path: full, kind: "file", link: false });
    }
  }
  return entries;
}

/**
 * Same as `readEntriesOrNull`, with `[]` for a folder that cannot be read.
 * @param {string} dir
 * @param {string} rootReal
 * @returns {Promise<Entry[]>}
 */
export async function readEntries(dir, rootReal) {
  return (await readEntriesOrNull(dir, rootReal)) ?? [];
}

/**
 * Size and modified time of a regular file (links already checked by `readEntries`).
 * @param {string} file
 * @returns {Promise<{ size: number, modifiedMs: number } | null>} `null` when it vanished.
 */
export async function statFile(file) {
  try {
    const stat = await fsp.stat(file);
    return { size: stat.size, modifiedMs: Math.round(stat.mtimeMs) };
  } catch {
    return null;
  }
}

/**
 * The extension of a file name in lower case, without the dot (`""` when there is none).
 * @param {string} name
 * @returns {string}
 */
export function extensionOf(name) {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

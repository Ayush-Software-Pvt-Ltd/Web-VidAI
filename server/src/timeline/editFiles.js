// Writing the composition files a hand edit changes (docs/SPEC.md section 11): a B-roll with motion
// keeps its in-point and its movement in `compositions/<id>.html`, and a split makes a new file. The
// files go to disk before `index.html` does, so a root never names a file that is not there yet; when
// a later step fails, `undo()` puts every file back as it was.

import fsp from "node:fs/promises";
import path from "node:path";
import { invalidInput } from "../errors.js";
import { PROJECT_FOLDER, writeFileSafely } from "./revisionFiles.js";

/** @typedef {import("./edits.js").ProjectFile} ProjectFile */

/**
 * @param {string} projectDir
 * @param {ProjectFile[]} files `path` is `compositions/<name>` with `/`; `before` is the text the file
 *   had (null for a new file).
 * @returns {Promise<() => Promise<void>>} Puts the files back (removes the new ones); never throws.
 */
export async function writeEditFiles(projectDir, files) {
  if (files.length === 0) return async () => {};
  const folder = path.join(projectDir, PROJECT_FOLDER);
  const stat = await fsp.lstat(folder).catch(() => null);
  if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) {
    throw invalidInput(
      "The project's compositions folder is not a plain folder; nothing was changed.",
    );
  }
  await fsp.mkdir(folder, { recursive: true });
  /** @type {ProjectFile[]} */
  const written = [];
  async function undo() {
    for (const file of written.reverse()) {
      const target = path.join(projectDir, ...file.path.split("/"));
      if (file.before === null) await fsp.rm(target, { force: true }).catch(() => {});
      else await writeFileSafely(target, file.before).catch(() => {});
    }
  }
  try {
    for (const file of files) {
      await writeFileSafely(path.join(projectDir, ...file.path.split("/")), file.text);
      written.push(file);
    }
  } catch (error) {
    await undo();
    throw error;
  }
  return undo;
}

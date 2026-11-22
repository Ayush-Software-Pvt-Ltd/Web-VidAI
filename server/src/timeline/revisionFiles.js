// Files of a project that revisions keep, and the safe way to write them (docs/SPEC.md sections 10
// and 11, Revisions). A revision is a copy of `index.html`, `compositions/`, `edit.json` and
// `transcript.json`; everything else (assets, shared, links to media) is never copied or touched.
//
// Only regular files are read, copied and written: a link inside a project (the agent writes
// there, so it is not trusted) is ignored, never followed.

import { createHash, randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

/** The top-level files a revision holds, besides the `compositions/` folder. */
export const PROJECT_FILES = ["index.html", "edit.json", "transcript.json"];
/** The folder a revision holds. */
export const PROJECT_FOLDER = "compositions";

/** Names of our own temporary files; they are never copied, hashed or listed. */
const TEMP_NAME = /\.vidai-tmp-[0-9a-f]{8}$/;

/**
 * The project-relative paths (with `/`) of the regular files a revision holds that exist under
 * `dir`, sorted.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listRevisionFiles(dir) {
  /** @type {string[]} */
  const found = [];
  for (const name of PROJECT_FILES) {
    if (await isRegularFile(path.join(dir, name))) found.push(name);
  }
  /** @param {string} relative */
  async function walk(relative) {
    let entries;
    try {
      entries = await fsp.readdir(path.join(dir, ...relative.split("/")), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (TEMP_NAME.test(entry.name)) continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) found.push(child);
    }
  }
  if (await isRealFolder(path.join(dir, PROJECT_FOLDER))) await walk(PROJECT_FOLDER);
  return found.sort();
}

/** @param {string} folder A folder that is not a link. */
async function isRealFolder(folder) {
  try {
    return (await fsp.lstat(folder)).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} file */
async function isRegularFile(file) {
  try {
    return (await fsp.lstat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * A hash of what a revision would hold, to tell whether two folders have the same content.
 * @param {string} dir
 * @returns {Promise<string>}
 */
export async function fingerprint(dir) {
  const all = createHash("sha256");
  for (const relative of await listRevisionFiles(dir)) {
    let content;
    try {
      content = await fsp.readFile(path.join(dir, ...relative.split("/")));
    } catch {
      continue; // gone while we looked: the fingerprint then differs from a stable copy
    }
    all.update(relative).update("\0").update(createHash("sha256").update(content).digest());
  }
  return all.digest("hex");
}

/**
 * Copies the files a revision holds from a project into a new folder `to` (made here).
 * @param {string} from
 * @param {string} to
 */
export async function copyRevisionFiles(from, to) {
  await fsp.mkdir(to, { recursive: true });
  for (const relative of await listRevisionFiles(from)) {
    const target = path.join(to, ...relative.split("/"));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(path.join(from, ...relative.split("/")), target);
  }
}

/**
 * Writes a file so that a crash never leaves half of it: the bytes go to a temporary name in the
 * same folder, are flushed, and then replace the file in one rename. A link at `file` is replaced
 * by a regular file, never written through.
 * @param {string} file
 * @param {string | Buffer} data
 */
export async function writeFileSafely(file, data) {
  const temporary = `${file}.vidai-tmp-${randomBytes(4).toString("hex")}`;
  try {
    const handle = await fsp.open(temporary, "w");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temporary, file);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Puts the files of a revision folder into the project. Files of `compositions/` that the revision
 * does not have are removed; a top-level file the revision lacks (`transcript.json`) is left alone.
 * `index.html` is written last, so a crash in the middle never leaves a root that names graphics
 * that are not there yet.
 * @param {string} revisionDir
 * @param {string} projectDir
 */
export async function restoreRevisionFiles(revisionDir, projectDir) {
  const wanted = await listRevisionFiles(revisionDir);
  // A link in place of the folder would send the writes elsewhere: the link goes, a folder comes.
  const folder = path.join(projectDir, PROJECT_FOLDER);
  if ((await fsp.lstat(folder).catch(() => null))?.isSymbolicLink()) await fsp.rm(folder);
  const order = [
    ...wanted.filter((name) => name.startsWith(`${PROJECT_FOLDER}/`)),
    ...wanted.filter((name) => name !== "index.html" && !name.startsWith(`${PROJECT_FOLDER}/`)),
    ...wanted.filter((name) => name === "index.html"),
  ];
  for (const relative of order) {
    const target = path.join(projectDir, ...relative.split("/"));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await writeFileSafely(
      target,
      await fsp.readFile(path.join(revisionDir, ...relative.split("/"))),
    );
  }
  const keep = new Set(wanted);
  for (const relative of await listRevisionFiles(projectDir)) {
    if (relative.startsWith(`${PROJECT_FOLDER}/`) && !keep.has(relative)) {
      await fsp.rm(path.join(projectDir, ...relative.split("/")), { force: true });
    }
  }
}

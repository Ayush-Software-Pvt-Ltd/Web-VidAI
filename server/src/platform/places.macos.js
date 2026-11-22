// The macOS half of the folder picker's places (docs/SPEC.md section 6, "Folders on the server"):
// the startup volume (the root `/`, named after the link `/Volumes` keeps to it) and every other
// volume in `/Volumes`: internal and external drives and mounted network shares.
// The same code serves any other Unix-like system, where `/Volumes` simply does not exist.

import fsp from "node:fs/promises";
import path from "node:path";

/** What the startup volume is called when no link in `/Volumes` says so. */
export const DEFAULT_STARTUP_NAME = "Macintosh HD";

/**
 * Whether a folder can be listed right now.
 * @param {string} folder
 * @returns {Promise<boolean>}
 */
async function isReadable(folder) {
  try {
    await fsp.readdir(folder);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} folder
 * @returns {Promise<string | null>} The real path, or null when it cannot be resolved.
 */
const realOrNull = (folder) => fsp.realpath(folder).catch(() => null);

/**
 * The entries of the volumes folder that are folders (links to folders too), without hidden ones.
 * @param {string} volumesDir
 * @returns {Promise<string[]>}
 */
async function volumeNames(volumesDir) {
  let names;
  try {
    names = await fsp.readdir(volumesDir);
  } catch {
    return [];
  }
  /** @type {string[]} */
  const folders = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const stat = await fsp.stat(path.join(volumesDir, name)).catch(() => null);
    if (stat?.isDirectory()) folders.push(name);
  }
  return folders;
}

/**
 * The drives of a Mac: the root named after the startup volume, then each other volume.
 * @param {{ rootDir: string, volumesDir: string }} options `rootDir` is `/` and `volumesDir` is
 *   `/Volumes`; tests pass temporary folders.
 * @returns {Promise<{ name: string, path: string, kind: "drive" | "volume", available: boolean }[]>}
 */
export async function listDrives({ rootDir, volumesDir }) {
  const rootReal = (await realOrNull(rootDir)) ?? rootDir;
  /** @type {{ name: string, path: string, kind: "drive" | "volume", available: boolean }[]} */
  const volumes = [];
  let startupName = null;
  for (const name of await volumeNames(volumesDir)) {
    const entry = path.join(volumesDir, name);
    // The startup volume shows up in `/Volumes` as a link to `/`, under the name people know.
    if ((await realOrNull(entry)) === rootReal) {
      startupName ??= name;
      continue;
    }
    volumes.push({ name, path: entry, kind: "volume", available: await isReadable(entry) });
  }
  return [
    {
      name: startupName ?? DEFAULT_STARTUP_NAME,
      path: rootDir,
      kind: "drive",
      available: await isReadable(rootDir),
    },
    ...volumes,
  ];
}

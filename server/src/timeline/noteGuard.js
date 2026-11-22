// Keeps the project folder as it was while a tool that may write notes of its own runs in it
// (docs/SPEC.md section 11, Change requests: the pictures are made from the project, which is under
// revision control and profile-checked). `hyperframes snapshot` writes `.hyperframes/` into the
// project folder whatever the output folder is; whatever is new afterwards is deleted.

import fsp from "node:fs/promises";
import path from "node:path";

/**
 * The paths (relative, `/` separators) of everything below `dir`, without following links.
 * @param {string} dir
 * @returns {Promise<Set<string>>}
 */
async function listAll(dir) {
  /** @type {Set<string>} */
  const found = new Set();
  /** @param {string} folder @param {string} prefix */
  async function walk(folder, prefix) {
    let entries;
    try {
      entries = await fsp.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      found.add(relative);
      if (entry.isDirectory()) await walk(path.join(folder, entry.name), relative);
    }
  }
  await walk(dir, "");
  return found;
}

/**
 * Remembers what the folder holds now.
 * @param {string} dir
 * @returns {Promise<{ restore(): Promise<string[]> }>} `restore()` deletes what appeared since and
 *   answers the paths it deleted.
 */
export async function guardFolder(dir) {
  const before = await listAll(dir);
  return {
    async restore() {
      const after = await listAll(dir);
      const added = [...after].filter((name) => !before.has(name));
      // Delete the topmost new entries only; their contents go with them.
      const tops = added.filter((name) => !added.some((other) => name.startsWith(`${other}/`)));
      for (const name of tops) {
        await fsp.rm(path.join(dir, ...name.split("/")), { recursive: true, force: true });
      }
      return tops.sort();
    },
  };
}

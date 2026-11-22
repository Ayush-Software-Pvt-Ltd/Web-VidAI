// Reading project files for the profile check without ever leaving the project folder.

import fs from "node:fs/promises";
import path from "node:path";

/** Largest project text file read (index.html with thousands of clips is well under this). */
export const MAX_TEXT_BYTES = 32 * 1024 * 1024;

/**
 * Reads a text file of the project. The real path (links followed) must stay inside the real project
 * folder, and the file must be a regular file of a sane size.
 * @param {string} projectReal The real path of the project folder.
 * @param {string} relative Project-relative path with `/` separators.
 * @returns {Promise<{ text: string } | { problem: string }>}
 */
export async function readInside(projectReal, relative) {
  let real;
  try {
    real = await fs.realpath(path.join(projectReal, ...relative.split("/")));
  } catch {
    return { problem: "does not exist" };
  }
  const inside = path.relative(projectReal, real);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
    return { problem: "is a link that leaves the project folder" };
  }
  try {
    const stat = await fs.stat(real);
    if (!stat.isFile()) return { problem: "is not a file" };
    if (stat.size > MAX_TEXT_BYTES) return { problem: "is too large to be checked" };
    return { text: await fs.readFile(real, "utf8") };
  } catch {
    return { problem: "cannot be read" };
  }
}

/**
 * Lists the `.html` files under a project folder (project-relative, `/` separators, sorted) without
 * following links and with a cap on how many are looked at.
 * @param {string} projectReal
 * @param {string} folder Project-relative folder such as "compositions".
 * @param {number} [limit]
 * @returns {Promise<string[]>}
 */
export async function listHtmlFiles(projectReal, folder, limit = 500) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} relative */
  async function walk(relative) {
    if (found.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(path.join(projectReal, ...relative.split("/")), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) found.push(child);
    }
  }
  await walk(folder);
  return found;
}

/**
 * Whether a file reference (already known to be a relative path inside the project) names something
 * that exists, a link being followed (a link under `assets/media/` may lead out of the project). A
 * query or fragment is dropped and a percent escape is tried both ways.
 * @param {string} projectReal The real path of the project folder.
 * @param {string} value The reference as written.
 * @returns {Promise<boolean>}
 */
export async function referenceExists(projectReal, value) {
  const bare = (value.trim().split(/[?#]/)[0] ?? "").trim();
  if (bare === "") return true;
  /** @type {string[]} */
  const spellings = [bare];
  try {
    spellings.push(decodeURIComponent(bare));
  } catch {
    // a malformed escape is taken as it is
  }
  for (const spelling of spellings) {
    try {
      await fs.stat(path.join(projectReal, ...spelling.split("/")));
      return true;
    } catch {
      // try the next spelling
    }
  }
  return false;
}

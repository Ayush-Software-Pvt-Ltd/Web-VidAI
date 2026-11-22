// Installing and upgrading the toolkit (docs/SPEC.md section 7): build next to the target and swap, never lose the agents'
// `MEMORY.md`, write the version marker last.
//
// What is copied from the repository's `toolkit/`: `CLAUDE_VE_ALL/` (never `__pycache__`, `*.pyc`)
// and `CLAUDE.md`; `MEMORY.md` only when the installed one is missing; `VERSION` last. `tests/`
// and `default_prompt.md` stay in the repository.
//
// Order, and why a crash at any point is safe:
//
//  1. Temporary names left by a crash (`.<name>.new-*`) are removed.
//  2. A crash between the two renames of the swap leaves `CLAUDE_VE_ALL` missing and the old one
//     as `CLAUDE_VE_ALL.previous`: it is put back first, so the old toolkit is usable again even
//     when the new one cannot be finished.
//  3. `CLAUDE_VE_ALL` is built as `.CLAUDE_VE_ALL.new-<id>`; `CLAUDE_VE_ALL.previous` is removed,
//     `CLAUDE_VE_ALL` renamed to `.previous`, the new one renamed to `CLAUDE_VE_ALL`. At every
//     moment one of them is complete.
//  4. `CLAUDE.md` is replaced by writing a temporary file and renaming it over.
//  5. `MEMORY.md` is created (temporary file, then rename) only when missing.
//  6. `VERSION` is written last, the same way. Until then the next start does the job again;
//     when `CLAUDE_VE_ALL` already equals the shipped one (a crash after step 3), step 3 is
//     skipped by comparing a digest of the contents, so the old copy in `.previous` is not
//     replaced by a copy of the new one.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The file operations the install uses; tests replace single ones to fail at a chosen moment.
 * @typedef {object} InstallFs
 * @property {(file: string) => boolean} exists
 * @property {(file: string) => string} readText
 * @property {(file: string, text: string) => void} writeText
 * @property {(from: string, to: string, filter: (source: string) => boolean) => void} copyTree
 * @property {(from: string, to: string) => void} rename
 * @property {(target: string) => void} remove
 * @property {(dir: string) => void} mkdir
 * @property {(dir: string) => string[]} list
 */

/** @type {InstallFs} */
export const realFs = {
  exists: (file) => fs.existsSync(file),
  readText: (file) => fs.readFileSync(file, "utf8"),
  writeText: (file, text) => fs.writeFileSync(file, text),
  copyTree: (from, to, filter) =>
    // Links are followed: the toolkit is plain files, and a link cannot be made on every Windows.
    fs.cpSync(from, to, { recursive: true, dereference: true, filter }),
  rename: (from, to) => fs.renameSync(from, to),
  remove: (target) =>
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  mkdir: (dir) => void fs.mkdirSync(dir, { recursive: true }),
  list: (dir) => fs.readdirSync(dir),
};

/** Names that are never part of the toolkit. */
const SKIPPED = new Set(["__pycache__", ".DS_Store", ".pytest_cache", ".mypy_cache"]);

/**
 * Whether a path of the source belongs in the install.
 * @param {string} source
 * @returns {boolean}
 */
export function isShipped(source) {
  const name = path.basename(source);
  return !SKIPPED.has(name) && !name.endsWith(".pyc");
}

/**
 * A digest of a folder's shipped contents (names and bytes), `null` when it does not exist.
 * @param {string} dir
 * @returns {string | null}
 */
export function treeDigest(dir) {
  if (!fs.existsSync(dir)) return null;
  const hash = crypto.createHash("sha256");
  /** @param {string} current @param {string} rel */
  const walk = (current, rel) => {
    const names = fs.readdirSync(current).sort();
    for (const name of names) {
      const full = path.join(current, name);
      if (!isShipped(full)) continue;
      const here = rel === "" ? name : `${rel}/${name}`;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        hash.update(`d\0${here}\0`);
        walk(full, here);
      } else {
        hash.update(`f\0${here}\0${stat.size}\0`);
        hash.update(fs.readFileSync(full));
      }
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

/**
 * The hash of a requirements file, with line endings normalised so a Windows checkout and a Mac
 * checkout agree. `null` when the file is missing.
 * @param {string} file
 * @returns {string | null}
 */
export function requirementsHash(file) {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    return crypto.createHash("sha256").update(text).digest("hex");
  } catch {
    return null;
  }
}

/**
 * The text of a version file, trimmed; `null` when missing or empty.
 * @param {string} file
 * @param {InstallFs} [ops]
 * @returns {string | null}
 */
export function readVersion(file, ops = realFs) {
  try {
    const text = ops.readText(file).trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/**
 * @typedef {object} InstallOptions
 * @property {string} source The repository's `toolkit/` folder.
 * @property {string} target `<data dir>/toolkit`.
 * @property {Partial<InstallFs>} [fs] Replaces file operations (tests).
 * @property {() => string} [newId] Suffix of temporary names (tests make it fixed).
 *
 * @typedef {object} InstallResult
 * @property {"installed" | "upgraded" | "current" | "repaired"} action `repaired`: the version
 *   was right but a part was missing or an earlier install was interrupted.
 * @property {string | null} from The version that was installed before.
 * @property {string} to The shipped version.
 * @property {boolean} swapped `CLAUDE_VE_ALL` was replaced.
 * @property {boolean} keptPrevious The old `CLAUDE_VE_ALL` is now `CLAUDE_VE_ALL.previous`.
 */

/**
 * Brings the installed toolkit to the shipped version (SPEC section 7). Throws a plain `Error`
 * with a sentence when it cannot; the old toolkit stays usable then.
 * @param {InstallOptions} options
 * @returns {InstallResult}
 */
export function installToolkit({ source, target, fs: override = {}, newId = randomId }) {
  /** @type {InstallFs} */
  const ops = { ...realFs, ...override };
  const shippedVersion = readVersion(path.join(source, "VERSION"), ops);
  const shippedFolder = path.join(source, "CLAUDE_VE_ALL");
  if (shippedVersion === null || !ops.exists(path.join(shippedFolder, "ve.py"))) {
    throw new Error(
      `The toolkit that comes with this server is missing or incomplete (looked in ${source}), so it cannot be installed.`,
    );
  }
  const folder = path.join(target, "CLAUDE_VE_ALL");
  const previous = path.join(target, "CLAUDE_VE_ALL.previous");
  const claudeMd = path.join(target, "CLAUDE.md");
  const memory = path.join(target, "MEMORY.md");
  const versionFile = path.join(target, "VERSION");
  const id = newId();

  ops.mkdir(target);

  // 1. Leftovers of a crash.
  for (const name of ops.list(target)) {
    if (name.startsWith(".") && name.includes(".new-")) ops.remove(path.join(target, name));
  }

  // 2. A crash between the two renames of a swap.
  let restored = false;
  if (!ops.exists(folder) && ops.exists(previous)) {
    ops.rename(previous, folder);
    restored = true;
  }

  const installed = readVersion(versionFile, ops);
  const complete = ops.exists(path.join(folder, "ve.py")) && ops.exists(claudeMd);
  if (installed === shippedVersion && complete && !restored) {
    if (!ops.exists(memory)) writeAtomic(ops, memory, readMemorySource(ops, source), id);
    return { action: "current", from: installed, to: shippedVersion, swapped: false, keptPrevious: false };
  }

  // 3. The programs: build next to the target, then swap.
  let swapped = false;
  let keptPrevious = false;
  if (restored || treeDigest(folder) !== treeDigest(shippedFolder)) {
    const fresh = path.join(target, `.CLAUDE_VE_ALL.new-${id}`);
    ops.remove(fresh);
    ops.copyTree(shippedFolder, fresh, isShipped);
    if (!ops.exists(path.join(fresh, "ve.py"))) {
      ops.remove(fresh);
      throw new Error("Copying the toolkit did not finish, so the installed one was left alone.");
    }
    if (ops.exists(folder)) {
      ops.remove(previous);
      ops.rename(folder, previous);
      keptPrevious = true;
    }
    ops.rename(fresh, folder);
    swapped = true;
  }

  // 4. The short rules, 5. the lessons (only when missing), 6. the marker.
  writeAtomic(ops, claudeMd, ops.readText(path.join(source, "CLAUDE.md")), id);
  if (!ops.exists(memory)) writeAtomic(ops, memory, readMemorySource(ops, source), id);
  writeAtomic(ops, versionFile, `${shippedVersion}\n`, id);

  /** @type {InstallResult["action"]} */
  const action = installed === null ? "installed" : installed === shippedVersion ? "repaired" : "upgraded";
  return { action, from: installed, to: shippedVersion, swapped, keptPrevious };
}

/**
 * The first content of `MEMORY.md`: the shipped file, or an empty heading when there is none.
 * @param {InstallFs} ops
 * @param {string} source
 * @returns {string}
 */
function readMemorySource(ops, source) {
  const file = path.join(source, "MEMORY.md");
  return ops.exists(file) ? ops.readText(file) : "# Lessons\n";
}

/**
 * Writes a file so it appears whole or not at all: a temporary file next to it, renamed over.
 * @param {InstallFs} ops
 * @param {string} file
 * @param {string} text
 * @param {string} id
 */
function writeAtomic(ops, file, text, id) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.new-${id}`);
  ops.writeText(temp, text);
  ops.rename(temp, file);
}

/** @returns {string} */
function randomId() {
  return crypto.randomBytes(4).toString("hex");
}

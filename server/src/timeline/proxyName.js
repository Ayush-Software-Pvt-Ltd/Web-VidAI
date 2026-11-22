// Names of preview copies (docs/SPEC.md section 11, Preview copies, and section 2: `cache/proxy/`).
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * The name (without extension) of the copy of a file: the SHA-256 of its real path, size and
 * modification time, in hex. A replaced original has another size or time, so it gets another name
 * and the old copy stops matching.
 * @param {string} realPath
 * @param {number} size Bytes.
 * @param {number} mtimeMs
 * @returns {string}
 */
export function proxyName(realPath, size, mtimeMs) {
  return createHash("sha256").update(`${realPath}\0${size}\0${mtimeMs}`).digest("hex");
}

/** @param {string} dir @param {string} name @returns {string} The finished copy. */
export function copyFile(dir, name) {
  return path.join(dir, `${name}.mp4`);
}

/** @param {string} dir @param {string} name @returns {string} What was learned about the file. */
export function factsFile(dir, name) {
  return path.join(dir, `${name}.json`);
}

/**
 * Where a copy is written until it is complete. Every start deletes what is left under this
 * extension.
 * @param {string} dir
 * @param {string} name
 * @returns {string}
 */
export function partFile(dir, name) {
  return path.join(dir, `${name}.part`);
}

/** The extension of unfinished copies. */
export const PART_EXTENSION = ".part";

/**
 * The name of a finished copy from its file name, or null for anything else.
 * @param {string} fileName
 * @returns {string | null}
 */
export function nameOfCopy(fileName) {
  const match = /^([0-9a-f]{64})\.mp4$/.exec(fileName);
  return match?.[1] ?? null;
}

/**
 * The name of a facts file from its file name, or null for anything else.
 * @param {string} fileName
 * @returns {string | null}
 */
export function nameOfFacts(fileName) {
  const match = /^([0-9a-f]{64})\.json$/.exec(fileName);
  return match?.[1] ?? null;
}

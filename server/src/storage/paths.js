// Path safety (docs/SPEC.md section 6, "Storage folders and path safety"): every path a user gives
// is resolved to its real path, links followed, and must lie inside a storage folder, otherwise
// `forbidden`. Nothing else in the server joins a user's text to a folder without going through
// `resolveInside` (or `resolveFor`) and `safeName`.
//
// The checks that need a file system are in `createPathGuard`; `isInside`, `isSame` and `safeName`
// are pure and take the platform, so the Windows and macOS rules are tested on any computer.

import fsp from "node:fs/promises";
import { AppError, forbidden, invalidInput } from "../errors.js";
import {
  foldName,
  hasDotDot,
  isFullPath,
  nameProblem,
  pathApi,
  pathSegments,
  segmentProblem,
  withoutNamespacePrefix,
} from "../platform/fsnames.js";
import { USER_ID_PATTERN } from "./roots.js";

/** The one sentence for every refused place, so an answer never tells which rule it was. */
export const OUTSIDE_MESSAGE = "This folder is outside the storage folders the admin allows.";

/**
 * Whether `child` is `parent` or lies inside it. Both must be full paths (`/x`, `C:\x`,
 * `\\server\share\x`); anything else is not inside. Letter case is ignored where the file system
 * ignores it (Windows, macOS), separators and trailing separators do not matter, `..` is resolved
 * lexically (callers refuse links and `..` before they ask), and a folder whose name only starts
 * like the parent's (`/data/media2` against `/data/media`) is not inside.
 * @param {string} parent
 * @param {string} child
 * @param {string} [platform]
 * @returns {boolean}
 */
export function isInside(parent, child, platform = process.platform) {
  if (typeof parent !== "string" || typeof child !== "string") return false;
  if (parent.includes("\0") || child.includes("\0")) return false;
  if (!isFullPath(parent, platform) || !isFullPath(child, platform)) return false;
  const api = pathApi(platform);
  const from = api.resolve(withoutNamespacePrefix(parent, platform));
  const to = api.resolve(withoutNamespacePrefix(child, platform));
  // `path.win32.relative` already ignores case and tells different drives and shares apart.
  const relative =
    platform === "win32"
      ? api.relative(from, to)
      : api.relative(foldName(from, platform), foldName(to, platform));
  if (relative === "") return true;
  if (api.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${api.sep}`);
}

/**
 * Whether two paths name the same place (by the rules of `isInside`).
 * @param {string} a
 * @param {string} b
 * @param {string} [platform]
 */
export function isSame(a, b, platform = process.platform) {
  return isInside(a, b, platform) && isInside(b, a, platform);
}

/**
 * Checks a name that VidAI will use for a folder or file: one path segment, no separators, no
 * leading dot, not `.` or `..`, no control characters, nothing Windows forbids (on Windows), not
 * too long.
 * @param {unknown} name
 * @param {{ platform?: string, maxChars?: number }} [options] `maxChars` defaults to 200.
 * @returns {string} The name, unchanged.
 * @throws {AppError} `invalidInput` with a sentence that says what is wrong.
 */
export function safeName(name, options = {}) {
  if (typeof name !== "string") throw invalidInput("A name must be text.");
  const problem = nameProblem(name, options);
  if (problem) throw invalidInput(problem);
  return name;
}

/** @param {unknown} error */
const codeOf = (error) => /** @type {{ code?: string }} */ (error).code;

/**
 * Whether two `stat` results (with `bigint`) are the same file. A file system with no ids is trusted.
 * @param {import("node:fs").BigIntStats} a
 * @param {import("node:fs").BigIntStats} b
 */
function sameIdentity(a, b) {
  if (a.ino === 0n && b.ino === 0n) return true;
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * @param {{
 *   roots: { realPaths(): Promise<string[]>, mediaPath(): Promise<string> },
 *   platform?: string,
 * }} deps
 */
export function createPathGuard({ roots, platform = process.platform }) {
  const api = pathApi(platform);

  /**
   * The real path of `input`, which need not exist: the real path of the deepest existing
   * ancestor plus the names after it, which must be plain names.
   * @param {unknown} input
   * @returns {Promise<string>}
   */
  async function realPathOf(input) {
    if (typeof input !== "string") throw invalidInput("A folder path must be text.");
    if (input.includes("\0")) throw invalidInput("A folder path cannot contain a NUL character.");
    if (!isFullPath(input, platform)) {
      throw invalidInput("Give the full path of the folder, starting at the top of the disk.");
    }
    // `..` is refused, not resolved: with links the system resolves it differently from text.
    if (hasDotDot(input, platform)) throw forbidden(OUTSIDE_MESSAGE);

    let current = api.resolve(withoutNamespacePrefix(input, platform));
    /** @type {string[]} */
    const tail = [];
    for (;;) {
      try {
        const real = withoutNamespacePrefix(await fsp.realpath(current), platform);
        for (const name of tail) {
          const problem = segmentProblem(name, platform);
          if (problem) throw invalidInput(problem);
        }
        return tail.length > 0 ? api.join(real, ...tail) : real;
      } catch (error) {
        if (error instanceof AppError) throw error;
        const code = codeOf(error);
        if (code === "ELOOP") throw forbidden(OUTSIDE_MESSAGE);
        if (code === "ENAMETOOLONG") throw invalidInput("A name in this path is too long.");
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          throw new AppError("io", "The server cannot open this folder.", { cause: error });
        }
        // A link that points nowhere also "does not exist"; creating through it would create
        // wherever it points, so it is refused.
        const isLink = await fsp.lstat(current).then(
          () => true,
          () => false,
        );
        if (isLink) throw forbidden(OUTSIDE_MESSAGE);
        const parent = api.dirname(current);
        if (parent === current) throw forbidden(OUTSIDE_MESSAGE);
        tail.unshift(api.basename(current));
        current = parent;
      }
    }
  }

  /**
   * Whether the first `count` names of `real` are the same folder as `root`, by file identity,
   * so that `/data/MEDIA` is not mistaken for `/data/media` on a case-sensitive disk.
   * @param {string} root
   * @param {string} real
   */
  async function sameFolderAsRoot(root, real) {
    let prefix = real;
    const depth = pathSegments(root, platform).length;
    while (pathSegments(prefix, platform).length > depth) prefix = api.dirname(prefix);
    try {
      const [a, b] = await Promise.all([
        fsp.stat(root, { bigint: true }),
        fsp.stat(prefix, { bigint: true }),
      ]);
      return sameIdentity(a, b);
    } catch {
      return false;
    }
  }

  const guard = {
    /**
     * The real path of a path a user gave, which must lie inside a storage folder (or be one).
     * @param {unknown} input An absolute path; it may be one that does not exist yet.
     * @returns {Promise<string>} The real path.
     * @throws {AppError} `invalidInput` for text that is not a full path, `forbidden` for a place
     *   outside the storage folders.
     */
    async resolveInside(input) {
      const real = await realPathOf(input);
      if (!(await guard.rootOf(real))) throw forbidden(OUTSIDE_MESSAGE);
      return real;
    },

    /**
     * `resolveInside` for one user: a personal folder of another account is refused too.
     * @param {unknown} input
     * @param {string} userId
     * @returns {Promise<string>}
     */
    async resolveFor(input, userId) {
      const real = await guard.resolveInside(input);
      await guard.assertNotPrivateToOthers(real, userId);
      return real;
    },

    /**
     * @param {string} real A real path.
     * @param {string} userId
     * @throws {AppError} `forbidden` inside `<data dir>/media/<another user's id>/`. The answer
     *   does not say whose it is.
     */
    async assertNotPrivateToOthers(real, userId) {
      const media = await roots.mediaPath();
      if (!isInside(media, real, platform) || isSame(media, real, platform)) return;
      const first = pathSegments(api.relative(media, real), platform)[0] ?? "";
      if (USER_ID_PATTERN.test(first) && first !== userId) {
        throw forbidden("You do not have access to this folder.");
      }
    },

    /**
     * The storage folder (real path) a real path lies in, or null.
     * @param {string} real
     * @returns {Promise<string | null>}
     */
    async rootOf(real) {
      for (const root of await roots.realPaths()) {
        if (isInside(root, real, platform) && (await sameFolderAsRoot(root, real))) return root;
      }
      return null;
    },

    /**
     * @param {string} parent
     * @param {string} child
     */
    isInside: (parent, child) => isInside(parent, child, platform),

    /**
     * @param {string} a
     * @param {string} b
     */
    isSame: (a, b) => isSame(a, b, platform),

    /**
     * @param {unknown} name
     * @param {{ maxChars?: number }} [options]
     */
    safeName: (name, options) => safeName(name, { platform, ...options }),
  };
  return guard;
}

/** @typedef {ReturnType<typeof createPathGuard>} PathGuard */

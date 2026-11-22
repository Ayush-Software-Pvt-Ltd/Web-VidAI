// Path safety (docs/SPEC.md section 6, "Folders on the server"): every path the admin gives is
// resolved to its real path, links followed, before it is checked or stored. Users never send a
// path. Nothing else in the server joins text to a folder without going through `safeName`.
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
  segmentProblem,
  withoutNamespacePrefix,
} from "../platform/fsnames.js";

/** The sentence for a path that is refused outright: a `..` in it, or a link that loops or leads nowhere. */
export const REFUSED_MESSAGE = "This path cannot be used.";

/** Said when a folder is, holds or lies inside the channel directory of a channel. */
export const TAKEN_MESSAGE = "This folder already belongs to a channel.";

/** The sentence for a folder that is, holds or lies inside the server's data directory. */
export const DATA_DIR_MESSAGE = "This folder belongs to VidAI's own data.";

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
 * @param {{
 *   dataDir: string,
 *   platform?: string,
 * }} deps
 */
export function createPathGuard({ dataDir, platform = process.platform }) {
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
    if (hasDotDot(input, platform)) throw forbidden(REFUSED_MESSAGE);

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
        if (code === "ELOOP") throw forbidden(REFUSED_MESSAGE);
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
        if (isLink) throw forbidden(REFUSED_MESSAGE);
        const parent = api.dirname(current);
        if (parent === current) throw forbidden(REFUSED_MESSAGE);
        tail.unshift(api.basename(current));
        current = parent;
      }
    }
  }

  const guard = {
    /**
     * The real path of a path the admin gave. Where it may lie is the caller's rule (a channel
     * directory: `checkChannelDir`; a folder to make: `fsCreateFolder`).
     * @param {unknown} input An absolute path; it may be one that does not exist yet.
     * @returns {Promise<string>} The real path.
     * @throws {AppError} `invalidInput` for text that is not a full path, `forbidden` for a path
     *   with `..` in it or a link that loops or leads nowhere.
     */
    resolve: realPathOf,

    /** The real path of the data directory. @returns {Promise<string>} */
    dataPath: () => fsp.realpath(dataDir),

    /**
     * Whether a real path is, holds or lies inside the data directory.
     * @param {string} real
     * @returns {Promise<boolean>}
     */
    async touchesData(real) {
      const data = await guard.dataPath();
      return isInside(data, real, platform) || isInside(real, data, platform);
    },

    /**
     * Whether a real path is the data directory or lies inside it.
     * @param {string} real
     * @returns {Promise<boolean>}
     */
    async insideData(real) {
      return isInside(await guard.dataPath(), real, platform);
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

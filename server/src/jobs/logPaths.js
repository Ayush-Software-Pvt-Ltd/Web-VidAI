// Shortening absolute paths in one-line summaries (docs/SPEC.md section 8, "The job log").
//
// A path inside the video folder is shown relative to it (`CLAUDE_VE/timeline.py`), any other
// path inside one of the other known folders relative to that (`Other Video/CLAUDE_VE/notes.md`,
// `CLAUDE_VE_ALL/tools/cut.py`). Only whole path prefixes are replaced, so `/a/Edits 2/x` stays
// as it is for `/a/Edits`. `detail` of a log entry keeps the original text.

/**
 * @typedef {object} Paths
 * @property {(text: string) => string} shorten `text` with every known folder prefix of an
 *   absolute path removed.
 */

/** No shortening (tests, lines without a known folder). */
export function noPaths() {
  return createPaths([], { windows: false });
}

/**
 * The folder prefixes of one job. `windows` says how Claude Code and its tools write paths: on
 * Windows as `C:\Users\...`, `C:/Users/...` or, in Git Bash, `/c/Users/...`, in any letter case,
 * so each folder is matched in all of these forms; elsewhere as absolute `/` paths, matched
 * exactly. A drive root, the root or a relative path would match far too much and is ignored.
 * @param {readonly string[]} folders Absolute folders, the most specific first (the video
 *   folder, then the channel folder, the workspace and so on): the first prefix that matches
 *   a path wins, so a path in the video folder is shown relative to it.
 * @param {{ windows: boolean }} options
 * @returns {Paths}
 */
export function createPaths(folders, { windows }) {
  const prefixes = windows ? windowsPrefixes(folders) : unixPrefixes(folders);
  return {
    shorten(text) {
      let out = text;
      for (const prefix of prefixes) {
        out = windows
          ? stripFoldedPrefixEverywhere(out, prefix)
          : out.includes(prefix)
            ? stripPrefixEverywhere(out, prefix)
            : out;
      }
      return out;
    },
  };
}

/**
 * @param {readonly string[]} folders
 * @returns {string[]}
 */
function unixPrefixes(folders) {
  /** @type {string[]} */
  const out = [];
  for (const folder of folders) {
    const dir = folder.replace(/\/+$/, "");
    if (dir.startsWith("/") && dir.length > 1) out.push(`${dir}/`);
  }
  return out;
}

/**
 * Lower case for ASCII letters only: other letters keep their length.
 * @param {string} text
 * @returns {string}
 */
function asciiLower(text) {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * @param {readonly string[]} folders
 * @returns {string[]}
 */
function windowsPrefixes(folders) {
  /** @type {string[]} */
  const out = [];
  for (const folder of folders) {
    const dir = asciiLower(folder.replace(/^\\\\\?\\/, "").replaceAll("\\", "/")).replace(
      /\/+$/,
      "",
    );
    const match = /^([a-z]):\//.exec(dir);
    // Not a drive path, or the drive root itself.
    if (match === null || dir.length <= 3) continue;
    out.push(`${dir}/`);
    out.push(`/${match[1]}${dir.slice(2)}/`);
  }
  return out;
}

/** A character as Windows compares paths: ASCII letters without case, `\` as `/`.
 * @param {string} c
 */
function fold(c) {
  return c === "\\" ? "/" : asciiLower(c);
}

/**
 * Characters that may be part of a path right before a folder prefix: when one precedes the
 * prefix, the match is the middle of another path (for example `/private/Users/...`).
 * @param {string} c
 * @returns {boolean}
 */
function isPathChar(c) {
  return /[\p{L}\p{N}]/u.test(c) || "/._-~\\".includes(c);
}

/**
 * Something follows the prefix that can name a file or folder (not a space or a closing quote).
 * @param {string | undefined} c
 * @returns {boolean}
 */
function namesSomething(c) {
  return c !== undefined && !/\s/u.test(c) && !"\"'`)".includes(c);
}

/**
 * The last character (code point) of `text`.
 * @param {string} text
 * @returns {string | undefined}
 */
function lastChar(text) {
  if (text === "") return undefined;
  const chars = text.slice(-2);
  const code = chars.codePointAt(0);
  return code !== undefined && code > 0xffff ? chars : text.slice(-1);
}

/**
 * Removes `prefix` (ending with `/`) where it starts a path and something follows it.
 * @param {string} text
 * @param {string} prefix
 * @returns {string}
 */
function stripPrefixEverywhere(text, prefix) {
  let out = "";
  let rest = text;
  /** @type {string | undefined} */
  let prev;
  for (let i = rest.indexOf(prefix); i >= 0; i = rest.indexOf(prefix)) {
    const before = rest.slice(0, i);
    const after = rest.slice(i + prefix.length);
    const last = lastChar(before) ?? prev;
    const startsPath = last === undefined || !isPathChar(last);
    const next =
      after === "" ? undefined : String.fromCodePoint(/** @type {number} */ (after.codePointAt(0)));
    out += before;
    if (!(startsPath && namesSomething(next))) out += prefix;
    prev = "/";
    rest = after;
  }
  return out + rest;
}

/**
 * `stripPrefixEverywhere` for a folded `prefix` (lower case, `/` separators), matching ignoring
 * letter case and with either separator.
 * @param {string} text
 * @param {string} prefix
 * @returns {string}
 */
function stripFoldedPrefixEverywhere(text, prefix) {
  const chars = Array.from(text);
  const wanted = Array.from(prefix);
  let out = "";
  let i = 0;
  /** @type {string | undefined} */
  let prev;
  while (i < chars.length) {
    const matches =
      chars.length - i >= wanted.length && wanted.every((w, k) => w === fold(chars[i + k] ?? ""));
    if (matches) {
      const after = chars[i + wanted.length];
      const startsPath = prev === undefined || !isPathChar(prev);
      if (startsPath && namesSomething(after)) {
        i += wanted.length;
        prev = "/";
        continue;
      }
    }
    const c = /** @type {string} */ (chars[i]);
    out += c;
    prev = c;
    i += 1;
  }
  return out;
}

// What differs between file systems when a user gives a path or a name (docs/SPEC.md section 6,
// "Storage folders and path safety"). Every function takes the platform as a parameter, with the
// running one as default, so the Windows rules are unit tested on a Mac. No other module tests
// `process.platform` for these rules.

import path from "node:path";

/** @typedef {"win32" | "darwin" | "linux" | string} Platform */

/**
 * The `node:path` flavour of a platform.
 * @param {Platform} [platform]
 */
export function pathApi(platform = process.platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Whether names that differ only in letter case are the same file. True for Windows and for macOS
 * (its default volumes); a Mac volume formatted case-sensitively is then treated too strictly,
 * which can only refuse more, never allow more (storage/paths.js also compares file identity).
 * @param {Platform} [platform]
 */
export function isCaseInsensitive(platform = process.platform) {
  return platform === "win32" || platform === "darwin";
}

/**
 * A name or path in the form used to compare two of them: letter case folded where the file system
 * folds it, and Unicode normalised on macOS and Windows where `e` + accent and `é` are the same.
 * @param {string} text
 * @param {Platform} [platform]
 */
export function foldName(text, platform = process.platform) {
  return isCaseInsensitive(platform) ? text.normalize("NFC").toLowerCase() : text;
}

/**
 * Windows spells a path in the `\\?\C:\x` or `\\?\UNC\server\share\x` form sometimes; this gives
 * the ordinary spelling. Other platforms are unchanged.
 * @param {string} value
 * @param {Platform} [platform]
 */
export function withoutNamespacePrefix(value, platform = process.platform) {
  if (platform !== "win32") return value;
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:/.test(value)) return value.slice(4);
  return value;
}

/**
 * A full path a user may give: `/x` on macOS and Linux, `C:\x` or `C:/x` or `\\server\share\x` on
 * Windows. A path that is relative, relative to a drive (`C:x`), rooted without a drive (`\x`) or a
 * device path (`\\.\x`, `\\?\x`) is not.
 * @param {string} value
 * @param {Platform} [platform]
 */
export function isFullPath(value, platform = process.platform) {
  if (platform !== "win32") return value.startsWith("/");
  const plain = withoutNamespacePrefix(value, platform);
  if (/^[A-Za-z]:[\\/]/.test(plain)) return true;
  return /^\\\\[^\\/?.][^\\/]*\\+[^\\/]+/.test(plain.replaceAll("/", "\\"));
}

/**
 * The names between the separators of a full path, empty parts left out (`/a//b/` is `a`, `b`).
 * Does not resolve `..`; the caller refuses it with `hasDotDot`.
 * @param {string} value
 * @param {Platform} [platform]
 * @returns {string[]}
 */
export function pathSegments(value, platform = process.platform) {
  const separators = platform === "win32" ? /[\\/]+/ : /\/+/;
  return withoutNamespacePrefix(value, platform)
    .split(separators)
    .filter((part) => part !== "");
}

/**
 * Whether any part of the path is `..`; on Windows also parts that are only dots (`...`), which the
 * system reads as the same thing or as nothing.
 * @param {string} value
 * @param {Platform} [platform]
 */
export function hasDotDot(value, platform = process.platform) {
  return pathSegments(value, platform).some((part) =>
    platform === "win32" ? part !== "." && /^[. ]+$/.test(part) : part === "..",
  );
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Right-to-left overrides and isolates make "evil\u202Efdp.mp4" look like "evilmp4.pdf".
const BIDI = /[\u202a-\u202e\u2066-\u2069]/;
const WINDOWS_FORBIDDEN = /[<>:"|?*]/;
// Device names stay reserved with an extension (`NUL.txt`); the superscript digits count too.
const WINDOWS_DEVICE =
  /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;

/**
 * Whether Windows reserves `name` for a device (`CON`, `NUL.txt`, `LPT1`...), on any system: a file
 * that is uploaded here may be opened on a Windows computer later.
 * @param {string} name
 */
export function isWindowsDeviceName(name) {
  return WINDOWS_DEVICE.test(name);
}

/** The longest name, in bytes of UTF-8; leaves room for the hidden `.<name>.<id>.part` of an upload. */
export const MAX_NAME_BYTES = 200;

/**
 * Why `name` cannot be one step of a path, or `null` when it is a plain name: not empty, not `.`
 * or `..`, no separators, no control characters and, on Windows, none of the characters, device
 * names and endings that system does not allow. This is the check for names a user typed that
 * will be joined to a folder; it does not say whether the name is a good one (`nameProblem`).
 * @param {string} name
 * @param {Platform} [platform]
 * @returns {string | null} A sentence for the user.
 */
export function segmentProblem(name, platform = process.platform) {
  if (name === "") return "A name cannot be empty.";
  if (name === "." || name === "..") return 'A name cannot be "." or "..".';
  if (name.includes("/") || name.includes("\\")) return "A name cannot contain a slash.";
  if (CONTROL.test(name)) return "A name cannot contain control characters.";
  if (platform === "win32") {
    if (WINDOWS_FORBIDDEN.test(name)) {
      return 'A name cannot contain any of < > : " | ? * on this computer.';
    }
    if (/[. ]$/.test(name)) return "A name cannot end with a dot or a space on this computer.";
    if (WINDOWS_DEVICE.test(name)) return "This name is reserved by Windows.";
  }
  return null;
}

/**
 * Why `name` is not a good name for a folder or file VidAI makes, or `null`: a plain name
 * (`segmentProblem`) that also does not start with a dot (hidden), has no space at either end, no
 * direction-changing characters and is not longer than `maxChars` characters and `MAX_NAME_BYTES`.
 * @param {string} name
 * @param {{ platform?: Platform, maxChars?: number }} [options]
 * @returns {string | null} A sentence for the user.
 */
export function nameProblem(name, { platform = process.platform, maxChars = 200 } = {}) {
  const segment = segmentProblem(name, platform);
  if (segment) return segment;
  if (name.startsWith(".")) return "A name cannot start with a dot.";
  if (name !== name.trim()) return "A name cannot start or end with a space.";
  if (BIDI.test(name)) return "A name cannot contain characters that change the text direction.";
  if ([...name].length > maxChars) return `A name can have at most ${maxChars} characters.`;
  if (Buffer.byteLength(name, "utf8") > MAX_NAME_BYTES) return "That name is too long.";
  return null;
}

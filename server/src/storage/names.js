// Folder naming rules (docs/SPEC.md section 6, "Videos"): reserved names inside a channel, the B-roll folder and the natural
// order of names, and the rule for the name of an uploaded file. Shared by uploads, the file routes
// and the library.

import { invalidInput } from "../errors.js";
import { isWindowsDeviceName, nameProblem } from "../platform/fsnames.js";

const CHANNEL_ASSET_FOLDERS = [
  "upload",
  "style",
  "sample",
  "samples",
  "images",
  "pictures",
  "host images",
  "host pictures",
];

/**
 * A name inside a channel directory that is never a video: hidden names, names starting with
 * `CLAUDE_VE`, the channel's `upload` folder and the asset folders (compared ignoring case).
 * @param {string} name
 */
export function isReservedChannelEntry(name) {
  return (
    name.startsWith(".") ||
    name.startsWith("CLAUDE_VE") ||
    CHANNEL_ASSET_FOLDERS.includes(name.toLowerCase())
  );
}

/**
 * `b-roll`, `B_Rolls`, `broll`, `B Roll` and so on: `^b[-_ ]?rolls?$` ignoring case.
 * @param {string} name
 */
export function isBrollName(name) {
  return /^b[-_ ]?rolls?$/i.test(name);
}

/** The name of the B-roll folder when a video has none. */
export const DEFAULT_BROLL_NAME = "Broll";

/**
 * The B-roll folder of a video: the first matching subfolder in natural order, else `Broll`.
 * @param {readonly string[]} subfolders
 */
export function brollFolderName(subfolders) {
  const matching = subfolders.filter(isBrollName).sort(naturalCompare);
  return matching[0] ?? DEFAULT_BROLL_NAME;
}

/** @param {string} text */
function chunksOf(text) {
  return text.match(/\d+|\D+/g) ?? [];
}

/**
 * Natural order: runs of digits compare as numbers, letters without regard to case, digits before
 * letters, and equal looking names fall back to plain comparison so the order is total.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function naturalCompare(a, b) {
  const left = chunksOf(a);
  const right = chunksOf(b);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const x = left[index] ?? "";
    const y = right[index] ?? "";
    const xDigits = /^\d/.test(x);
    const yDigits = /^\d/.test(y);
    /** @type {number} */
    let order;
    if (xDigits && yDigits) {
      const tx = x.replace(/^0+/, "");
      const ty = y.replace(/^0+/, "");
      order = tx.length - ty.length || (tx < ty ? -1 : tx > ty ? 1 : 0);
    } else if (xDigits) {
      order = -1;
    } else if (yDigits) {
      order = 1;
    } else {
      const lx = x.toLowerCase();
      const ly = y.toLowerCase();
      order = lx < ly ? -1 : lx > ly ? 1 : 0;
    }
    if (order !== 0) return order < 0 ? -1 : 1;
  }
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Why `name` is not an allowed name for an uploaded file, or `null` (docs/SPEC.md section 6,
 * "Uploads"): 1 to 200 characters, no path separators, no control characters, no leading dot, no
 * trailing dot or space, and not a name Windows reserves (`CON`, `LPT1`...). The last two rules
 * hold on every system, so a file put in a folder on a Mac can be opened on a Windows computer.
 * @param {string} name
 * @param {string} [platform]
 * @returns {string | null} A sentence for the user.
 */
export function uploadNameProblem(name, platform = process.platform) {
  const problem = nameProblem(name, { platform });
  if (problem) return problem;
  if (name.endsWith(".")) return "A file name cannot end with a dot.";
  if (isWindowsDeviceName(name)) return "This name is reserved by Windows.";
  return null;
}

/**
 * @param {unknown} name
 * @param {string} [platform]
 * @returns {string} The name, unchanged.
 * @throws {import("../errors.js").AppError} `invalidInput` with `field: "name"`.
 */
export function checkUploadName(name, platform = process.platform) {
  if (typeof name !== "string") throw invalidInput("A file name must be text.", "name");
  const problem = uploadNameProblem(name, platform);
  if (problem) throw invalidInput(problem, "name");
  return name;
}

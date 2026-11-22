// Folder naming rules carried over from docs/SPEC-desktop.md section 2 (ported from
// `src-tauri/src/scanner.rs`): reserved names inside a channel, the B-roll folder and the natural
// order of names. Shared by video creation, uploads and the library.

const CHANNEL_ASSET_FOLDERS = [
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
 * `CLAUDE_VE`, and the asset folders (compared ignoring case).
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

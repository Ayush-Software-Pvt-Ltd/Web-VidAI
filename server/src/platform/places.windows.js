// The Windows half of the folder picker's places (docs/SPEC.md section 6, "Folders on the
// server"): every drive letter that exists, and which entries of a folder carry the hidden or
// system attribute. Node has no call for the attributes, so `dir /a:h` and `dir /a:s` are asked;
// their parsing is pure and tested on sample output.

import fsp from "node:fs/promises";

/** The drive letters that can exist. */
export const DRIVE_LETTERS = Object.freeze("ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""));

/** File system errors that mean "this letter is a drive, but it cannot be read now" (an empty card reader). */
const NOT_READY = new Set(["EACCES", "EPERM", "EBUSY", "EIO", "ENXIO", "UNKNOWN", "EAGAIN"]);

/**
 * Every drive letter that exists: fixed, removable and network drives. A letter whose drive is
 * there but cannot be read (no card in the reader, a share that went away) is `available: false`;
 * a letter that has no drive is left out.
 * @param {{ stat?: (target: string) => Promise<unknown> }} [options] `stat` is a test seam.
 * @returns {Promise<{ name: string, path: string, kind: "drive", available: boolean }[]>}
 */
export async function listDrives({ stat = (target) => fsp.stat(target) } = {}) {
  const results = await Promise.all(
    DRIVE_LETTERS.map(async (letter) => {
      const root = `${letter}:\\`;
      try {
        await stat(root);
        return {
          name: `${letter}:`,
          path: root,
          kind: /** @type {const} */ ("drive"),
          available: true,
        };
      } catch (error) {
        const code = /** @type {{ code?: string }} */ (error).code ?? "";
        if (!NOT_READY.has(code)) return null;
        return {
          name: `${letter}:`,
          path: root,
          kind: /** @type {const} */ ("drive"),
          available: false,
        };
      }
    }),
  );
  return results.filter((place) => place !== null);
}

/** The program that lists a folder's entries by attribute. */
export const CMD = "cmd.exe";

/**
 * The arguments that list the names of the entries of `folder` that have the attributes `attribute`
 * (`h` hidden, `s` system), one per line, folders and files alike.
 * @param {string} folder A full path.
 * @param {"h" | "s"} attribute
 * @returns {string[]}
 */
export function dirArgs(folder, attribute) {
  // `\*` at the end: a drive root `C:\` would end in a backslash before the closing quote.
  const pattern = `${folder.replace(/[\\/]+$/, "")}\\*`;
  return ["/d", "/c", "dir", "/b", `/a:${attribute}`, pattern];
}

/**
 * The names in the output of `dir /b`.
 * @param {string | null} stdout
 * @returns {string[]}
 */
export function parseDirNames(stdout) {
  return (stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

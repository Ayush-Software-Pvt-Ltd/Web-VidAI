// Putting the finished file into `<video>/output/` (docs/SPEC.md section 12): the name is
// `<video folder name>_final_v<n>.mp4` with the smallest free `n`, and an existing file is never
// overwritten, even when two renders finish at the same moment.
//
// The name is claimed with an exclusive hard link, which fails when the name exists. When a link
// cannot be made (another disk, a file system without links) the file is copied to a temporary
// name inside the output folder first and that copy is linked, so a half-written file never has
// a final name.

import fs from "node:fs/promises";
import path from "node:path";

/** The most versions looked at before giving up. */
const MAX_VERSION = 9999;

/**
 * The file operations used (a test replaces them to stage a race).
 * @typedef {object} FileOps
 * @property {(from: string, to: string) => Promise<void>} link Fails with `EEXIST` when `to` exists.
 * @property {(from: string, to: string, exclusive: boolean) => Promise<void>} copy
 * @property {(file: string) => Promise<void>} unlink
 * @property {(dir: string) => Promise<void>} mkdir
 */

/** @type {FileOps} */
export const realFileOps = {
  link: (from, to) => fs.link(from, to),
  copy: (from, to, exclusive) => fs.copyFile(from, to, exclusive ? fs.constants.COPYFILE_EXCL : 0),
  unlink: (file) => fs.unlink(file),
  mkdir: async (dir) => {
    await fs.mkdir(dir, { recursive: true });
  },
};

/**
 * @param {string} folderName The video folder's name.
 * @param {number} n
 * @returns {string}
 */
export function finalName(folderName, n) {
  return `${folderName}_final_v${n}.mp4`;
}

/** @param {unknown} error @returns {string} */
const codeOf = (error) => String(/** @type {{ code?: unknown }} */ (error)?.code ?? "");

/**
 * Moves `file` to the smallest free `<folderName>_final_v<n>.mp4` in `outputDir`.
 * @param {object} options
 * @param {string} options.file The finished file (in the working folder).
 * @param {string} options.outputDir `<video>/output`.
 * @param {string} options.folderName
 * @param {FileOps} [options.ops]
 * @param {() => string} [options.unique] A unique suffix for the temporary name.
 * @returns {Promise<string>} The path it now has.
 */
export async function publishFinal({
  file,
  outputDir,
  folderName,
  ops = realFileOps,
  unique = () => `${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
}) {
  await ops.mkdir(outputDir);
  /** @type {string | null} A copy inside the output folder, made when a plain link failed. */
  let staged = null;
  let source = file;
  try {
    for (let n = 1; n <= MAX_VERSION; n += 1) {
      const target = path.join(outputDir, finalName(folderName, n));
      try {
        await ops.link(source, target);
        await ops.unlink(file).catch(() => {});
        return target;
      } catch (error) {
        if (codeOf(error) === "EEXIST") continue;
        if (staged === null) {
          // Another disk or no hard links: copy to a name nobody uses, then link that.
          staged = path.join(outputDir, `.${folderName}_final.partial-${unique()}.mp4`);
          await ops.copy(file, staged, true);
          source = staged;
          n -= 1;
          continue;
        }
        // Even the staged copy cannot be linked: copy it to the final name, exclusively.
        try {
          await ops.copy(staged, target, true);
          await ops.unlink(file).catch(() => {});
          return target;
        } catch (copyError) {
          if (codeOf(copyError) === "EEXIST") continue;
          throw copyError;
        }
      }
    }
  } finally {
    if (staged !== null) await ops.unlink(staged).catch(() => {});
  }
  throw new Error(`There are already ${MAX_VERSION} rendered versions of this video.`);
}

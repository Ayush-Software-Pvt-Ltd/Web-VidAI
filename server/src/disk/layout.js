// What is where inside a video folder (docs/SPEC.md sections 6, 10, 12 and 13). Names only, no
// file system access.

/** The working folder Disk Cleanup empties. */
export const WORKING_DIR = "CLAUDE_VE";
/** The folder with the project and the finals. */
export const OUTPUT_DIR = "output";

/** Rendered videos are `<folder name>_final_v<n>.mp4` (section 12); `n` is not checked here. */
const FINAL_PATTERN = /_final_v.*\.mp4$/i;

/** @typedef {"working" | "project" | "finals" | "sources"} Part */

/**
 * Which part of the video a file belongs to.
 * @param {readonly string[]} segments The names from the video folder down to the file.
 * @param {string} folderName The video's folder name (the project is `<folderName>.hf`).
 * @returns {Part}
 */
export function partOf(segments, folderName) {
  if (segments[0] === WORKING_DIR) return "working";
  if (segments[0] === OUTPUT_DIR) {
    if (segments.length >= 3 && segments[1] === `${folderName}.hf`) return "project";
    if (segments.length === 2 && FINAL_PATTERN.test(segments[1] ?? "")) return "finals";
  }
  return "sources";
}

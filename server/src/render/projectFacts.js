// What a render needs to know about a project: its frame rate, length and shape, read from the
// root of `index.html` (docs/SPEC.md sections 10 and 12).

import fs from "node:fs/promises";
import path from "node:path";
import { parseProject } from "../timeline/document.js";
import { fpsToNumber, fpsToString } from "../timeline/frames.js";

/**
 * @typedef {object} ProjectFacts
 * @property {string} fps What `hyperframes render --fps` gets: `30`, `25` or `30000/1001` (the
 *   rate of `data-fps`, reduced; `29.97` is written as `30000/1001`).
 * @property {number} fpsValue The same as a number.
 * @property {number} frames Length in frames (`data-duration` of the root).
 * @property {number} seconds Length in seconds.
 * @property {number} width
 * @property {number} height
 * @property {boolean} portrait Taller than wide (a Short).
 */

/**
 * Reads the facts of the project in `projectDir`.
 * @param {string} projectDir
 * @returns {Promise<ProjectFacts>}
 * @throws {Error} With a sentence for the user when the project's root cannot be read.
 */
export async function readProjectFacts(projectDir) {
  /** @type {string} */
  let html;
  try {
    html = await fs.readFile(path.join(projectDir, "index.html"), "utf8");
  } catch {
    throw new Error("The project has no index.html, so there is nothing to render.");
  }
  const { root } = parseProject(html);
  if (root === null) throw new Error("The project's index.html has no root composition.");
  if (root.fps === null) {
    throw new Error("The root of the project has no valid frame rate (data-fps).");
  }
  if (root.duration === null || root.duration <= 0) {
    throw new Error("The root of the project has no length (data-duration).");
  }
  const fpsValue = fpsToNumber(root.fps);
  return {
    fps: fpsToString(root.fps),
    fpsValue,
    frames: root.duration,
    seconds: root.duration / fpsValue,
    width: root.width ?? 1920,
    height: root.height ?? 1080,
    portrait: (root.height ?? 1080) > (root.width ?? 1920),
  };
}

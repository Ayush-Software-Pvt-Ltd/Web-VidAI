// The shape of `edit.json` and its validator. The shape is documented at the top of `profile.js`.

import { parseFps, fpsToString } from "./frames.js";

/** @typedef {import("./frames.js").Fps} Fps */

/**
 * @typedef {Object} SourceFact
 * @property {string} name The name the timeline shows (the link name under assets/media/).
 * @property {string} path The project-relative path clips use in `src`, unique.
 * @property {string | null} originalPath Where the file really is (null for files made for the edit).
 * @property {number} frames Length in frames at the source's own rate.
 * @property {Fps} fps The source's own frame rate.
 */

/**
 * @typedef {Object} GraphicFact
 * @property {string} id The host's id and composition id.
 * @property {string} template
 * @property {Record<string, unknown>} variables
 * @property {string} label
 */

/**
 * @typedef {Object} EditFacts
 * @property {string} toolkitVersion
 * @property {Fps} fps
 * @property {number} width
 * @property {number} height
 * @property {SourceFact[]} sources
 * @property {GraphicFact[]} graphics
 * @property {Map<string, SourceFact>} sourcesByPath
 * @property {Map<string, string>} [compositions] The text of each host's `compositions/<id>.html`, by
 *   host id, as far as `loadProject` read them (a B-roll with motion is read from its file: `editMotion.js`).
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Checks a parsed `edit.json` and turns it into facts.
 * @param {unknown} value
 * @returns {{ facts: EditFacts | null, errors: string[] }} `facts` is null when there are errors.
 */
export function validateEditJson(value) {
  /** @type {string[]} */
  const errors = [];
  if (!isObject(value)) return { facts: null, errors: ["edit.json must hold one JSON object."] };
  const toolkitVersion = value.toolkitVersion;
  if (typeof toolkitVersion !== "string" || toolkitVersion.trim() === "") {
    errors.push('edit.json needs "toolkitVersion", a non-empty text.');
  }
  const fps = parseFps(/** @type {string | number} */ (value.fps));
  if (!fps)
    errors.push(
      'edit.json needs "fps", the frame rate as a number or text such as "30", "29.97" or "30000/1001".',
    );
  const dimension = (/** @type {string} */ key) => {
    const v = value[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      errors.push(`edit.json needs "${key}", a whole number of pixels.`);
      return 0;
    }
    return v;
  };
  const width = dimension("width");
  const height = dimension("height");

  /** @type {SourceFact[]} */
  const sources = [];
  if (!Array.isArray(value.sources)) {
    errors.push('edit.json needs "sources", a list (it may be empty).');
  } else {
    const seen = new Set();
    value.sources.forEach((entry, i) => {
      const at = `edit.json sources[${i}]`;
      if (!isObject(entry)) return void errors.push(`${at} must be an object.`);
      const { name, path, originalPath, frames } = entry;
      const sourceFps = parseFps(/** @type {string | number} */ (entry.fps));
      if (typeof name !== "string" || name === "")
        errors.push(`${at} needs "name", a non-empty text.`);
      if (typeof path !== "string" || path === "")
        errors.push(`${at} needs "path", the clips' src such as "assets/media/aroll.mp4".`);
      else if (seen.has(path)) errors.push(`${at} repeats the path "${path}".`);
      else seen.add(path);
      if (originalPath !== null && typeof originalPath !== "string")
        errors.push(`${at} needs "originalPath", a text or null.`);
      if (typeof frames !== "number" || !Number.isInteger(frames) || frames <= 0)
        errors.push(`${at} needs "frames", a whole number above 0.`);
      if (!sourceFps) errors.push(`${at} needs "fps", the file's own frame rate.`);
      if (
        typeof name === "string" &&
        typeof path === "string" &&
        typeof frames === "number" &&
        sourceFps &&
        (originalPath === null || typeof originalPath === "string")
      ) {
        sources.push({ name, path, originalPath, frames, fps: sourceFps });
      }
    });
  }

  /** @type {GraphicFact[]} */
  const graphics = [];
  if (!Array.isArray(value.graphics)) {
    errors.push('edit.json needs "graphics", a list (it may be empty).');
  } else {
    const seen = new Set();
    value.graphics.forEach((entry, i) => {
      const at = `edit.json graphics[${i}]`;
      if (!isObject(entry)) return void errors.push(`${at} must be an object.`);
      const { id, template, variables, label } = entry;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id))
        errors.push(`${at} needs "id", letters, digits, "-" and "_" only.`);
      else if (seen.has(id)) errors.push(`${at} repeats the id "${id}".`);
      else seen.add(id);
      if (typeof template !== "string" || template === "")
        errors.push(`${at} needs "template", a non-empty text.`);
      if (!isObject(variables)) errors.push(`${at} needs "variables", an object.`);
      if (typeof label !== "string") errors.push(`${at} needs "label", a text.`);
      if (
        typeof id === "string" &&
        typeof template === "string" &&
        isObject(variables) &&
        typeof label === "string"
      ) {
        graphics.push({ id, template, variables, label });
      }
    });
  }

  if (errors.length > 0 || !fps) return { facts: null, errors };
  return {
    facts: {
      toolkitVersion: /** @type {string} */ (toolkitVersion),
      fps,
      width,
      height,
      sources,
      graphics,
      sourcesByPath: new Map(sources.map((s) => [s.path, s])),
    },
    errors,
  };
}

/** @param {Fps} fps @returns {string} For messages. */
export function showFps(fps) {
  return fpsToString(fps);
}

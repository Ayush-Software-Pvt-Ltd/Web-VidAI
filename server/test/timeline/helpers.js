// Shared test helpers for the timeline modules (not a test file itself).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removalEdit, parseProject, applyEdits, attrEdits } from "../../src/timeline/document.js";
import { validateEditJson } from "../../src/timeline/profile.js";
import { framesToSecondsText, parseFps } from "../../src/timeline/frames.js";
import { ROOT_SCRIPT as ROOT } from "../../src/timeline/rootScript.js";

export const FIXTURES = path.join(import.meta.dirname, "..", "support", "fixtures", "projects");

/**
 * @param {"long" | "short" | "motion"} name
 * @returns {{ dir: string, html: string, editText: string, facts: import("../../src/timeline/profileEditJson.js").EditFacts }}
 */
export function fixture(name) {
  const dir = path.join(FIXTURES, name);
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const editText = fs.readFileSync(path.join(dir, "edit.json"), "utf8");
  const { facts, errors } = validateEditJson(JSON.parse(editText));
  if (!facts) throw new Error(`fixture ${name} edit.json: ${errors.join(" ")}`);
  facts.compositions = compositionsOf(dir);
  return { dir, html, editText, facts };
}

/**
 * The text of every `compositions/<id>.html` of a project folder, by id (what `loadProject` hands the
 * profile as `facts.compositions`).
 * @param {string} dir
 * @returns {Map<string, string>}
 */
export function compositionsOf(dir) {
  const folder = path.join(dir, "compositions");
  /** @type {Map<string, string>} */
  const map = new Map();
  if (!fs.existsSync(folder)) return map;
  for (const name of fs.readdirSync(folder)) {
    if (name.endsWith(".html"))
      map.set(name.slice(0, -5), fs.readFileSync(path.join(folder, name), "utf8"));
  }
  return map;
}

/** @param {string} html */
export const toCrlf = (html) => html.replace(/\r?\n/g, "\r\n");

/**
 * Copies a fixture project into a fresh temporary folder; returns it and a cleanup function.
 * @param {"long" | "short" | "motion"} name
 */
export function copyProject(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-timeline-"));
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The text with everything an edit may change blanked out: the values of data-start, data-duration
 * and data-media-start of every clip, the root's data-duration, the id and every attribute of the
 * clips named in `volatile` (those elements are removed with their line). What is left must be equal
 * before and after an operation, byte for byte.
 * @param {string} html
 * @param {Set<string>} volatile Ids of clips that may be removed or inserted.
 */
export function skeleton(html, volatile = new Set()) {
  const parsed = parseProject(html);
  /** @type {import("../../src/timeline/document.js").TextEdit[]} */
  const edits = [];
  const mask = (
    /** @type {import("../../src/timeline/document.js").ParsedElement} */ element,
    /** @type {string[]} */ names,
  ) => {
    for (const attr of element.attrs) {
      if (!names.includes(attr.name)) continue;
      if (attr.quote) edits.push({ start: attr.valueStart, end: attr.valueEnd, text: "#" });
      else edits.push({ start: attr.start, end: attr.end, text: `${attr.name}=#` });
    }
  };
  if (parsed.root) mask(parsed.root.element, ["data-duration"]);
  for (const clip of parsed.clips) {
    if (clip.id !== null && volatile.has(clip.id)) edits.push(removalEdit(html, clip.element));
    else mask(clip.element, ["data-start", "data-duration", "data-media-start"]);
  }
  return applyEdits(html, edits);
}

/**
 * A generated project: every clip in frames, any frame rate. Used where the fixtures' 30 fps is not
 * enough (rational rates) and for the property test.
 * @param {string} fpsText
 * @param {{ aroll: number[], others?: { id: string, kind: string, track: number, start: number, dur: number, tag?: string }[] }} spec
 */
export function generate(fpsText, spec) {
  const fps = /** @type {import("../../src/timeline/frames.js").Fps} */ (parseFps(fpsText));
  const seconds = (/** @type {number} */ f) => framesToSecondsText(f, fps);
  const total = spec.aroll.reduce((a, b) => a + b, 0);
  const sourceFrames = total * 3 + 1000;
  let at = 0;
  let inPoint = 0;
  let body = "";
  spec.aroll.forEach((dur, i) => {
    body += `      <video id="a-${i + 1}" class="clip" src="assets/media/aroll.mp4" data-start="${seconds(at)}" data-duration="${seconds(dur)}" data-media-start="${seconds(inPoint)}" data-track-index="0" data-vidai-kind="aroll" data-vidai-label="Cut ${i + 1}" style="z-index:0"></video>\n`;
    at += dur;
    inPoint += dur + 7;
  });
  for (const o of spec.others ?? []) {
    const common = `id="${o.id}" class="clip" data-start="${seconds(o.start)}" data-duration="${seconds(o.dur)}" data-track-index="${o.track}" data-vidai-kind="${o.kind}" data-vidai-label="${o.id}"`;
    if (o.tag === "audio")
      body += `      <audio ${common} src="assets/sfx/x.wav" data-media-start="0"></audio>\n`;
    else if (o.tag === "div")
      body += `      <div ${common} data-composition-id="${o.id}" data-composition-src="compositions/${o.id}.html" style="z-index:${o.track}"></div>\n`;
    else
      body += `      <video ${common} src="assets/media/broll.mp4" data-media-start="${seconds(10)}" style="z-index:${o.track}"></video>\n`;
  }
  const html = `<!doctype html>
<html>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="${fpsText}" data-duration="${seconds(total)}">
${body}    </div>
    <script>
${ROOT}
    </script>
  </body>
</html>
`;
  const { facts } = validateEditJson({
    toolkitVersion: "1",
    fps: fpsText,
    width: 1920,
    height: 1080,
    sources: [
      {
        name: "aroll.mp4",
        path: "assets/media/aroll.mp4",
        originalPath: null,
        frames: sourceFrames,
        fps: fpsText,
      },
      {
        name: "broll.mp4",
        path: "assets/media/broll.mp4",
        originalPath: null,
        frames: 5000,
        fps: fpsText,
      },
      { name: "x.wav", path: "assets/sfx/x.wav", originalPath: null, frames: 5000, fps: fpsText },
    ],
    graphics: [],
  });
  if (!facts) throw new Error("generated edit.json is invalid");
  return { html, facts };
}

/**
 * Sets attributes of the clip with `id` in `html` by text splice (for building broken variants).
 * @param {string} html
 * @param {string} id
 * @param {Record<string, string>} changes
 */
export function withAttr(html, id, changes) {
  const parsed = parseProject(html);
  const clip = parsed.clips.find((c) => c.id === id);
  if (!clip) throw new Error(`no clip ${id}`);
  return applyEdits(html, attrEdits(clip.element, changes));
}

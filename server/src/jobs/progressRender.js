// The progress of a `render` job (docs/SPEC.md sections 8 and 12): the server itself runs the
// HyperFrames renderer, no agent, so there are no milestones or agent events. The progress comes
// from the renderer's own lines on its output:
//
//   @hf-progress {"code":"capture","done":120,"total":900,"pct":13.3}
//   @hf-result {...}
//
// `code` is one of `capture`, `encode`, `assemble`, in that order. `parseRenderLine` reads one
// line; `renderProgress` is the pure reducer that turns what it returns into the bar.

import { DONE_STAGE, MAX_RUNNING_PERCENT } from "./progressModels.js";

/**
 * The stages of a render, in order, with the share of the bar each one covers and its label.
 * @type {readonly { code: RenderCode, from: number, to: number, stage: string }[]}
 */
export const RENDER_STAGES = Object.freeze([
  { code: "capture", from: 0, to: 80, stage: "Rendering frames" },
  { code: "encode", from: 80, to: 95, stage: "Encoding" },
  { code: "assemble", from: 95, to: MAX_RUNNING_PERCENT, stage: "Finishing" },
]);

/** The stage before the renderer has said anything. */
export const RENDER_START_STAGE = "Preparing the render";

/** @typedef {"capture" | "encode" | "assemble"} RenderCode */

/**
 * One `@hf-progress` line.
 * @typedef {object} RenderProgressLine
 * @property {"progress"} type
 * @property {RenderCode} code
 * @property {number} pct How far this stage is, 0 to 100.
 * @property {number | null} done Frames (or units) done in this stage.
 * @property {number | null} total Frames (or units) of this stage.
 */

/**
 * The `@hf-result` line.
 * @typedef {object} RenderResultLine
 * @property {"result"} type
 * @property {Record<string, unknown>} result The object as the renderer sent it.
 */

/**
 * What the reducer is told: a parsed progress line, or that the render completed.
 * @typedef {RenderProgressLine | { type: "completed" }} RenderUpdate
 */

/**
 * The state of the bar of a render.
 * @typedef {object} RenderState
 * @property {number} percent
 * @property {string} stage
 * @property {number} step Index in `RENDER_STAGES` of the furthest stage seen, -1 before any.
 * @property {boolean} completed
 */

// eslint-disable-next-line no-control-regex -- the escape character is what ANSI sequences start with
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu;
const MARKER = /@hf-(progress|result)\b/u;

/**
 * The JSON object that starts at the first `{` of `text`: balanced braces, strings respected, so
 * whatever follows it on the line (a colour reset, a timestamp) is not part of it.
 * @param {string} text
 * @returns {string | null}
 */
function objectText(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reads one line of the renderer's output: the progress or result object after `@hf-progress` or
 * `@hf-result`, wherever it is on the line (a prefix such as a timestamp or a log level, and ANSI
 * colour codes, are ignored). Any other line, and a marker with broken JSON or an unknown stage,
 * gives `null`. Never throws.
 * @param {string} line
 * @returns {RenderProgressLine | RenderResultLine | null}
 */
export function parseRenderLine(line) {
  try {
    if (typeof line !== "string" || !line.includes("@hf-")) return null;
    const clean = line.replace(ANSI, "");
    const marker = MARKER.exec(clean);
    if (marker === null) return null;
    const json = objectText(clean.slice(marker.index + marker[0].length));
    if (json === null) return null;
    /** @type {unknown} */
    const value = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const object = /** @type {Record<string, unknown>} */ (value);
    if (marker[1] === "result") return { type: "result", result: object };
    const stage = RENDER_STAGES.find((s) => s.code === object.code);
    if (stage === undefined) return null;
    const done = finite(object.done);
    const total = finite(object.total);
    let pct = finite(object.pct);
    if (pct === null && done !== null && total !== null && total > 0) pct = (done / total) * 100;
    if (pct === null) return null;
    return {
      type: "progress",
      code: stage.code,
      pct: Math.min(Math.max(pct, 0), 100),
      done,
      total,
    };
  } catch {
    return null;
  }
}

/** @returns {RenderState} The state of a render that has not said anything yet. */
export function createRenderProgress() {
  return { percent: 0, stage: RENDER_START_STAGE, step: -1, completed: false };
}

/**
 * The reducer of the render bar. The percent of a `capture` line maps to 0 to 80, `encode` to 80
 * to 95, `assemble` to 95 to 99. Never backwards: a line of an earlier stage than one already seen
 * is ignored, and inside a stage a smaller percent changes nothing. Never 100 until told that the
 * render completed (then exactly 100, "Done"); nothing changes after that.
 * @param {RenderState} state
 * @param {RenderUpdate} update
 * @returns {RenderState}
 */
export function renderProgress(state, update) {
  if (state.completed) return state;
  if (update.type === "completed") {
    return { percent: 100, stage: DONE_STAGE, step: RENDER_STAGES.length - 1, completed: true };
  }
  const step = RENDER_STAGES.findIndex((s) => s.code === update.code);
  if (step === -1 || step < state.step) return state;
  const { from, to, stage } = RENDER_STAGES[step];
  const pct = Math.min(Math.max(update.pct, 0), 100);
  const percent = Math.min(Math.floor(from + ((to - from) * pct) / 100), MAX_RUNNING_PERCENT);
  return { percent: Math.max(percent, state.percent), stage, step, completed: false };
}

/**
 * What the UI shows for a render (`secondsLeft` is `null`: the stages do not run at one speed).
 * @param {RenderState} state
 * @returns {import("../../../src/lib/wire/progress.ts").JobProgress}
 */
export function renderView(state) {
  return { percent: state.percent, stage: state.stage, secondsLeft: null };
}

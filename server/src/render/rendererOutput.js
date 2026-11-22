// Reading the renderer's output while it runs (docs/SPEC.md section 12): the job log shows its
// stages (compile, extract, audio, capture, encode, assemble), the bar follows its
// `@hf-progress` lines, and the last lines are kept to explain a failure.
//
// `@hf-progress` lines carry `done` and `total` of their own stage and a `pct` of the whole
// render (capture runs from 25 to 70); the bar of `progressRender.js` wants the percent of the
// stage, so it is made from `done` and `total` whenever they are there.

import { cleanLine } from "./diagnostics.js";
import { parseRenderLine } from "../jobs/progressRender.js";

/** The stages of the renderer's own lines, in the words of the job log. */
export const STAGE_TEXT = Object.freeze({
  compile: "Compiling the project",
  extract_video: "Extracting video frames",
  process_audio: "Processing the audio",
  start_browsers: "Starting the renderer's browsers",
  capture: "Capturing frames",
  encode: "Encoding the video",
  assemble: "Assembling the file",
});

/** The most lines kept for a failure sentence. */
const TAIL_LINES = 80;
/** The most renderer warnings copied into the log. */
const MAX_WARNINGS = 20;
/** The longest log line made of a renderer line. */
const MAX_LINE = 300;

/**
 * @typedef {object} OutputEvents What the reader reports.
 * @property {(text: string, detail?: string | null) => void} status A line for the job log.
 * @property {(update: import("../jobs/progressRender.js").RenderProgressLine, activity: string) => void} progress
 * @property {(stage: string, activity: string) => void} stage A stage the bar has no share for
 *   (compile, extract, audio, browsers) started.
 */

/**
 * @param {OutputEvents} events
 */
export function createRendererOutput(events) {
  /** @type {string[]} */
  const tail = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** The next capture milestone to log, in percent. */
  let nextMilestone = 25;
  let warnings = 0;

  /** @param {string} line */
  function keep(line) {
    tail.push(line);
    if (tail.length > TAIL_LINES) tail.shift();
  }

  /** @param {string} code @param {number | null} total */
  function enter(code, total) {
    if (seen.has(code)) return;
    seen.add(code);
    const text = STAGE_TEXT[/** @type {keyof typeof STAGE_TEXT} */ (code)];
    if (text === undefined) return;
    events.status(code === "capture" && total !== null ? `${text} (${total} frames)` : text);
  }

  return {
    /** @param {string} raw One line of the renderer's output (either stream). */
    line(raw) {
      const line = cleanLine(raw);
      if (line === "") return;
      if (line.includes("@hf-progress")) {
        const code = /"code"\s*:\s*"([a-z_]+)"/u.exec(line)?.[1] ?? "";
        const parsed = parseRenderLine(line);
        if (parsed !== null && parsed.type === "progress") {
          const own =
            parsed.done !== null && parsed.total !== null && parsed.total > 0
              ? Math.min((parsed.done / parsed.total) * 100, 100)
              : parsed.pct;
          enter(parsed.code, parsed.total);
          const activity =
            parsed.code === "capture" && parsed.done !== null && parsed.total !== null
              ? `Capturing frame ${Math.min(parsed.done, parsed.total)} of ${parsed.total}`
              : STAGE_TEXT[parsed.code];
          if (parsed.code === "capture") {
            while (own >= nextMilestone && nextMilestone < 100) {
              events.status(
                `Captured ${nextMilestone}% of the frames` +
                  (parsed.done !== null && parsed.total !== null
                    ? ` (${parsed.done} of ${parsed.total})`
                    : ""),
              );
              nextMilestone += 25;
            }
          }
          events.progress({ ...parsed, pct: own }, activity);
        } else if (code in STAGE_TEXT) {
          enter(code, null);
          events.stage(code, STAGE_TEXT[/** @type {keyof typeof STAGE_TEXT} */ (code)]);
        } else {
          keep(line);
        }
        return;
      }
      if (line.includes("@hf-result")) return;
      if (/^[█░▓▒\s]+\d+%/u.test(line)) return; // the renderer's own text progress bar
      if (line.startsWith("@hf-diagnostic")) {
        keep(line);
        return;
      }
      keep(line);
      if (/^\[WARN\]/u.test(line) && warnings < MAX_WARNINGS) {
        warnings += 1;
        events.status(
          line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}...` : line,
          warnings === MAX_WARNINGS ? "More warnings are left out of this log." : null,
        );
      } else if (/capture .*·.*compile .*assemble/u.test(line)) {
        events.status(`Renderer timings: ${line}`);
      }
    },

    /** @returns {string[]} The last lines that were not progress. */
    tail: () => [...tail],
  };
}

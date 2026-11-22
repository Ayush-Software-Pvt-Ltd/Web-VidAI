// The message for change requests made on the timeline (docs/SPEC.md section 11, "Change
// requests"): per request the time and frame, the area in words and numbers, the picture files,
// the clips there, the words spoken around that time and the user's text; then the fixed rules.

import { invalidInput } from "../errors.js";
import { markerInstructions } from "./progressMarkers.js";
import { wrapFollowUp } from "./promptFollowUp.js";
import { trimBlock } from "./promptHeader.js";
import { NO_PICTURES, TIMELINE_RULES, timelineIntro } from "./promptTexts.js";

/** @typedef {import("./promptFollowUp.js").FollowUpBase} FollowUpBase */
/** @typedef {import("../../../src/lib/wire/timeline.ts").NoteShape} NoteShape */

/**
 * A clip at the request's frame.
 * @typedef {object} PromptClip
 * @property {string} id
 * @property {string} kind `aroll`, `broll`, `graphic`, `overlay`, `hit`, `fade`, `sfx`, `music`.
 * @property {string} label The text the timeline shows.
 * @property {number} track
 * @property {string | null} file The clip's file, relative to PROJECT_FOLDER
 *   (`compositions/<id>.html` for a graphic, `assets/media/<name>` for media), or `null`.
 */

/**
 * @typedef {object} PromptRequest
 * @property {number} frame The frame on the timeline.
 * @property {NoteShape | null} shape An ellipse in fractions of the frame, or `null`.
 * @property {string | null} elementId The selected clip, or `null`.
 * @property {string} prompt The user's text.
 * @property {{ frame: string | null, closeup: string | null, marked: string | null }} pictures
 *   Absolute paths of the full-frame picture, of the close-up of the area and of the full frame
 *   with the user's ellipse drawn on it (`null` when not made).
 * @property {PromptClip[]} clips The clips under that frame, top layer first.
 * @property {string | null} spoken The words spoken around that time.
 */

/**
 * @typedef {object} TimelineExtras
 * @property {{ num: number, den: number }} fps The project's frame rate as a fraction.
 * @property {number} width The frame width in pixels.
 * @property {number} height The frame height in pixels.
 * @property {PromptRequest[]} requests The requests in order (at least one).
 */

/** @typedef {FollowUpBase & TimelineExtras} TimelineEditInput */

/**
 * The frame rate in words: `30`, `29.97`.
 * @param {{ num: number, den: number }} fps
 * @returns {string}
 */
export function fpsText(fps) {
  return String(Number((fps.num / fps.den).toFixed(3)));
}

/**
 * The time of a frame as `m:ss.mmm` (`h:mm:ss.mmm` from one hour) and in seconds.
 * @param {number} frame
 * @param {{ num: number, den: number }} fps
 * @returns {{ clock: string, seconds: string }}
 */
export function timeOfFrame(frame, fps) {
  const ms = Math.round((frame * fps.den * 1000) / fps.num);
  const pad = (/** @type {number} */ n, /** @type {number} */ width) =>
    String(n).padStart(width, "0");
  const total = Math.floor(ms / 1000);
  const rest = ms - total * 1000;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const clock =
    hours > 0
      ? `${hours}:${pad(minutes, 2)}:${pad(secs, 2)}.${pad(rest, 3)}`
      : `${minutes}:${pad(secs, 2)}.${pad(rest, 3)}`;
  return { clock, seconds: (ms / 1000).toFixed(3) };
}

/** @param {number} x @returns {number} A fraction as a whole percent. */
const percent = (x) => Math.round(x * 100);

/**
 * Where the centre of the shape lies, in thirds of the frame: `the upper left`, `the centre of the
 * frame`.
 * @param {number} cx
 * @param {number} cy
 * @returns {string}
 */
export function regionName(cx, cy) {
  const horizontal = cx < 1 / 3 ? "left" : cx > 2 / 3 ? "right" : "centre";
  const vertical = cy < 1 / 3 ? "upper" : cy > 2 / 3 ? "lower" : "middle";
  if (horizontal === "centre" && vertical === "middle") return "the centre of the frame";
  if (horizontal === "centre") return `the ${vertical} centre`;
  if (vertical === "middle") return `the middle ${horizontal}`;
  return `the ${vertical} ${horizontal}`;
}

/**
 * The ellipse in words and numbers: its region, its centre, its size and its box in pixels
 * (clamped to the frame).
 * @param {NoteShape} shape
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
export function describeEllipse(shape, width, height) {
  const { cx, cy, rx, ry } = shape;
  if (![cx, cy, rx, ry].every(Number.isFinite) || rx < 0 || ry < 0) {
    throw invalidInput("The area of a change request must be an ellipse with finite sizes.");
  }
  const clamp = (/** @type {number} */ v, /** @type {number} */ max) =>
    Math.min(max, Math.max(0, Math.round(v)));
  const x0 = clamp((cx - rx) * width, width);
  const x1 = clamp((cx + rx) * width, width);
  const y0 = clamp((cy - ry) * height, height);
  const y1 = clamp((cy + ry) * height, height);
  return `an ellipse around ${regionName(cx, cy)}: centre ${percent(cx)}% from the left and ${percent(cy)}% from the top, ${percent(2 * rx)}% of the width wide and ${percent(2 * ry)}% of the height high, in pixels x ${x0} to ${x1}, y ${y0} to ${y1} of ${width}x${height}`;
}

/**
 * The area of a request in words: the selected clip, the ellipse, both, or the whole frame.
 * @param {PromptRequest} request
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
export function describeArea(request, width, height) {
  /** @type {string[]} */
  const parts = [];
  if (request.elementId !== null) {
    const clip = request.clips.find((c) => c.id === request.elementId);
    parts.push(
      clip === undefined ? `the clip ${request.elementId}` : `the clip ${clip.id} (${clip.label})`,
    );
  }
  if (request.shape !== null) parts.push(describeEllipse(request.shape, width, height));
  return parts.length === 0 ? "the whole frame" : parts.join("; within the frame: ");
}

/**
 * One clip line: `- id | kind | "label" | track n | file`.
 * @param {PromptClip} clip
 * @returns {string}
 */
function clipLine(clip) {
  const file = clip.file === null ? "" : ` | ${clip.file}`;
  return `- ${clip.id} | ${clip.kind} | "${clip.label}" | track ${clip.track}${file}`;
}

/**
 * One numbered request.
 * @param {PromptRequest} request
 * @param {number} number 1-based.
 * @param {number} count
 * @param {TimelineExtras} view
 * @returns {string}
 */
function requestBlock(request, number, count, view) {
  const time = timeOfFrame(request.frame, view.fps);
  /** @type {string[]} */
  const lines = [
    `REQUEST ${number} OF ${count}`,
    `Time: ${time.clock} (${time.seconds} seconds), frame ${request.frame}`,
    `Area: ${describeArea(request, view.width, view.height)}`,
  ];
  const pictures = [];
  if (request.pictures.frame !== null) pictures.push(`- Full frame: ${request.pictures.frame}`);
  // The marked frame shows where the close-up sits in the frame; the close-up stays the picture
  // to read detail from (SPEC section 11, Change requests).
  if (request.pictures.marked !== null) {
    pictures.push(
      `- Full frame with my ellipse drawn on it (shows where the close-up sits): ${request.pictures.marked}`,
    );
  }
  if (request.pictures.closeup !== null) {
    pictures.push(
      `- Close-up of the area (read the detail from this one): ${request.pictures.closeup}`,
    );
  }
  lines.push(pictures.length === 0 ? NO_PICTURES : `Pictures:\n${pictures.join("\n")}`);
  lines.push(
    request.clips.length === 0
      ? "Clips at this frame: none."
      : `Clips at this frame, from the top layer down (id | kind | label | track | file):\n${request.clips.map(clipLine).join("\n")}`,
  );
  const spoken = (request.spoken ?? "").trim();
  lines.push(`Words spoken around this time: ${spoken === "" ? "none" : `"${spoken}"`}`);
  lines.push(`Text of the request:\n${trimBlock(request.prompt)}`);
  return lines.join("\n");
}

/**
 * The message for change requests made on the timeline, for the resumed session of the video or
 * (with `newSession`) a new session that gets the full instructions first.
 * @param {TimelineEditInput} input
 * @returns {string}
 */
export function composeTimelineEdit(input) {
  if (input.requests.length === 0) {
    throw invalidInput("There are no change requests to send.");
  }
  const count = input.requests.length;
  const intro = timelineIntro({
    count,
    width: input.width,
    height: input.height,
    fps: fpsText(input.fps),
  });
  const blocks = input.requests.map((r, i) => requestBlock(r, i + 1, count, input));
  const body = [intro, ...blocks, TIMELINE_RULES, markerInstructions("timelineEdit")].join("\n\n");
  return wrapFollowUp(input, body);
}

// The ffmpeg command that turns one capture of a whole frame into the pictures of a change request
// (docs/SPEC.md section 11, Change requests): `frame.png` (the whole frame, 1280 on the long side),
// with a shape `closeup.png` (the area plus a margin, from the full-density capture, 800 to 1600 on
// the long side) and `frame-marked.png` (the whole frame with the ellipse's outline). One ffmpeg
// run per request reads the capture once.

import { closeupBox, fitBetween, fitLongSide, outlineCondition } from "./noteBox.js";

/** The long side of the whole-frame picture: what the agent can read without it being downscaled. */
export const FRAME_LONG_SIDE = 1280;
/** The close-up is enlarged to at least this long side and reduced to at most that one. */
export const CLOSEUP_MIN_LONG_SIDE = 800;
export const CLOSEUP_MAX_LONG_SIDE = 1600;

/** The outline's colour. */
const OUTLINE_RED = 255;
const OUTLINE_GREEN = 45;
const OUTLINE_BLUE = 45;

/** @typedef {import("../../../src/lib/wire/timeline.ts").NoteShape} NoteShape */

/**
 * @typedef {object} PictureJob
 * @property {string} input The capture (a PNG of the whole frame).
 * @property {number} inputWidth Its size in pixels (at least the frame size, more with `--zoom-scale`).
 * @property {number} inputHeight
 * @property {NoteShape | null} shape
 * @property {string} frameFile Where `frame.png` goes.
 * @property {string} markedFile Where `frame-marked.png` goes (used with a shape only).
 * @property {string} closeupFile Where `closeup.png` goes (used with a shape only).
 */

/**
 * The arguments for `ffmpeg`.
 * @param {PictureJob} job
 * @returns {string[]}
 */
export function pictureArgs(job) {
  const frame = fitLongSide(job.inputWidth, job.inputHeight, FRAME_LONG_SIDE);
  const scaleFrame = `scale=${frame.w}:${frame.h}:flags=lanczos`;
  const out = (/** @type {string} */ label, /** @type {string} */ file) => [
    "-map",
    `[${label}]`,
    "-frames:v",
    "1",
    "-update",
    "1",
    file,
  ];
  const head = ["-v", "error", "-y", "-i", job.input, "-filter_complex"];
  if (job.shape === null) {
    return [...head, `[0:v]${scaleFrame}[f]`, ...out("f", job.frameFile)];
  }
  const box = closeupBox(job.shape, job.inputWidth, job.inputHeight);
  const closeup = fitBetween(box.w, box.h, CLOSEUP_MIN_LONG_SIDE, CLOSEUP_MAX_LONG_SIDE);
  const ring = outlineCondition(job.shape, frame.w, frame.h);
  const paint = (/** @type {number} */ colour, /** @type {string} */ plane) =>
    `${plane}='if(${ring},${colour},${plane}(X,Y))'`;
  const graph = [
    "[0:v]split=3[s1][s2][s3]",
    `[s1]${scaleFrame}[f]`,
    `[s2]${scaleFrame},format=gbrp,geq=${paint(OUTLINE_RED, "r")}:${paint(OUTLINE_GREEN, "g")}:${paint(OUTLINE_BLUE, "b")},format=rgb24[m]`,
    `[s3]crop=${box.w}:${box.h}:${box.x}:${box.y},scale=${closeup.w}:${closeup.h}:flags=lanczos[c]`,
  ].join(";");
  return [
    ...head,
    graph,
    ...out("f", job.frameFile),
    ...out("m", job.markedFile),
    ...out("c", job.closeupFile),
  ];
}

// The time a change request's picture is taken at (docs/SPEC.md section 11, Change requests).
//
// A frame covers the time from `frame / fps` up to (but not including) `(frame + 1) / fps`. The
// capture tool is told an instant, and an instant on the boundary may land on the neighbouring
// frame (a rounding of 1e-9 seconds is enough), so the instant is the middle of the frame:
// `(frame + 0.5) / fps`, exact for rates such as 30000/1001.

/** @typedef {import("./frames.js").Fps} Fps */

/**
 * The middle of a frame in seconds.
 * @param {number} frame A whole frame number, 0 or more.
 * @param {Fps} fps
 * @returns {number}
 */
export function frameMiddle(frame, fps) {
  return ((2 * frame + 1) * fps.den) / (2 * fps.num);
}

/**
 * The middle of a frame as text for the command line: 6 decimals (a frame is at least 4 ms long at
 * the highest rate the profile allows, 240 fps, so 6 decimals never leave the frame).
 * @param {number} frame
 * @param {Fps} fps
 * @returns {string}
 */
export function frameMiddleText(frame, fps) {
  return frameMiddle(frame, fps).toFixed(6);
}

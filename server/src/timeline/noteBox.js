// The geometry of a change request's pictures (docs/SPEC.md section 11, Change requests): the
// close-up of the marked area and the outline drawn on a copy of the whole frame. Pure functions;
// the ffmpeg arguments built from them are in `noteFilters.js`.

/** @typedef {import("../../../src/lib/wire/timeline.ts").NoteShape} NoteShape */

/** The margin around the ellipse's bounding box, as a fraction of the box, on every side. */
export const CLOSEUP_MARGIN = 0.15;

/**
 * The close-up is never smaller than this fraction of the frame on either side: an ellipse around
 * a single letter would otherwise give a picture of a few pixels with nothing to recognise.
 */
export const CLOSEUP_MIN_FRACTION = 0.1;

/**
 * One side of the close-up as a range of fractions of the frame: the ellipse's extent plus the
 * margin on both sides, at least the minimum, kept inside the frame by sliding it (not shrinking
 * it) when it reaches past an edge.
 * @param {number} centre
 * @param {number} radius
 * @returns {{ from: number, size: number }}
 */
function side(centre, radius) {
  const wanted = 2 * radius * (1 + 2 * CLOSEUP_MARGIN);
  const size = Math.min(1, Math.max(CLOSEUP_MIN_FRACTION, wanted));
  const from = Math.min(1 - size, Math.max(0, centre - size / 2));
  return { from, size };
}

/**
 * The close-up's rectangle in pixels of a picture of `width` x `height`: the bounding box of the
 * ellipse plus the margin, at least the minimum size, clamped to the picture. Whole pixels, at
 * least 1 wide and high, always inside.
 * @param {NoteShape} shape
 * @param {number} width
 * @param {number} height
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function closeupBox(shape, width, height) {
  const horizontal = side(shape.cx, shape.rx);
  const vertical = side(shape.cy, shape.ry);
  const x = Math.min(width - 1, Math.floor(horizontal.from * width));
  const y = Math.min(height - 1, Math.floor(vertical.from * height));
  const right = Math.min(
    width,
    Math.max(x + 1, Math.ceil((horizontal.from + horizontal.size) * width)),
  );
  const bottom = Math.min(
    height,
    Math.max(y + 1, Math.ceil((vertical.from + vertical.size) * height)),
  );
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * The size of a picture whose long side is at most `limit` (never enlarged), keeping the shape.
 * @param {number} width
 * @param {number} height
 * @param {number} limit
 * @returns {{ w: number, h: number }}
 */
export function fitLongSide(width, height, limit) {
  const long = Math.max(width, height);
  if (long <= limit) return { w: width, h: height };
  const k = limit / long;
  return { w: Math.max(1, Math.round(width * k)), h: Math.max(1, Math.round(height * k)) };
}

/**
 * The size of a picture whose long side is `target`, as `fitLongSide` but also enlarging a small one
 * (a close-up of a tiny area is shown larger so the picture is not ignored as a speck).
 * @param {number} width
 * @param {number} height
 * @param {number} min Enlarge to at least this long side.
 * @param {number} max Reduce to at most this long side.
 * @returns {{ w: number, h: number }}
 */
export function fitBetween(width, height, min, max) {
  const long = Math.max(width, height);
  const target = Math.min(max, Math.max(min, long));
  const k = target / long;
  return { w: Math.max(1, Math.round(width * k)), h: Math.max(1, Math.round(height * k)) };
}

/** The outline's thickness on a picture whose long side is 1280, in pixels (scales with size). */
const OUTLINE_PIXELS_AT_1280 = 4;

/**
 * The `geq` condition that is true on the ellipse's outline. With `u = (X-cx)/rx` and
 * `v = (Y-cy)/ry` the distance of a point from the ellipse, in pixels, is about
 * `|hypot(u,v) - 1| / hypot(u/rx, v/ry)` (the distance function divided by its gradient), so the
 * line has the same width everywhere, also on a long thin ellipse.
 * @param {NoteShape} shape
 * @param {number} width The picture the outline is drawn on.
 * @param {number} height
 * @returns {string} A `geq` condition using `X` and `Y`.
 */
export function outlineCondition(shape, width, height) {
  const f = (/** @type {number} */ n) => n.toFixed(3);
  const cx = f(shape.cx * width);
  const cy = f(shape.cy * height);
  const rx = f(Math.max(shape.rx * width, 1));
  const ry = f(Math.max(shape.ry * height, 1));
  const half = f((OUTLINE_PIXELS_AT_1280 * Math.max(width, height)) / 1280 / 2);
  const u = `(X-${cx})/${rx}`;
  const v = `(Y-${cy})/${ry}`;
  return `lt(abs(hypot(${u},${v})-1),${half}*hypot(${u}/${rx},${v}/${ry}))`;
}

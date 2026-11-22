// The ripple rule of docs/SPEC.md section 11 for the clips of the other tracks, as pure functions on
// plain clip records (frames). The A-roll itself is laid out by `edits.js`.
//
// SPEC: "a clip that starts after the removed or inserted part shifts by its length; a clip that starts
// inside a removed part now starts at the cut point; a clip that would end after the end of the video
// is shortened to fit, and removed if less than 2 frames remain."
//
// The SPEC does not say what happens when shifting makes two clips of one track overlap (for example
// two hits that both start inside a removed part and now both start at the cut point). Decision: the
// clip that comes later in time keeps its place and the earlier one is shortened to end where the later
// starts, and removed when less than 2 frames remain; a hit on words that were cut out is better lost
// than moved onto words it was never about.

/** The shortest a clip can be, in frames (SPEC section 11). */
export const MIN_FRAMES = 2;

/**
 * @typedef {Object} RippleClip
 * @property {string} id
 * @property {number} track
 * @property {number} order Position in the document, to break ties.
 * @property {number} start
 * @property {number} dur
 * @property {boolean} removed
 */

/**
 * Where a start goes when `length` frames at `cut` are removed.
 * @param {number} pos @param {number} cut @param {number} length
 */
export function startAfterRemoval(pos, cut, length) {
  if (pos < cut) return pos;
  if (pos < cut + length) return cut;
  return pos - length;
}

/**
 * Where a start goes when `length` frames are inserted at `at`.
 * @param {number} pos @param {number} at @param {number} length
 */
export function startAfterInsertion(pos, at, length) {
  return pos >= at ? pos + length : pos;
}

/**
 * Where a start goes when the A-roll clip [s, e) is taken out and put before the cut `p` (a cut of the
 * timeline as it is now). A clip that starts inside the moved clip goes with it; every other clip
 * follows the removal and then the insertion, so it keeps its place over the A-roll it was over.
 * @param {number} pos
 * @param {{ s: number, e: number, p: number }} move
 */
export function startAfterMove(pos, { s, e, p }) {
  const length = e - s;
  if (pos >= s && pos < e) return (p < s ? p : p - length) + (pos - s);
  const removed = startAfterRemoval(pos, s, length);
  const at = p < s ? p : p - length;
  return startAfterInsertion(removed, at, length);
}

/**
 * Shortens clips that end after the end of the video; removes those with less than 2 frames left.
 * @param {RippleClip[]} clips Other-track clips (A-roll excluded).
 * @param {number} total The end of the video in frames.
 */
export function fitToEnd(clips, total) {
  for (const clip of clips) {
    if (clip.removed || clip.start + clip.dur <= total) continue;
    clip.dur = total - clip.start;
    if (clip.dur < MIN_FRAMES) clip.removed = true;
  }
}

/**
 * Makes clips of one track not overlap (see the decision at the top of the file).
 * @param {RippleClip[]} clips Other-track clips (A-roll excluded).
 */
export function resolveOverlaps(clips) {
  /** @type {Map<number, RippleClip[]>} */
  const tracks = new Map();
  for (const clip of clips) {
    if (clip.removed) continue;
    const list = tracks.get(clip.track) ?? [];
    list.push(clip);
    tracks.set(clip.track, list);
  }
  for (const list of tracks.values()) {
    list.sort((a, b) => a.start - b.start || a.order - b.order);
    /** @type {RippleClip[]} */
    const kept = [];
    for (const clip of list) {
      const previous = kept[kept.length - 1];
      if (previous && clip.start < previous.start + previous.dur) {
        previous.dur = clip.start - previous.start;
        if (previous.dur < MIN_FRAMES) {
          previous.removed = true;
          kept.pop();
        }
      }
      kept.push(clip);
    }
  }
}

/**
 * The shared tail of every A-roll change: fit to the new end, then settle overlaps.
 * @param {RippleClip[]} others
 * @param {number} total
 */
export function settleOthers(others, total) {
  fitToEnd(others, total);
  resolveOverlaps(others);
}

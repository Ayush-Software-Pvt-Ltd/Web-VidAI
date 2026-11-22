// Which part of the A-roll is audible under a host, in pieces (docs/SPEC.md section 11, "Hand edits").
//
// A host whose composition file plays the A-roll's own source (the round host video of a synced B-roll
// layout, `<id>-host`) must show, at every frame of the host, the A-roll frame that is audible then.
// HyperFrames reads an inner video's in-point and speed from static text, so the picture follows the
// A-roll only if the file says it: one inner video piece per stretch of the host that lies over one
// A-roll clip (cuts, reordering and speed changes make a new piece), each with its own `data-start`
// (frames into the host), `data-duration`, `data-media-start` and `data-playback-rate`.
//
// Everything here is plain arithmetic on frames; the text of the file is written by `editInner.js`.

/**
 * One stretch of the A-roll as it is after an edit (a clip of track 0).
 * @typedef {Object} ArollSegment
 * @property {string} src The A-roll clip's `src` (as written in `index.html`, a key of `edit.json`).
 * @property {number} start First frame on the timeline.
 * @property {number} dur Length in timeline frames.
 * @property {number} mediaStart In-point in source frames.
 * @property {number} rate Source seconds per timeline second.
 */

/**
 * One inner video of a host's file.
 * @typedef {Object} SyncPiece
 * @property {string} src
 * @property {number} start First frame, counted from the host's first frame.
 * @property {number} dur Length in timeline frames.
 * @property {number} mediaStart In-point in source frames.
 * @property {number} rate
 */

/** Slack, in frames, when comparing in-points and lengths (as in the profile). */
const TOLERANCE = 0.01;

/** Slack in a playback rate. */
const RATE_TOLERANCE = 1e-9;

/** @param {number} x @returns {number} A value within 0.01 of a whole number becomes it. */
function snapFrames(x) {
  return Math.abs(x - Math.round(x)) <= TOLERANCE ? Math.round(x) : x;
}

/**
 * The pieces a host needs: for every A-roll clip the host overlaps, the overlap with the matching
 * in-point, in time order; neighbours that continue each other in the same source at the same speed
 * are one piece. A stretch of the host over no A-roll gets no piece, so the picture is hidden there
 * (the A-roll has no gaps, so this only happens for a host that reaches past the end of the video).
 * @param {ArollSegment[]} segments
 * @param {number} hostStart The host's first frame.
 * @param {number} hostDur The host's length in frames.
 * @returns {SyncPiece[]}
 */
export function syncPieces(segments, hostStart, hostDur) {
  const hostEnd = hostStart + hostDur;
  /** @type {SyncPiece[]} */
  const pieces = [];
  const ordered = [...segments].sort((a, b) => a.start - b.start);
  for (const s of ordered) {
    const from = Math.max(hostStart, s.start);
    const to = Math.min(hostEnd, s.start + s.dur);
    if (to <= from) continue;
    const piece = {
      src: s.src,
      start: from - hostStart,
      dur: to - from,
      mediaStart: snapFrames(s.mediaStart + (from - s.start) * s.rate),
      rate: s.rate,
    };
    const last = pieces.at(-1);
    if (
      last &&
      last.src === piece.src &&
      Math.abs(last.rate - piece.rate) <= RATE_TOLERANCE &&
      last.start + last.dur === piece.start &&
      Math.abs(last.mediaStart + last.dur * last.rate - piece.mediaStart) <= TOLERANCE
    ) {
      last.dur += piece.dur;
    } else {
      pieces.push(piece);
    }
  }
  return pieces;
}

/**
 * Whether inner videos already show the needed pieces: the same number, each with the same source,
 * start, in-point and speed, and the same length (the last one may last longer: the host ends it).
 * @param {{ src: string, start: number, duration: number, mediaStart: number, rate: number }[]} have
 *   The existing inner videos in time order.
 * @param {SyncPiece[]} want
 * @returns {boolean}
 */
export function piecesMatch(have, want) {
  if (have.length !== want.length) return false;
  return want.every((w, i) => {
    const h = /** @type {(typeof have)[number]} */ (have[i]);
    const last = i === want.length - 1;
    return (
      h.src === w.src &&
      h.start === w.start &&
      Math.abs(h.mediaStart - w.mediaStart) <= TOLERANCE &&
      Math.abs(h.rate - w.rate) <= RATE_TOLERANCE &&
      (last ? h.duration + TOLERANCE >= w.dur : Math.abs(h.duration - w.dur) <= TOLERANCE)
    );
  });
}

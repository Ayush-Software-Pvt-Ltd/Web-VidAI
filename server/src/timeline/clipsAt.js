// The clips under one frame (docs/SPEC.md section 11, Change requests: "lists the clips at that
// frame from the top down"), for the message to the agent.

/**
 * @typedef {object} ClipAt
 * @property {string} id
 * @property {string} kind `data-vidai-kind`.
 * @property {string} label
 * @property {number} track
 * @property {number} start First frame.
 * @property {number} duration Frames.
 * @property {string | null} file What the clip plays or runs: the media `src` (such as
 *   `assets/media/aroll.mp4`) or the graphic's `compositions/<id>.html`.
 */

/**
 * The clips that are on screen or audible at `frame` (`start <= frame < start + duration`): the
 * pictures from the highest track down to the A-roll, then the sound clips (tracks 10 and up,
 * highest first), which show nothing.
 * @param {import("./document.js").ParsedProject} parsed
 * @param {number} frame
 * @returns {ClipAt[]}
 */
export function clipsAtFrame(parsed, frame) {
  /** @type {ClipAt[]} */
  const found = [];
  for (const clip of parsed.clips) {
    if (clip.id === null || clip.track === null || clip.start === null || clip.duration === null) {
      continue;
    }
    if (frame < clip.start || frame >= clip.start + clip.duration) continue;
    found.push({
      id: clip.id,
      kind: clip.kind ?? "",
      label: clip.label ?? "",
      track: clip.track,
      start: clip.start,
      duration: clip.duration,
      file: clip.isHost ? clip.compositionSrc : clip.src,
    });
  }
  const sound = (/** @type {ClipAt} */ clip) => clip.track >= 10;
  const byTrackDown = (/** @type {ClipAt} */ a, /** @type {ClipAt} */ b) =>
    b.track - a.track || a.start - b.start;
  return [
    ...found.filter((clip) => !sound(clip)).sort(byTrackDown),
    ...found.filter(sound).sort(byTrackDown),
  ];
}

// The wire `Timeline` of docs/SPEC.md section 11 ("Timeline data") built from a parsed project.

import { motionFrames, motionOfHost } from "./editMotion.js";
import { FIRST_SOUND_TRACK, KINDS, sourceLengthFrames, MEDIA_TOLERANCE } from "./profile.js";

/** @typedef {import("../../../src/lib/wire/timeline.ts").Timeline} Timeline */
/** @typedef {import("../../../src/lib/wire/timeline.ts").TimelineClip} TimelineClip */
/** @typedef {import("../../../src/lib/wire/timeline.ts").TimelineTrack} TimelineTrack */
/** @typedef {import("../../../src/lib/wire/timeline.ts").ClipKind} ClipKind */
/** @typedef {import("../../../src/lib/wire/timeline.ts").TimelineNote} TimelineNote */
/** @typedef {import("../../../src/lib/wire/timeline.ts").TimelineLock} TimelineLock */
/** @typedef {import("./document.js").ParsedProject} ParsedProject */
/** @typedef {import("./profileEditJson.js").EditFacts} EditFacts */

/**
 * What a later module (revisions, notes, locks) supplies; passed through untouched.
 * @typedef {Object} TimelineExtras
 * @property {number} revision
 * @property {TimelineNote[]} notes
 * @property {boolean} canUndo
 * @property {boolean} canRedo
 * @property {TimelineLock | null} locked
 */

const TRACK_NAMES = ["A-roll", "B-roll and graphics", "Overlays", "Keyword hits", "End fade"];

/** @param {number} index @returns {string} */
function trackName(index) {
  return TRACK_NAMES[index] ?? `Sound ${index - FIRST_SOUND_TRACK + 1}`;
}

/** @param {string} src @returns {string} The last path segment. */
function baseName(src) {
  return src.slice(src.lastIndexOf("/") + 1);
}

/**
 * Builds the timeline of a project that follows the profile. Clips that cannot be read (no id, no
 * numbers) are left out, so call `checkDocument` first when that matters.
 * @param {ParsedProject} parsed
 * @param {EditFacts} facts
 * @param {TimelineExtras} extras
 * @returns {Timeline}
 */
export function toTimeline(parsed, facts, extras) {
  const fps = facts.fps;
  /** @type {Map<number, TimelineClip[]>} */
  const tracks = new Map();
  for (let i = 0; i < TRACK_NAMES.length; i++) tracks.set(i, []);
  for (const clip of parsed.clips) {
    if (clip.id === null || clip.start === null || clip.duration === null || clip.track === null)
      continue;
    if (clip.kind === null || !KINDS.includes(clip.kind)) continue;
    const motion = clip.isHost ? motionOfHost(facts, clip.id) : null;
    const media = clip.tag === "video" || clip.tag === "audio" || clip.tag === "img";
    const sourcePath = motion ? motion.src : media ? clip.src : null;
    const source = sourcePath !== null ? facts.sourcesByPath.get(sourcePath) : undefined;
    const timed = clip.tag === "video" || clip.tag === "audio" || motion !== null;
    const mediaStart = motion ? motionFrames(motion, fps).mediaStart : (clip.mediaStart ?? 0);
    /** @type {TimelineClip} */
    const wire = {
      id: clip.id,
      kind: /** @type {ClipKind} */ (clip.kind),
      label: clip.label ?? "",
      track: clip.track,
      start: clip.start,
      duration: clip.duration,
      source: sourcePath !== null ? (source?.name ?? baseName(sourcePath)) : null,
      mediaStart: timed ? Math.round(mediaStart) : null,
      sourceFrames:
        timed && source ? Math.floor(sourceLengthFrames(source, fps) + MEDIA_TOLERANCE) : null,
      file: clip.isHost ? clip.compositionSrc : null,
    };
    const list = tracks.get(clip.track) ?? [];
    list.push(wire);
    tracks.set(clip.track, list);
  }
  /** @type {TimelineTrack[]} */
  const out = [...tracks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, clips]) => ({
      index,
      name: trackName(index),
      clips: clips.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    }));
  return {
    revision: extras.revision,
    fps: { num: fps.num, den: fps.den },
    width: facts.width,
    height: facts.height,
    duration: parsed.root?.duration ?? 0,
    tracks: out,
    notes: extras.notes,
    canUndo: extras.canUndo,
    canRedo: extras.canRedo,
    locked: extras.locked,
  };
}

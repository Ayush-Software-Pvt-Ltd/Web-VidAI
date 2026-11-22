// A B-roll with motion (a slow push, pull or drift) is a host in `index.html` whose file
// `compositions/<id>.html` holds the video and one GSAP movement (docs/SPEC.md section 10). For a person
// on the timeline it behaves like a plain B-roll clip (section 11), so hand edits must keep the file
// right: the picture at every frame is the same source frame a plain clip would show, and the movement
// runs over the clip's length.
//
// Why the file is edited at all: HyperFrames reads a video's `data-media-start` and `data-duration` from
// the static text of the file (the renderer extracts frames before any script runs), and its variable
// mechanisms (`data-variable-values`, `getVariables()`, `data-var-src`) cannot bind those attributes,
// so a host in `index.html` cannot pass the in-point down. The file therefore carries three plain
// facts and the server changes exactly those, nothing else:
//
//   <div id="<id>-motion" data-vidai-motion='{"scale":[a,b],"x":[c,d],"duration":<seconds>}'>
//     <video id="<id>-video" src data-start="0" data-duration="<seconds>" data-media-start="<seconds>" ...>
//
// `data-vidai-motion` is the movement (scale and slide in pixels, from and to, over `duration` seconds
// with a linear ease; the file's script reads it). The video's `data-media-start` is the source time of
// the host's first frame and its `data-duration` is as long as the file allows (at most 10 minutes more
// than the host), so a person can lengthen the host and the picture goes on. The toolkit writes the
// same shape (`broll_composition` in `hfproject.py`); `server/test/support/fixtures/projects/motion/`
// holds one file that both sides' tests compare byte for byte.

import { invalidInput } from "../errors.js";
import {
  applyEdits,
  attrEdits,
  attrValue,
  elementOf,
  parseHtml,
  walkElements,
} from "./document.js";
import { framesToSecondsText, readSeconds } from "./frames.js";

/** @typedef {import("./document.js").ParsedElement} ParsedElement */
/** @typedef {import("./frames.js").Fps} Fps */

/** How far past the host the inner video lasts at most, in seconds. */
export const INNER_EXTRA_SECONDS = 600;

/** Slack, in frames, when comparing an out-point with the source length (as in the profile). */
const TOLERANCE = 0.01;

/**
 * The movement: a linear slide and zoom of the box that holds the video.
 * @typedef {Object} MotionSpec
 * @property {[number, number]} scale Scale at the first and at the last frame.
 * @property {[number, number]} x Sideways shift in pixels at the first and at the last frame.
 */

/**
 * What a motion composition file says.
 * @typedef {Object} MotionFile
 * @property {string} id The host's id and composition id.
 * @property {string} text The file as read.
 * @property {ParsedElement} video The inner `<video>`'s start tag.
 * @property {ParsedElement} motion The element that carries `data-vidai-motion`.
 * @property {string} src The inner video's `src`.
 * @property {number} rate `data-playback-rate` (1 when absent).
 * @property {string} mediaStartText `data-media-start` (seconds, "0" when absent).
 * @property {string} durationText `data-duration` of the inner video (seconds).
 * @property {MotionSpec} spec
 * @property {number} movementSeconds The movement's own duration in seconds.
 */

/** @param {unknown} v @returns {v is [number, number]} */
function pair(v) {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

/** @param {string | null} text @returns {number | null} A plain non-negative decimal, else null. */
function plainNumber(text) {
  return text !== null && /^\s*(?:\d+(?:\.\d*)?|\.\d+)\s*$/.test(text) ? Number(text) : null;
}

/**
 * Reads a composition file written in the shape above.
 * @param {string} text
 * @param {string} id The host's id.
 * @returns {MotionFile | null} Null when the file is anything else (a graphic, or a B-roll that an
 *   agent wrote in another shape): such a host is then edited like a graphic.
 */
export function readMotion(text, id) {
  const tree = parseHtml(text);
  /** @type {ParsedElement[]} */
  const videos = [];
  /** @type {ParsedElement[]} */
  const motions = [];
  walkElements(tree.document, (node) => {
    const nodeId = node.attrs.find((a) => a.name === "id")?.value;
    if (nodeId === `${id}-video` && node.tagName === "video") {
      const element = elementOf(text, node, tree.offset);
      if (element) videos.push(element);
    } else if (nodeId === `${id}-motion`) {
      const element = elementOf(text, node, tree.offset);
      if (element) motions.push(element);
    }
  });
  const video = videos[0];
  const motion = motions[0];
  if (videos.length !== 1 || motions.length !== 1 || !video || !motion) return null;
  const raw = attrValue(motion, "data-vidai-motion");
  if (raw === null) return null;
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = /** @type {Record<string, unknown>} */ (value);
  if (!pair(v.scale) || !pair(v.x) || typeof v.duration !== "number" || !(v.duration > 0))
    return null;
  const src = attrValue(video, "src");
  const mediaStartText = attrValue(video, "data-media-start") ?? "0";
  const durationText = attrValue(video, "data-duration");
  const rateText = attrValue(video, "data-playback-rate");
  const rate = rateText === null ? 1 : plainNumber(rateText);
  if (!src || plainNumber(mediaStartText) === null || plainNumber(durationText) === null)
    return null;
  if (rate === null || rate <= 0) return null;
  if (attrValue(video, "data-start") === null || Number(attrValue(video, "data-start")) !== 0)
    return null;
  return {
    id,
    text,
    video,
    motion,
    src,
    rate,
    mediaStartText,
    durationText: durationText ?? "",
    spec: { scale: v.scale, x: v.x },
    movementSeconds: v.duration,
  };
}

/**
 * @param {{ compositions?: Map<string, string> } | null} facts What `loadProject` read.
 * @param {string} id A host's id.
 * @returns {MotionFile | null} The host's motion file, null when it is not a B-roll with motion.
 */
export function motionOfHost(facts, id) {
  const text = facts?.compositions?.get(id);
  return text === undefined ? null : readMotion(text, id);
}

/**
 * Where the host's first frame is in the source and how long the inner video lasts, in project frames
 * (the in-point may fall between two frames).
 * @param {MotionFile} file
 * @param {Fps} fps
 * @returns {{ mediaStart: number, inner: number }}
 */
export function motionFrames(file, fps) {
  return {
    mediaStart: readSeconds(file.mediaStartText, fps)?.exact ?? 0,
    inner: readSeconds(file.durationText, fps)?.exact ?? 0,
  };
}

/**
 * How long the inner video lasts for a host of `durFrames` that starts `mediaStartFrames` into a file of
 * `sourceFrames` (all in project frames): as long as the file allows, but at most 10 minutes more than
 * the host. The same rule as the toolkit's.
 * @param {number} sourceFrames
 * @param {number} mediaStartFrames
 * @param {number} rate
 * @param {number} durFrames
 * @param {Fps} fps
 * @returns {number} Frames.
 */
export function innerFrames(sourceFrames, mediaStartFrames, rate, durFrames, fps) {
  const room = Math.floor((sourceFrames - mediaStartFrames) / rate + TOLERANCE);
  const extra = Math.round((INNER_EXTRA_SECONDS * fps.num) / fps.den);
  return Math.max(durFrames, Math.min(room, durFrames + extra));
}

/** @param {number} n @returns {string} At most 6 decimals, no exponent, no trailing zeros. */
function fmt(n) {
  return String(Number(n.toFixed(6)));
}

/**
 * The text of `data-vidai-motion`.
 * @param {MotionSpec} spec
 * @param {string} durationText The movement's length in seconds, as text.
 * @returns {string}
 */
export function motionJson(spec, durationText) {
  const [s0, s1] = spec.scale;
  const [x0, x1] = spec.x;
  return `{"scale":[${fmt(s0)},${fmt(s1)}],"x":[${fmt(x0)},${fmt(x1)}],"duration":${durationText}}`;
}

/**
 * The movement at a fraction of its way (it is linear, so a piece of it is a movement of its own).
 * @param {MotionSpec} spec
 * @param {number} f 0 to 1
 * @returns {{ scale: number, x: number }}
 */
export function motionAt(spec, f) {
  return {
    scale: spec.scale[0] + (spec.scale[1] - spec.scale[0]) * f,
    x: spec.x[0] + (spec.x[1] - spec.x[0]) * f,
  };
}

/**
 * The file's text after a change of the host: the in-point, the inner length and the movement. Only
 * attribute values of the two elements change.
 * @param {MotionFile} file
 * @param {Object} to
 * @param {Fps} to.fps
 * @param {number} to.mediaStart In-point in project frames.
 * @param {number} to.inner Inner video length in frames.
 * @param {number} to.duration The host's length in frames (the movement runs over it).
 * @param {MotionSpec} to.spec
 * @returns {string}
 */
export function writeMotion(file, to) {
  const edits = [
    ...attrEdits(file.video, {
      "data-media-start": framesToSecondsText(Math.max(0, to.mediaStart), to.fps),
      "data-duration": framesToSecondsText(to.inner, to.fps),
    }),
    ...attrEdits(file.motion, {
      "data-vidai-motion": motionJson(to.spec, framesToSecondsText(to.duration, to.fps)),
    }),
  ];
  return applyEdits(file.text, edits);
}

/** @param {string} text @returns {string} */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The file of a copy: every use of the composition id (the root, box and video ids, the composition id
 * and the timeline key) becomes the new id. Paths such as `assets/media/b-1.mp4` are left alone.
 * @param {MotionFile} file
 * @param {string} newId
 * @returns {string} The new text; throws `invalidInput` when the result would not read back.
 */
export function copyMotionText(file, newId) {
  const pattern = new RegExp(
    `(?<![\\w./-])${escapeRegExp(file.id)}(?=-(?:root|motion|video)(?![\\w-])|["'\\]])`,
    "g",
  );
  const text = file.text.replace(pattern, newId);
  if (readMotion(text, newId) === null) {
    throw invalidInput(
      "This B-roll's file is not in the shape VidAI wrote, so it cannot be split.",
    );
  }
  return text;
}

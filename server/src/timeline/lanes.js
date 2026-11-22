// The fades in the sound of the A-roll (docs/SPEC.md sections 10 and 11) and the one rule that says
// where they are. The toolkit's exporter (`hfproject.py`, `fade_plan`) holds the same rule; the table
// `server/test/support/fixtures/fade-rule.json` is run by both sides' tests, so change the rule, the
// table and the exporter together.
//
// A fade is a clip-edge fade of HyperFrames, `data-fade-in` and `data-fade-out` on the A-roll `<video>`
// (seconds, linear, multiplied on `data-volume`). The sound stays on the picture, so these fades follow
// it when a person trims, moves, splits or deletes A-roll clips; after every hand edit the server writes
// them again from the rule, so none is left behind by an edit that made it obsolete.
//
// The rule, for the A-roll clips with sound in the order they play:
// - A cut between two different sources gets an 8 ms fade out at the end of the first clip and an 8 ms
//   fade in at the start of the second (a de-click). A cut that continues the same source (same file,
//   same speed, the second starts where the first stops) gets nothing: the sound is whole there.
// - The first clip fades in over 8 ms (the video starts from silence).
// - The last clip's tail is the end fade: its length is `endFrames` (the length of the end fade picture
//   clip, kind "fade"), at most the clip's own length; without an end fade it is the 8 ms de-click.
// - A clip shorter than four de-clicks (32 ms) has no fades.
// - A clip with no sound (`muted`) has none, and does not continue anything.
//
// A project "manages fades" when an A-roll clip carries one (an attribute, or a volume lane that holds
// nothing but 0 and 1, which is what toolkit 1.2 wrote); a project with none is left as it is, so a
// project written some other way keeps the sound it has.

import { attrValue } from "./document.js";
import { framesToSecondsText, readSeconds } from "./frames.js";
import { MEDIA_TOLERANCE } from "./profile.js";

/** @typedef {import("./document.js").ParsedElement} ParsedElement */
/** @typedef {import("./frames.js").Fps} Fps */

/** The de-click, in seconds as written in a file. */
export const DECLICK_TEXT = "0.008";

/**
 * An A-roll clip as the fade rule sees it.
 * @typedef {Object} FadeClip
 * @property {string | null} src
 * @property {number} mediaStart In-point in project frames.
 * @property {number} rate
 * @property {number} dur Length in frames.
 * @property {boolean} sound Whether the clip plays its sound.
 */

/**
 * The fades of one clip, in seconds as text; null for none.
 * @typedef {Object} FadePair
 * @property {string | null} fadeIn
 * @property {string | null} fadeOut
 */

/**
 * @param {FadeClip} a
 * @param {FadeClip} b The clip right after `a`.
 * @returns {boolean} Whether the sound goes on across the cut.
 */
function continues(a, b) {
  return (
    a.sound &&
    b.sound &&
    a.src !== null &&
    a.src === b.src &&
    a.rate === b.rate &&
    Math.abs(a.mediaStart + a.dur * a.rate - b.mediaStart) <= MEDIA_TOLERANCE
  );
}

/**
 * The fade rule.
 * @param {FadeClip[]} clips The A-roll in playing order.
 * @param {Fps} fps
 * @param {number} endFrames Length of the end fade in frames, 0 for none.
 * @returns {FadePair[]} One pair per clip.
 */
export function planFades(clips, fps, endFrames) {
  return clips.map((clip, i) => {
    // 4 de-clicks: dur / fps < 4 * 0.008 s, in whole numbers (frames * den * 1000 < 32 * num).
    if (!clip.sound || clip.dur * fps.den * 1000 < 32 * fps.num) {
      return { fadeIn: null, fadeOut: null };
    }
    const previous = clips[i - 1];
    const next = clips[i + 1];
    const fadeIn = previous && continues(previous, clip) ? null : DECLICK_TEXT;
    /** @type {string | null} */
    let fadeOut;
    if (!next) {
      fadeOut =
        endFrames > 0 ? framesToSecondsText(Math.min(endFrames, clip.dur), fps) : DECLICK_TEXT;
    } else {
      fadeOut = continues(clip, next) ? null : DECLICK_TEXT;
    }
    return { fadeIn, fadeOut };
  });
}

/**
 * Whether a `data-automation` value is a volume lane of nothing but fades (every point 0 or 1), the
 * shape of toolkit 1.2; such a lane is replaced by the fade attributes.
 * @param {string | null} text
 * @returns {boolean}
 */
export function isPureFadeLane(text) {
  if (text === null) return false;
  try {
    const value = /** @type {unknown} */ (JSON.parse(text));
    if (typeof value !== "object" || value === null) return false;
    const lanes = /** @type {{ lanes?: unknown }} */ (value).lanes;
    if (!Array.isArray(lanes) || lanes.length !== 1) return false;
    const lane = /** @type {{ target?: unknown, points?: unknown }} */ (lanes[0]);
    if (lane.target !== "volume" || !Array.isArray(lane.points) || lane.points.length === 0)
      return false;
    return lane.points.every(
      (/** @type {{ v?: unknown }} */ point) => point?.v === 0 || point?.v === 1,
    );
  } catch {
    return false;
  }
}

/**
 * @param {ParsedElement} element An A-roll clip.
 * @returns {boolean} Whether it carries a fade this module manages.
 */
export function carriesFade(element) {
  return (
    attrValue(element, "data-fade-in") !== null ||
    attrValue(element, "data-fade-out") !== null ||
    isPureFadeLane(attrValue(element, "data-automation"))
  );
}

/**
 * @param {ParsedElement} element
 * @param {Fps} fps
 * @returns {number} The clip's `data-fade-out` in frames (0 when absent or not a number).
 */
export function fadeOutFrames(element, fps) {
  return readSeconds(attrValue(element, "data-fade-out"), fps)?.exact ?? 0;
}

/** @param {string | null} a @param {string | null} b @returns {boolean} */
function sameSeconds(a, b) {
  if (a === null || b === null) return a === b;
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1e-9;
}

/**
 * The attribute changes that give an A-roll clip's start tag the wanted fades: attributes to set (the
 * ones that differ) and attributes to remove (a fade that is no longer wanted, a lane of nothing but
 * fades). Works the same for a copy of the clip, which starts as the clip's text.
 * @param {ParsedElement} element
 * @param {FadePair} want
 * @returns {{ set: Record<string, string>, remove: string[] }}
 */
export function fadeChanges(element, want) {
  /** @type {Record<string, string>} */
  const set = {};
  /** @type {string[]} */
  const remove = [];
  for (const [name, text] of /** @type {const} */ ([
    ["data-fade-in", want.fadeIn],
    ["data-fade-out", want.fadeOut],
  ])) {
    const have = attrValue(element, name);
    if (text === null) {
      if (have !== null) remove.push(name);
    } else if (!sameSeconds(have, text)) {
      set[name] = text;
    }
  }
  if (isPureFadeLane(attrValue(element, "data-automation"))) remove.push("data-automation");
  return { set, remove };
}

// A motion graphic host whose composition file plays timed media of the project's own sources (docs/SPEC.md
// sections 10 and 11) is edited so that the media stay in step with the clip. The toolkit writes such a
// host for a synced B-roll layout (`layout_composition` in `hfproject.py`): a background picture, a muted
// screen recording `<id>-screen` and a muted round host video `<id>-host` inside `<id>-pip`, and, when the
// B-roll moves, one linear movement of the whole picture in `data-vidai-layout-motion` (the shape of
// `data-vidai-motion`, see `editMotion.js`).
//
// HyperFrames reads a video's `data-media-start` and `data-duration` from the static text of the file, so
// the host cannot pass its in-point down: when the first edge of the host moves by k frames, or a split
// starts a part k frames in, every inner medium's `data-media-start` moves by k frames of the source
// (k times its speed), so each shows the same source frame at the same timeline frame as before. The
// inner `data-duration` follows the rule of a B-roll with motion (as long as the source allows, at most
// 10 minutes more than the host), and the movement, when there is one, runs over the host's length.
//
// An inner medium counts when it is a `<video>` or `<audio>` with a `src` listed in `edit.json`, a plain
// `data-duration`, `data-start="0"` and a plain `data-media-start` and `data-playback-rate` (or none).
// Anything else in the file (a picture, a decorative clip from `assets/`) is left alone.
//
// An inner medium whose `src` is also the `src` of an A-roll clip is a synced medium (the round host
// video): it is not shifted like the others but written again after every edit so that, at every frame
// of the host, it shows the A-roll frame that is audible then (`editSync.js`): one inner video per
// stretch of the host over one A-roll clip, each with its own `data-start`, `data-duration`,
// `data-media-start` and `data-playback-rate`. The first piece is the element that was there, the
// others are copies of it with new ids (and copies of its CSS rules by id), and surplus pieces are
// removed. A synced medium may have any plain `data-start` (the pieces after the first do).

import {
  attrEdits,
  attrRemovalEdits,
  applyEdits,
  attrValue,
  copyAfterEdit,
  elementOf,
  parseHtml,
  removalEdit,
  uniqueId,
  walkElements,
} from "./document.js";
import { innerFrames, motionJson, parseMotionJson, plainNumber, snap } from "./editMotion.js";
import { piecesMatch } from "./editSync.js";
import { framesToSecondsText, readSeconds, sourceLengthFrames } from "./frames.js";

/** @typedef {import("./document.js").ParsedElement} ParsedElement */
/** @typedef {import("./frames.js").Fps} Fps */
/** @typedef {import("./editMotion.js").MotionSpec} MotionSpec */
/** @typedef {import("./profileEditJson.js").EditFacts} EditFacts */
/** @typedef {import("./editSync.js").SyncPiece} SyncPiece */

/**
 * One timed medium inside the file.
 * @typedef {Object} InnerMedia
 * @property {ParsedElement} element
 * @property {string} src
 * @property {number} rate Source seconds per timeline second (1 when absent).
 * @property {number} start `data-start` in project frames, counted from the host's first frame (0 unless `sync`).
 * @property {boolean} sync Whether the medium plays an A-roll source and so follows the A-roll (see above).
 * @property {string} group Media of one `group` are the pieces of one picture (same parent and track).
 * @property {number} duration `data-duration` in project frames: how long the medium lasts in the file.
 * @property {number} mediaStart In-point in project frames (snapped to a whole frame when it is within 0.01).
 * @property {number} sourceLength Length of the source in project frames.
 */

/**
 * @typedef {Object} InnerFile
 * @property {string} id The host's id.
 * @property {string} text The file as read.
 * @property {InnerMedia[]} media At least one.
 * @property {{ element: ParsedElement, spec: MotionSpec } | null} layout The movement of the whole picture.
 */

/** Slack, in frames, when comparing lengths (as in the profile). */
const TOLERANCE = 0.01;

/** No A-roll source: nothing in the file is synced. */
const NO_SOURCES = new Set();

/** The attribute that carries the movement of a layout. */
export const LAYOUT_MOTION = "data-vidai-layout-motion";

/**
 * @param {string} text A composition file.
 * @param {string} id The host's id.
 * @param {EditFacts} facts
 * @param {ReadonlySet<string>} [arollSources] The `src` of every A-roll clip (`arollSources`).
 * @returns {InnerFile | null} Null when the file plays no timed medium of the project's sources.
 */
export function readInner(text, id, facts, arollSources = NO_SOURCES) {
  const tree = parseHtml(text);
  /** @type {Map<unknown, number>} */
  const parents = new Map();
  /** @type {InnerMedia[]} */
  const media = [];
  /** @type {InnerFile["layout"]} */
  let layout = null;
  walkElements(tree.document, (node) => {
    const element = elementOf(text, node, tree.offset);
    if (!element) return;
    if (!layout && attrValue(element, LAYOUT_MOTION) !== null) {
      const parsed = parseMotionJson(attrValue(element, LAYOUT_MOTION) ?? "");
      if (parsed) layout = { element, spec: parsed.spec };
    }
    if (node.tagName !== "video" && node.tagName !== "audio") return;
    const src = attrValue(element, "src");
    const source = src === null ? undefined : facts.sourcesByPath.get(src);
    if (src === null || !source) return;
    const start = attrValue(element, "data-start");
    const duration = attrValue(element, "data-duration");
    const inText = attrValue(element, "data-media-start") ?? "0";
    const rateText = attrValue(element, "data-playback-rate");
    const rate = rateText === null ? 1 : plainNumber(rateText);
    const sync = arollSources.has(src);
    const startNumber = start === null ? null : plainNumber(start);
    if (startNumber === null || startNumber < 0 || (!sync && startNumber !== 0)) return;
    if (plainNumber(duration) === null) return;
    if (plainNumber(inText) === null || rate === null || rate <= 0) return;
    const mediaStart = readSeconds(inText, facts.fps)?.exact ?? 0;
    const parent = node.parentNode;
    if (!parents.has(parent)) parents.set(parent, parents.size);
    media.push({
      element,
      src,
      start: snap(readSeconds(start ?? "0", facts.fps)?.exact ?? 0),
      sync,
      group: `${parents.get(parent)}/${attrValue(element, "data-track-index") ?? ""}`,
      rate,
      duration: snap(readSeconds(duration ?? "", facts.fps)?.exact ?? 0),
      mediaStart: snap(mediaStart),
      sourceLength: sourceLengthFrames(source, facts.fps),
    });
  });
  return media.length === 0 ? null : { id, text, media, layout };
}

/**
 * @param {EditFacts | null} facts What `loadProject` read.
 * @param {string} id A host's id.
 * @param {ReadonlySet<string>} [arollSources]
 * @returns {InnerFile | null}
 */
export function innerOfHost(facts, id, arollSources = NO_SOURCES) {
  const text = facts?.compositions?.get(id);
  return facts && text !== undefined ? readInner(text, id, facts, arollSources) : null;
}

/**
 * The sources the A-roll plays.
 * @param {{ track: number | null, src: string | null }[]} clips The clips of `index.html`.
 * @returns {Set<string>}
 */
export function arollSources(clips) {
  return new Set(
    clips.flatMap((c) => (c.track === 0 && c.src !== null && c.src !== "" ? [c.src] : [])),
  );
}

/**
 * Whether the first edge of the host may move by `k` frames and the host last `dur` frames afterwards.
 * @param {InnerFile} file
 * @param {number} dur The host's new length in frames.
 * @param {number} k Frames the host's first edge moves by (negative: earlier); 0 for the other edge.
 * @param {number} tolerance Slack in frames.
 * @returns {string | null} A sentence for the user when a source does not allow it, else null.
 */
export function innerProblem(file, dur, k, tolerance) {
  for (const m of file.media) {
    if (m.sync) continue;
    if (k < 0 && m.mediaStart + k * m.rate < -tolerance) {
      const room = Math.floor(m.mediaStart / m.rate + tolerance);
      return `This clip cannot start earlier: its source file begins only ${room} frames before the point where it starts now.`;
    }
    const newIn = m.mediaStart + k * m.rate;
    if (newIn + dur * m.rate > m.sourceLength + tolerance) {
      const room = Math.floor((m.sourceLength - newIn) / m.rate + tolerance);
      return `This clip cannot be made longer: its source file only has ${room} frames from where the clip starts, so it can last at most ${room} frames.`;
    }
  }
  return null;
}

/**
 * The synced media of the file, as groups of pieces of one picture, each in time order.
 * @param {InnerFile} file
 * @returns {InnerMedia[][]}
 */
function syncGroups(file) {
  /** @type {Map<string, InnerMedia[]>} */
  const groups = new Map();
  for (const m of file.media) {
    if (m.sync) groups.set(m.group, [...(groups.get(m.group) ?? []), m]);
  }
  return [...groups.values()].map((g) => [...g].sort((a, b) => a.start - b.start));
}

/**
 * Whether the file has to be written for a host that will last `duration` frames.
 * @param {InnerFile} file
 * @param {Object} to
 * @param {number} to.shift
 * @param {number} to.duration
 * @param {boolean} to.moves Whether the movement changes.
 * @param {SyncPiece[] | null} [to.pieces] What the synced media must show (null: the host is not synced).
 * @returns {boolean}
 */
export function innerChanges(file, to) {
  const plain = file.media.filter((m) => !m.sync);
  return (
    (plain.length > 0 && to.shift !== 0) ||
    to.moves ||
    plain.some((m) => m.duration + TOLERANCE < to.duration) ||
    (to.pieces !== undefined &&
      to.pieces !== null &&
      to.pieces.length > 0 &&
      syncGroups(file).some((g) => !piecesMatch(g, to.pieces ?? [])))
  );
}

/**
 * The ids a file uses.
 * @param {string} text
 * @returns {Set<string>}
 */
function idsOf(text) {
  const tree = parseHtml(text);
  /** @type {Set<string>} */
  const ids = new Set();
  walkElements(tree.document, (node) => {
    const id = nodeIdOf(text, node, tree.offset);
    if (id !== null) ids.add(id);
  });
  return ids;
}

/**
 * @param {string} text
 * @param {Parameters<typeof elementOf>[1]} node
 * @param {number} offset
 * @returns {string | null}
 */
function nodeIdOf(text, node, offset) {
  const element = elementOf(text, node, offset);
  return element ? attrValue(element, "id") : null;
}

/** @param {number} n @returns {string} A playback rate as text (at most 9 decimals). */
function rateText(n) {
  return String(Number(n.toFixed(9)));
}

/**
 * The CSS rules of `#<from>` in the file's style, copied for `#<to>` (the pieces after the first are
 * styled like it, and the toolkit styles by id).
 * @param {string} text
 * @param {string[]} from Ids whose rules are copied (the first with any rule counts).
 * @param {string} to
 * @returns {import("./document.js").TextEdit[]}
 */
function cssCopies(text, from, to) {
  if (new RegExp(`#${escapeRegExp(to)}\\s*[{,]`).test(text)) return [];
  for (const id of from) {
    const rule = new RegExp(`#${escapeRegExp(id)}(\\s*\\{[^{}]*\\})`, "g");
    const edits = [...text.matchAll(rule)].map((m) => {
      const at = (m.index ?? 0) + m[0].length;
      return { start: at, end: at, text: `\n#${to}${m[1] ?? ""}` };
    });
    if (edits.length > 0) return edits;
  }
  return [];
}

/** @param {string} s @returns {string} */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The edits that make one group of synced media show the pieces: the existing elements take the first
 * pieces' attributes, missing pieces are copies of the last existing element after it (new ids, CSS
 * rules copied), surplus elements are removed.
 * @param {string} text
 * @param {InnerMedia[]} group At least one.
 * @param {SyncPiece[]} pieces At least one.
 * @param {Fps} fps
 * @param {Set<string>} taken Ids in use; the new ids are added.
 * @returns {import("./document.js").TextEdit[]}
 */
function groupEdits(text, group, pieces, fps, taken) {
  /** @type {import("./document.js").TextEdit[]} */
  const edits = [];
  /** @param {SyncPiece} p @returns {Record<string, string>} */
  const attrsOf = (p) => ({
    src: p.src,
    "data-start": framesToSecondsText(p.start, fps),
    "data-duration": framesToSecondsText(p.dur, fps),
    "data-media-start": framesToSecondsText(Math.max(0, p.mediaStart), fps),
    ...(p.rate === 1 ? {} : { "data-playback-rate": rateText(p.rate) }),
  });
  /** @param {SyncPiece} p @returns {string[]} */
  const dropsOf = (p) => (p.rate === 1 ? ["data-playback-rate"] : []);
  const keep = Math.min(group.length, pieces.length);
  for (let i = 0; i < keep; i++) {
    const m = /** @type {InnerMedia} */ (group[i]);
    const p = /** @type {SyncPiece} */ (pieces[i]);
    edits.push(
      ...attrEdits(m.element, attrsOf(p)),
      ...attrRemovalEdits(text, m.element, dropsOf(p)),
    );
  }
  for (const m of group.slice(keep)) edits.push(removalEdit(text, m.element));
  const last = /** @type {InnerMedia} */ (group[keep - 1]);
  const ids = group.map((m) => attrValue(m.element, "id") ?? "").filter((id) => id !== "");
  const base = ids[0] ?? "";
  /** @type {import("./document.js").TextEdit[]} */
  const copies = [];
  for (const p of pieces.slice(keep)) {
    const id = uniqueId(base || "sync", taken);
    taken.add(id);
    copies.push(copyAfterEdit(text, last.element, { ...attrsOf(p), id }, dropsOf(p)));
    if (base !== "") edits.push(...cssCopies(text, ids, id));
  }
  if (copies.length > 0) {
    const at = /** @type {import("./document.js").TextEdit} */ (copies[0]);
    edits.push({ start: at.start, end: at.end, text: copies.map((c) => c.text).join("") });
  }
  return edits;
}

/**
 * The file's text after a change of the host: every medium's in-point and length, and the movement.
 * Only attribute values change, except that the synced media are written as the pieces say (above).
 * @param {InnerFile} file
 * @param {Object} to
 * @param {Fps} to.fps
 * @param {number} to.shift Frames the host's first frame moved on in the source (k; the in-points move by k times the speed).
 * @param {number} to.duration The host's length in frames.
 * @param {MotionSpec | null} to.spec The movement it will have.
 * @param {{ pieces: SyncPiece[], taken: Set<string> } | null} [to.sync] What the synced media show;
 *   `taken` holds the ids of the project, which the new pieces' ids avoid.
 * @returns {string}
 */
export function writeInner(file, to) {
  const edits = file.media
    .filter((m) => !m.sync)
    .flatMap((m) => {
      const mediaStart = Math.max(0, m.mediaStart + to.shift * m.rate);
      return attrEdits(m.element, {
        "data-media-start": framesToSecondsText(mediaStart, to.fps),
        "data-duration": framesToSecondsText(
          innerFrames(m.sourceLength, mediaStart, m.rate, to.duration, to.fps),
          to.fps,
        ),
      });
    });
  if (to.sync && to.sync.pieces.length > 0) {
    const taken = new Set([...to.sync.taken, ...idsOf(file.text)]);
    for (const group of syncGroups(file)) {
      if (!piecesMatch(group, to.sync.pieces))
        edits.push(...groupEdits(file.text, group, to.sync.pieces, to.fps, taken));
    }
  }
  if (file.layout && to.spec) {
    edits.push(
      ...attrEdits(file.layout.element, {
        [LAYOUT_MOTION]: motionJson(to.spec, framesToSecondsText(to.duration, to.fps)),
      }),
    );
  }
  return applyEdits(file.text, edits);
}

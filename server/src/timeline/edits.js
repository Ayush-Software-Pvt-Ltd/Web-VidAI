// Hand edits of the timeline (docs/SPEC.md section 11, "Hand edits"): trim, delete, split and move,
// planned on plain records of frames (ripple rules in `ripple.js`) and written back by changing only
// clip attributes, removing clip elements or inserting a copy of one (`document.js`).

import { AppError, invalidInput } from "../errors.js";
import {
  attrEdits,
  attrRemovalEdits,
  applyEdits,
  copyAfterEdit,
  findAttr,
  parseProject,
  removalEdit,
  uniqueId,
} from "./document.js";
import {
  copyMotionText,
  innerFrames,
  motionAt,
  motionFrames,
  motionOfHost,
  readMotion,
  writeMotion,
} from "./editMotion.js";
import { framesToSecondsText } from "./frames.js";
import { carriesFade, fadeChanges, fadeOutFrames, planFades } from "./lanes.js";
import { MEDIA_TOLERANCE, checkDocument, kindNoun, sourceLengthFrames } from "./profile.js";
import {
  MIN_FRAMES,
  settleOthers,
  startAfterInsertion,
  startAfterMove,
  startAfterRemoval,
} from "./ripple.js";

/** @typedef {import("../../../src/lib/wire/timeline.ts").TimelineOp} TimelineOp */
/** @typedef {import("./document.js").ParsedProject} ParsedProject */
/** @typedef {import("./document.js").ParsedClip} ParsedClip */
/** @typedef {import("./profileEditJson.js").EditFacts} EditFacts */
/** @typedef {import("./editMotion.js").MotionFile} MotionFile */
/** @typedef {import("./editMotion.js").MotionSpec} MotionSpec */

/**
 * A clip as the planner sees it.
 * @typedef {Object} EditClip
 * @property {string} id
 * @property {number} track
 * @property {string} kind
 * @property {number} order
 * @property {number} start
 * @property {number} dur
 * @property {number | null} mediaStart In-point in frames (video, audio and a motion B-roll), else null.
 * @property {number} rate
 * @property {boolean} isHost
 * @property {MotionFile | null} motion The file of a B-roll with motion (`editMotion.js`).
 * @property {MotionSpec | null} motionSpec The movement it will have.
 * @property {number | null} sourceLength Source length in project frames (video, audio, motion B-roll).
 * @property {boolean} removed
 * @property {ParsedClip} parsed
 * @property {number} start0
 * @property {number} dur0
 * @property {number | null} mediaStart0
 */

/**
 * @typedef {Object} AddedClip
 * @property {EditClip} from
 * @property {string} id
 * @property {number} start
 * @property {number} dur
 * @property {number | null} mediaStart
 * @property {MotionSpec | null} motionSpec
 */

/**
 * @typedef {Object} Plan
 * @property {AddedClip[]} added
 * @property {string} verb
 */

const MAX_FRAME = 1_000_000_000;

/** An in-point within this many frames of a whole frame is taken as that frame (no drift). */
const SNAP = 0.01;

/** @param {unknown} value @param {string} what @returns {number} */
function frameOf(value, what) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_FRAME) {
    throw invalidInput(`The ${what} must be a whole number of frames, 0 or more.`);
  }
  return value;
}

/**
 * @param {unknown} op
 * @returns {TimelineOp}
 */
function validateOp(op) {
  if (typeof op !== "object" || op === null) throw invalidInput("The edit is missing.");
  const o = /** @type {Record<string, unknown>} */ (op);
  if (typeof o.clipId !== "string" || o.clipId === "")
    throw invalidInput("The edit does not say which clip it is about.");
  switch (o.type) {
    case "delete":
      return { type: "delete", clipId: o.clipId };
    case "trim":
      if (o.edge !== "start" && o.edge !== "end")
        throw invalidInput('A trim must say which edge to move, "start" or "end".');
      return {
        type: "trim",
        clipId: o.clipId,
        edge: o.edge,
        frame: frameOf(o.frame, "frame to trim to"),
      };
    case "split":
      return { type: "split", clipId: o.clipId, frame: frameOf(o.frame, "frame to split at") };
    case "move":
      return { type: "move", clipId: o.clipId, frame: frameOf(o.frame, "frame to move to") };
    default:
      throw invalidInput("This kind of edit is not known.");
  }
}

/** @param {number} x @returns {number} */
function snap(x) {
  return Math.abs(x - Math.round(x)) <= SNAP ? Math.round(x) : x;
}

/**
 * @param {ParsedProject} parsed
 * @param {EditFacts} facts
 * @returns {EditClip[]}
 */
function buildClips(parsed, facts) {
  const fps = facts.fps;
  return parsed.clips.map((c) => {
    const motion = c.isHost && c.id !== null ? motionOfHost(facts, c.id) : null;
    const timed = c.tag === "video" || c.tag === "audio";
    const sourcePath = motion ? motion.src : timed ? c.src : null;
    const source = sourcePath !== null ? facts.sourcesByPath.get(sourcePath) : undefined;
    const mediaStart = motion
      ? snap(motionFrames(motion, fps).mediaStart)
      : timed
        ? snap(c.mediaStart ?? 0)
        : null;
    return {
      id: /** @type {string} */ (c.id),
      track: /** @type {number} */ (c.track),
      kind: /** @type {string} */ (c.kind),
      order: c.index,
      start: /** @type {number} */ (c.start),
      dur: /** @type {number} */ (c.duration),
      mediaStart,
      rate: motion ? motion.rate : (c.rate ?? 1),
      isHost: c.isHost,
      motion,
      motionSpec: motion ? motion.spec : null,
      sourceLength: source ? sourceLengthFrames(source, fps) : null,
      removed: false,
      parsed: c,
      start0: /** @type {number} */ (c.start),
      dur0: /** @type {number} */ (c.duration),
      mediaStart0: mediaStart,
    };
  });
}

/**
 * A project file other than `index.html` that an edit writes (a B-roll with motion has one).
 * @typedef {Object} ProjectFile
 * @property {string} path Project-relative with `/`, always `compositions/<id>.html`.
 * @property {string} text
 * @property {string | null} before What the file held (null: a new file).
 */

/**
 * @typedef {Object} EditResult
 * @property {string} html The new text of `index.html`.
 * @property {string} label The revision label ("Trim A-roll").
 * @property {ProjectFile[]} files The composition files to write, before `index.html` is.
 * @property {EditFacts} facts The facts of the project after the edit (the new composition files
 *   included): the profile check of the result needs these, not the old ones.
 */

/**
 * Applies one hand edit to the text of `index.html` and to the files of the B-roll it moves.
 * @param {string} html
 * @param {TimelineOp} op
 * @param {EditFacts} facts What `loadProject` read (frame rate, source lengths, motion files).
 * @returns {EditResult}
 * @throws {AppError} `invalidInput` with a sentence for the user when the edit is not allowed (the
 *   text is untouched); `internal` when an allowed edit would have broken the profile (a bug).
 */
export function applyOp(html, op, facts) {
  const operation = validateOp(op);
  const parsed = parseProject(html);
  const before = checkDocument(parsed, facts);
  if (before.length > 0) {
    throw invalidInput(
      `The project does not follow VidAI's rules yet, so it cannot be edited by hand: ${before[0]?.message ?? ""}`,
    );
  }
  const clips = buildClips(parsed, facts);
  const clip = clips.find((c) => c.id === operation.clipId);
  if (!clip) throw invalidInput(`There is no clip "${operation.clipId}" in this video.`);

  const taken = new Set(parsed.idCounts.keys());
  const plan = planOperation(clips, clip, operation, taken);
  const written = write(html, parsed, clips, plan, facts);
  const next = written.html;
  const nextFacts = {
    ...facts,
    compositions: new Map([
      ...(facts.compositions ?? []),
      ...written.files.map(
        (f) => /** @type {[string, string]} */ ([compositionId(f.path), f.text]),
      ),
    ]),
  };
  const after = checkDocument(parseProject(next), nextFacts);
  if (after.length > 0) {
    throw new AppError(
      "internal",
      `A ${plan.verb.toLowerCase()} edit would have broken the project's rules (${after[0]?.message ?? ""}); nothing was changed.`,
    );
  }
  return {
    html: next,
    label: `${plan.verb} ${kindNoun(clip.kind)}`,
    files: written.files,
    facts: nextFacts,
  };
}

/** @param {string} path `compositions/<id>.html` @returns {string} The id. */
function compositionId(path) {
  return path.slice("compositions/".length, -".html".length);
}

/**
 * @param {EditClip[]} clips
 * @param {EditClip} clip
 * @param {TimelineOp} op
 * @param {Set<string>} taken
 * @returns {Plan}
 */
function planOperation(clips, clip, op, taken) {
  switch (op.type) {
    case "delete":
      return planDelete(clips, clip);
    case "trim":
      return clip.track === 0
        ? planTrimAroll(clips, clip, op.edge, op.frame)
        : planTrimOther(clips, clip, op.edge, op.frame);
    case "split":
      return planSplit(clip, op.frame, taken);
    case "move":
      return clip.track === 0
        ? planMoveAroll(clips, clip, op.frame)
        : planMoveOther(clips, clip, op.frame);
  }
}

/** @param {EditClip[]} clips @returns {EditClip[]} */
function arollOf(clips) {
  return clips
    .filter((c) => c.track === 0 && !c.removed)
    .sort((a, b) => a.start - b.start || a.order - b.order);
}

/** @param {EditClip[]} clips @returns {EditClip[]} */
function othersOf(clips) {
  return clips.filter((c) => c.track !== 0);
}

/**
 * Lays the A-roll out again without gaps from frame 0 in the given order.
 * @param {EditClip[]} order
 * @returns {number} The new end of the video.
 */
function layout(order) {
  let at = 0;
  for (const c of order) {
    c.start = at;
    at += c.dur;
  }
  return at;
}

/**
 * Moves the other tracks by `map` (a function of each clip's old start), then fits and settles them.
 * The end fade picture (kind "fade") that ended the video stays at the end, with its own length, when
 * the video gets shorter or longer: the sound's end fade follows its length (`lanes.js`), so the two
 * stay together.
 * @param {EditClip[]} clips
 * @param {EditClip[]} order The A-roll in its new order.
 * @param {(start: number) => number} map
 */
function rippleOthers(clips, order, map) {
  const others = othersOf(clips).filter((c) => !c.removed);
  const oldTotal = Math.max(0, ...clips.filter((c) => c.track === 0).map((c) => c.start0 + c.dur0));
  const anchored = others.filter((c) => c.kind === "fade" && c.start0 + c.dur0 === oldTotal);
  for (const c of others) c.start = map(c.start);
  const total = layout(order);
  for (const c of anchored) {
    c.dur = Math.min(c.dur0, total);
    c.start = total - c.dur;
  }
  settleOthers(others, total);
}

/** @param {EditClip} clip @param {string} message */
function assertPlain(clip, message) {
  if (clip.rate !== 1) throw invalidInput(message);
}

const SPEED =
  "This clip plays at a different speed, which hand edits do not support, so it cannot be trimmed or split.";

/**
 * @param {EditClip[]} clips
 * @param {EditClip} clip
 * @returns {Plan}
 */
function planDelete(clips, clip) {
  if (clip.track !== 0) {
    clip.removed = true;
    return { added: [], verb: "Delete" };
  }
  const aroll = arollOf(clips);
  if (aroll.length === 1)
    throw invalidInput(
      "This is the last A-roll clip, so it cannot be deleted: the video would be empty.",
    );
  const cut = clip.start;
  const length = clip.dur;
  clip.removed = true;
  rippleOthers(
    clips,
    aroll.filter((c) => c !== clip),
    (s) => startAfterRemoval(s, cut, length),
  );
  return { added: [], verb: "Delete" };
}

/**
 * @param {EditClip} clip
 * @param {number} newDur
 * @param {number} k Frames the in-point moves by (negative: earlier).
 */
function checkAnchoredMedia(clip, newDur, k) {
  if (clip.mediaStart === null) return;
  if (k < 0 && clip.mediaStart + k * clip.rate < -MEDIA_TOLERANCE) {
    const room = Math.floor(clip.mediaStart / clip.rate + MEDIA_TOLERANCE);
    throw invalidInput(
      `This clip cannot start earlier: its source file begins only ${room} frames before the point where it starts now.`,
    );
  }
  if (clip.sourceLength !== null) {
    const newIn = clip.mediaStart + k * clip.rate;
    if (newIn + newDur * clip.rate > clip.sourceLength + MEDIA_TOLERANCE) {
      const room = Math.floor((clip.sourceLength - newIn) / clip.rate + MEDIA_TOLERANCE);
      throw invalidInput(
        `This clip cannot be made longer: its source file only has ${room} frames from where the clip starts, so it can last at most ${room} frames.`,
      );
    }
  }
}

/**
 * @param {EditClip[]} clips
 * @param {EditClip} clip
 * @param {"start" | "end"} edge
 * @param {number} frame
 * @returns {Plan}
 */
function planTrimAroll(clips, clip, edge, frame) {
  assertPlain(clip, SPEED);
  const aroll = arollOf(clips);
  const end = clip.start + clip.dur;
  const k = edge === "start" ? frame - clip.start : frame - end;
  if (k === 0) throw invalidInput("The clip's edge is already there.");
  const newDur = edge === "start" ? clip.dur - k : clip.dur + k;
  if (newDur < MIN_FRAMES)
    throw invalidInput(`This clip cannot be made shorter than ${MIN_FRAMES} frames.`);
  checkAnchoredMedia(clip, newDur, edge === "start" ? k : 0);
  /** @type {(s: number) => number} */
  let map;
  if (edge === "start") {
    const at = clip.start;
    map = k > 0 ? (s) => startAfterRemoval(s, at, k) : (s) => startAfterInsertion(s, at, -k);
  } else {
    map = k < 0 ? (s) => startAfterRemoval(s, frame, -k) : (s) => startAfterInsertion(s, end, k);
  }
  if (edge === "start" && clip.mediaStart !== null) clip.mediaStart += k * clip.rate;
  clip.dur = newDur;
  rippleOthers(clips, aroll, map);
  return { added: [], verb: "Trim" };
}

/**
 * @param {EditClip[]} clips
 * @param {EditClip} clip
 * @returns {{ prevEnd: number, nextStart: number }} Where the neighbours on its track stop it.
 */
function neighbours(clips, clip) {
  let prevEnd = 0;
  let nextStart = Infinity;
  for (const c of clips) {
    if (c === clip || c.track !== clip.track || c.removed) continue;
    if (c.start < clip.start) prevEnd = Math.max(prevEnd, c.start + c.dur);
    else nextStart = Math.min(nextStart, c.start);
  }
  return { prevEnd, nextStart };
}

/** @param {EditClip[]} clips @returns {number} */
function totalOf(clips) {
  return arollOf(clips).reduce((sum, c) => sum + c.dur, 0);
}

/**
 * @param {EditClip[]} clips
 * @param {EditClip} clip
 * @param {"start" | "end"} edge
 * @param {number} frame
 * @returns {Plan}
 */
function planTrimOther(clips, clip, edge, frame) {
  assertPlain(clip, SPEED);
  const { prevEnd, nextStart } = neighbours(clips, clip);
  const end = clip.start + clip.dur;
  if (edge === "start") {
    const k = frame - clip.start;
    if (k === 0) throw invalidInput("The clip's edge is already there.");
    const newDur = clip.dur - k;
    if (newDur < MIN_FRAMES)
      throw invalidInput(`This clip cannot be made shorter than ${MIN_FRAMES} frames.`);
    if (frame < prevEnd)
      throw invalidInput(
        `This clip cannot start before frame ${prevEnd}, where the previous clip on its track ends.`,
      );
    checkAnchoredMedia(clip, newDur, k);
    if (clip.mediaStart !== null) clip.mediaStart += k * clip.rate;
    clip.start = frame;
    clip.dur = newDur;
  } else {
    const newDur = frame - clip.start;
    if (frame === end) throw invalidInput("The clip's edge is already there.");
    if (newDur < MIN_FRAMES)
      throw invalidInput(`This clip cannot be made shorter than ${MIN_FRAMES} frames.`);
    if (frame > nextStart)
      throw invalidInput(
        `This clip cannot end after frame ${nextStart}, where the next clip on its track starts.`,
      );
    const total = totalOf(clips);
    if (frame > total)
      throw invalidInput(`This clip cannot end after the end of the video (frame ${total}).`);
    checkAnchoredMedia(clip, newDur, 0);
    clip.dur = newDur;
  }
  return { added: [], verb: "Trim" };
}

/**
 * @param {EditClip} clip
 * @param {number} frame
 * @param {Set<string>} taken
 * @returns {Plan}
 */
function planSplit(clip, frame, taken) {
  if (clip.isHost && !clip.motion)
    throw invalidInput("A motion graphic cannot be split; trim it or delete it instead.");
  assertPlain(clip, SPEED);
  const end = clip.start + clip.dur;
  if (frame <= clip.start || frame >= end)
    throw invalidInput("A clip can only be split at a frame inside it.");
  if (frame - clip.start < MIN_FRAMES || end - frame < MIN_FRAMES) {
    throw invalidInput(
      `This clip cannot be split here: each part must be at least ${MIN_FRAMES} frames long.`,
    );
  }
  const first = frame - clip.start;
  /** @type {MotionSpec | null} */
  let secondSpec = null;
  if (clip.motion && clip.motionSpec) {
    // The movement is linear, so each part keeps its own piece of it exactly: they meet at the value
    // of the movement at the cut.
    const spec = clip.motionSpec;
    const mid = motionAt(spec, first / clip.dur);
    const at = { scale: Number(mid.scale.toFixed(6)), x: Number(mid.x.toFixed(6)) };
    clip.motionSpec = { scale: [spec.scale[0], at.scale], x: [spec.x[0], at.x] };
    secondSpec = { scale: [at.scale, spec.scale[1]], x: [at.x, spec.x[1]] };
  }
  const added = {
    from: clip,
    id: uniqueId(clip.id, taken),
    start: frame,
    dur: end - frame,
    mediaStart: clip.mediaStart === null ? null : clip.mediaStart + first * clip.rate,
    motionSpec: secondSpec,
  };
  clip.dur = first;
  return { added: [added], verb: "Split" };
}

/**
 * @param {EditClip[]} clips
 * @param {EditClip} clip
 * @param {number} frame
 * @returns {Plan}
 */
function planMoveAroll(clips, clip, frame) {
  const aroll = arollOf(clips);
  const total = totalOf(clips);
  const s = clip.start;
  const e = clip.start + clip.dur;
  const cuts = new Set([...aroll.map((c) => c.start), total]);
  if (!cuts.has(frame))
    throw invalidInput(
      "An A-roll clip can only be moved to a cut, the start of another A-roll clip or the end of the video.",
    );
  if (frame === s || frame === e) throw invalidInput("The clip is already at that cut.");
  const rest = aroll.filter((c) => c !== clip);
  const index = frame === total ? rest.length : rest.findIndex((c) => c.start === frame);
  const order = [...rest.slice(0, index), clip, ...rest.slice(index)];
  const move = { s, e, p: frame };
  rippleOthers(clips, order, (start) => startAfterMove(start, move));
  return { added: [], verb: "Move" };
}

/**
 * @param {EditClip[]} clips
 * @param {EditClip} clip
 * @param {number} frame
 * @returns {Plan}
 */
function planMoveOther(clips, clip, frame) {
  if (frame === clip.start) throw invalidInput("The clip is already there.");
  const { prevEnd, nextStart } = neighbours(clips, clip);
  const total = totalOf(clips);
  const end = frame + clip.dur;
  if (frame < prevEnd)
    throw invalidInput(
      `This clip cannot start before frame ${prevEnd}, where the previous clip on its track ends.`,
    );
  if (end > nextStart)
    throw invalidInput(
      `This clip cannot end after frame ${nextStart}, where the next clip on its track starts; it can start at frame ${nextStart - clip.dur} at the latest.`,
    );
  if (end > total)
    throw invalidInput(
      `This clip cannot end after the end of the video (frame ${total}); it can start at frame ${Math.max(0, total - clip.dur)} at the latest.`,
    );
  clip.start = frame;
  return { added: [], verb: "Move" };
}

/**
 * @param {EditClip} clip
 * @returns {import("./lanes.js").FadeClip}
 */
function fadeClipOf(clip) {
  return {
    src: clip.parsed.src,
    mediaStart: clip.mediaStart ?? 0,
    rate: clip.rate,
    dur: clip.dur,
    sound: clip.parsed.tag === "video" && findAttr(clip.parsed.element, "muted") === null,
  };
}

/**
 * The fades every A-roll clip has after the edit (`lanes.js`), or null when the project does not
 * manage fades.
 * @param {EditClip[]} clips
 * @param {Plan} plan
 * @param {EditFacts} facts
 * @returns {Map<EditClip | AddedClip, import("./lanes.js").FadePair> | null}
 */
function planAllFades(clips, plan, facts) {
  const fps = facts.fps;
  const aroll = clips.filter((c) => c.track === 0);
  if (!aroll.some((c) => carriesFade(c.parsed.element))) return null;
  const fadeClips = clips.filter((c) => c.kind === "fade");
  const live = fadeClips.find((c) => !c.removed);
  let endFrames = 0;
  if (live) endFrames = live.dur;
  else if (fadeClips.length === 0) {
    // No end fade picture: an end fade of the last clip's sound stays as long as it was.
    const last = [...aroll].sort((a, b) => a.start0 - b.start0 || a.order - b.order).at(-1);
    const frames = last ? fadeOutFrames(last.parsed.element, fps) : 0;
    if (frames * fps.den * 1000 > 12 * fps.num) endFrames = Math.round(frames);
  }
  /** @type {{ key: EditClip | AddedClip, start: number, order: number, fade: import("./lanes.js").FadeClip }[]} */
  const seq = [];
  for (const c of aroll) {
    if (!c.removed) seq.push({ key: c, start: c.start, order: c.order, fade: fadeClipOf(c) });
  }
  for (const a of plan.added) {
    if (a.from.track !== 0) continue;
    const fade = { ...fadeClipOf(a.from), mediaStart: a.mediaStart ?? 0, dur: a.dur };
    seq.push({ key: a, start: a.start, order: a.from.order + 0.5, fade });
  }
  seq.sort((a, b) => a.start - b.start || a.order - b.order);
  const wanted = planFades(
    seq.map((e) => e.fade),
    fps,
    endFrames,
  );
  return new Map(
    seq.map((e, i) => [e.key, /** @type {import("./lanes.js").FadePair} */ (wanted[i])]),
  );
}

/**
 * @param {string} html
 * @param {ParsedProject} parsed
 * @param {EditClip[]} clips
 * @param {Plan} plan
 * @param {EditFacts} facts
 * @returns {{ html: string, files: ProjectFile[] }}
 */
function write(html, parsed, clips, plan, facts) {
  const fps = facts.fps;
  const seconds = (/** @type {number} */ frames) => framesToSecondsText(frames, fps);
  const inPoint = (/** @type {number} */ frames) => framesToSecondsText(Math.max(0, frames), fps);
  const fades = planAllFades(clips, plan, facts);
  /** @type {import("./document.js").TextEdit[]} */
  const edits = [];
  /** @type {ProjectFile[]} */
  const files = [];
  for (const c of clips) {
    const element = c.parsed.element;
    if (c.removed) {
      edits.push(removalEdit(html, element));
      continue;
    }
    /** @type {Record<string, string>} */
    const changes = {};
    /** @type {string[]} */
    const remove = [];
    if (c.start !== c.start0) changes["data-start"] = seconds(c.start);
    if (c.dur !== c.dur0) changes["data-duration"] = seconds(c.dur);
    if (!c.motion && c.mediaStart !== null && c.mediaStart !== c.mediaStart0)
      changes["data-media-start"] = inPoint(c.mediaStart);
    const fade = fades?.get(c);
    if (fade) {
      const f = fadeChanges(element, fade);
      Object.assign(changes, f.set);
      remove.push(...f.remove);
    }
    if (Object.keys(changes).length > 0) edits.push(...attrEdits(element, changes));
    if (remove.length > 0) edits.push(...attrRemovalEdits(html, element, remove));
    const motion = c.motion;
    if (
      motion &&
      c.motionSpec &&
      c.mediaStart !== null &&
      (c.dur !== c.dur0 || c.mediaStart !== c.mediaStart0 || c.motionSpec !== motion.spec)
    ) {
      files.push({
        path: `compositions/${c.id}.html`,
        text: writeMotion(motion, {
          fps,
          mediaStart: c.mediaStart,
          inner: innerFrames(c.sourceLength ?? c.dur, c.mediaStart, c.rate, c.dur, fps),
          duration: c.dur,
          spec: c.motionSpec,
        }),
        before: motion.text,
      });
    }
  }
  for (const a of plan.added) {
    const motion = a.from.motion;
    /** @type {Record<string, string>} */
    const changes = { id: a.id, "data-start": seconds(a.start), "data-duration": seconds(a.dur) };
    /** @type {string[]} */
    const remove = [];
    if (!motion && a.mediaStart !== null) changes["data-media-start"] = inPoint(a.mediaStart);
    if (motion) {
      changes["data-composition-id"] = a.id;
      changes["data-composition-src"] = `compositions/${a.id}.html`;
    }
    const fade = fades?.get(a);
    if (fade) {
      const f = fadeChanges(a.from.parsed.element, fade);
      Object.assign(changes, f.set);
      remove.push(...f.remove);
    }
    edits.push(copyAfterEdit(html, a.from.parsed.element, changes, remove));
    if (motion && a.motionSpec && a.mediaStart !== null) {
      const copy = readMotion(copyMotionText(motion, a.id), a.id);
      if (!copy) throw new AppError("internal", "The copy of a B-roll's file could not be read.");
      files.push({
        path: `compositions/${a.id}.html`,
        text: writeMotion(copy, {
          fps,
          mediaStart: a.mediaStart,
          inner: innerFrames(a.from.sourceLength ?? a.dur, a.mediaStart, a.from.rate, a.dur, fps),
          duration: a.dur,
          spec: a.motionSpec,
        }),
        before: null,
      });
    }
  }
  const root = parsed.root;
  const total =
    totalOf(clips) +
    plan.added.filter((a) => a.from.track === 0).reduce((sum, a) => sum + a.dur, 0);
  if (root && root.duration !== total)
    edits.push(...attrEdits(root.element, { "data-duration": seconds(total) }));
  return { html: applyEdits(html, edits), files };
}

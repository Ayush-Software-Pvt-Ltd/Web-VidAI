/**
 * The timeline rules of the mock, ported from the server (`server/src/timeline/edits.js`,
 * `ripple.js`, `revisions.js`, `notes.js`): hand edits on a `Timeline`, the revision store with undo
 * and redo, and the check of a change request. Pure functions on plain data; the timeline area and
 * the seeds use them. The sentences are the server's.
 */
import type {
  ClipKind,
  NoteShape,
  NoteState,
  PreviewCopiesState,
  ProjectViolation,
  RevisionView,
  Timeline,
  TimelineClip,
  TimelineLock,
  TimelineNote,
  TimelineOp,
  TimelineTrack,
} from "../types";
import type { MockErrors } from "./ctx";
import type { MockTimeline } from "./world";

export const MIN_FRAMES = 2;
export const REVISIONS_KEPT = 200;
export const MAX_PROMPT_CHARS = 4000;
const MAX_FRAME = 1_000_000_000;

export const STALE = "The video changed since you opened it. Reload the timeline and try again.";
export const NO_PROJECT =
  "This video has no project to open yet. Edit the video first, then open its timeline.";
export const LOCKED =
  "The video is being edited right now, so the timeline cannot be changed by hand until that edit ends.";

/** What the mock keeps per video: the world's `MockTimeline` plus what the server keeps elsewhere. */
export interface TimelineSim extends MockTimeline {
  /** The user who owns the video. */
  ownerId: string;
  /** What breaks VidAI's rules (`openTimeline.violations`). */
  violations: ProjectViolation[];
  /** `true`: the project cannot be read at all (`openTimeline.timeline` is `null`). */
  unreadable: boolean;
  /** Preview copies of heavy media. */
  copies: PreviewCopiesState;
  /** The highest revision number ever used (numbers are never reused). */
  lastRevision: number;
  /** The job asked for the pending change requests, until it starts. */
  requestedJobId: string | null;
}

export const NO_COPIES: PreviewCopiesState = { total: 0, done: 0, running: false };

export const clone = <T>(value: T): T => structuredClone(value);

/** The words for a kind in revision labels (`kindNoun` of the server). */
export function kindNoun(kind: ClipKind): string {
  const nouns: Record<ClipKind, string> = {
    aroll: "A-roll",
    broll: "B-roll",
    graphic: "graphic",
    overlay: "overlay",
    hit: "hit",
    fade: "fade",
    sfx: "sound effect",
    music: "music",
  };
  return nouns[kind];
}

export const TRACK_NAMES = [
  "A-roll",
  "B-roll and graphics",
  "Overlays",
  "Keyword hits",
  "End fade",
];

export function trackName(index: number): string {
  return TRACK_NAMES[index] ?? `Sound ${index - 9}`;
}

/** Sorts track numbers as the server lists them (model.js): 4, 3, 2, 1, 0 (top layer first), then 10, 11 and up. */
export const byDisplayOrder = (a: number, b: number): number =>
  (a >= 10 ? a : -a) - (b >= 10 ? b : -b);

/** The end of the A-roll (track 0) in frames, wherever that track sits in the list. */
export const arollEnd = (tracks: TimelineTrack[]): number =>
  Math.max(0, ...(tracks.find((t) => t.index === 0)?.clips ?? []).map((x) => x.start + x.duration));

// ---- ripple (server/src/timeline/ripple.js) ----

export const startAfterRemoval = (pos: number, cut: number, length: number): number =>
  pos < cut ? pos : pos < cut + length ? cut : pos - length;

export const startAfterInsertion = (pos: number, at: number, length: number): number =>
  pos >= at ? pos + length : pos;

export function startAfterMove(pos: number, move: { s: number; e: number; p: number }): number {
  const { s, e, p } = move;
  const length = e - s;
  if (pos >= s && pos < e) return (p < s ? p : p - length) + (pos - s);
  const removed = startAfterRemoval(pos, s, length);
  return startAfterInsertion(removed, p < s ? p : p - length, length);
}

interface Work {
  clip: TimelineClip;
  start0: number;
  dur0: number;
  removed: boolean;
  order: number;
}

function settleOthers(others: Work[], total: number): void {
  for (const w of others) {
    if (w.removed || w.clip.start + w.clip.duration <= total) continue;
    w.clip.duration = total - w.clip.start;
    if (w.clip.duration < MIN_FRAMES) w.removed = true;
  }
  const byTrack = new Map<number, Work[]>();
  for (const w of others) {
    if (w.removed) continue;
    byTrack.set(w.clip.track, [...(byTrack.get(w.clip.track) ?? []), w]);
  }
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.clip.start - b.clip.start || a.order - b.order);
    const kept: Work[] = [];
    for (const w of list) {
      const previous = kept.at(-1);
      if (previous && w.clip.start < previous.clip.start + previous.clip.duration) {
        previous.clip.duration = w.clip.start - previous.clip.start;
        if (previous.clip.duration < MIN_FRAMES) {
          previous.removed = true;
          kept.pop();
        }
      }
      kept.push(w);
    }
  }
}

// ---- hand edits (server/src/timeline/edits.js) ----

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function frameOf(value: unknown, what: string, errors: MockErrors): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_FRAME) {
    throw errors.invalidInput(`The ${what} must be a whole number of frames, 0 or more.`);
  }
  return value;
}

export function validateOp(op: unknown, errors: MockErrors): TimelineOp {
  if (!isRecord(op)) throw errors.invalidInput("The edit is missing.");
  if (typeof op["clipId"] !== "string" || op["clipId"] === "") {
    throw errors.invalidInput("The edit does not say which clip it is about.");
  }
  const clipId = op["clipId"];
  switch (op["type"]) {
    case "delete":
      return { type: "delete", clipId };
    case "trim":
      if (op["edge"] !== "start" && op["edge"] !== "end") {
        throw errors.invalidInput('A trim must say which edge to move, "start" or "end".');
      }
      return {
        type: "trim",
        clipId,
        edge: op["edge"],
        frame: frameOf(op["frame"], "frame to trim to", errors),
      };
    case "split":
      return { type: "split", clipId, frame: frameOf(op["frame"], "frame to split at", errors) };
    case "move":
      return { type: "move", clipId, frame: frameOf(op["frame"], "frame to move to", errors) };
    default:
      throw errors.invalidInput("This kind of edit is not known.");
  }
}

export interface EditResult {
  tracks: TimelineTrack[];
  duration: number;
  /** The revision label: "Trim A-roll", "Move B-roll", ... */
  label: string;
}

/** The ids of every clip of a timeline. */
export const clipIds = (timeline: Pick<Timeline, "tracks">): Set<string> =>
  new Set(timeline.tracks.flatMap((t) => t.clips.map((c) => c.id)));

/** Applies one hand edit with the server's rules; throws `invalidInput` with its sentence. */
export function applyOp(timeline: Timeline, rawOp: unknown, errors: MockErrors): EditResult {
  const op = validateOp(rawOp, errors);
  const works: Work[] = timeline.tracks
    .flatMap((t) => t.clips)
    .map((c, order) => ({
      clip: clone(c),
      start0: c.start,
      dur0: c.duration,
      removed: false,
      order,
    }));
  const target = works.find((w) => w.clip.id === op.clipId);
  if (!target) throw errors.invalidInput(`There is no clip "${op.clipId}" in this video.`);
  const taken = clipIds(timeline);
  const added: Work[] = [];

  const aroll = () =>
    works
      .filter((w) => w.clip.track === 0 && !w.removed)
      .sort((a, b) => a.clip.start - b.clip.start || a.order - b.order);
  const totalOf = () => aroll().reduce((sum, w) => sum + w.clip.duration, 0);
  const layout = (order: Work[]) => {
    let at = 0;
    for (const w of order) {
      w.clip.start = at;
      at += w.clip.duration;
    }
    return at;
  };
  const rippleOthers = (order: Work[], map: (start: number) => number) => {
    const others = works.filter((w) => w.clip.track !== 0 && !w.removed);
    const oldTotal = Math.max(
      0,
      ...works.filter((w) => w.clip.track === 0).map((w) => w.start0 + w.dur0),
    );
    const anchored = others.filter((w) => w.clip.kind === "fade" && w.start0 + w.dur0 === oldTotal);
    for (const w of others) w.clip.start = map(w.clip.start);
    const total = layout(order);
    for (const w of anchored) {
      w.clip.duration = Math.min(w.dur0, total);
      w.clip.start = total - w.clip.duration;
    }
    settleOthers(others, total);
  };
  const neighbours = (w: Work) => {
    let prevEnd = 0;
    let nextStart = Infinity;
    for (const o of works) {
      if (o === w || o.clip.track !== w.clip.track || o.removed) continue;
      if (o.clip.start < w.clip.start) prevEnd = Math.max(prevEnd, o.clip.start + o.clip.duration);
      else nextStart = Math.min(nextStart, o.clip.start);
    }
    return { prevEnd, nextStart };
  };
  const checkMedia = (c: TimelineClip, newDur: number, k: number) => {
    if (c.mediaStart === null) return;
    if (k < 0 && c.mediaStart + k < 0) {
      throw errors.invalidInput(
        `This clip cannot start earlier: its source file begins only ${c.mediaStart} frames before the point where it starts now.`,
      );
    }
    if (c.sourceFrames !== null && c.mediaStart + k + newDur > c.sourceFrames) {
      const room = c.sourceFrames - (c.mediaStart + k);
      throw errors.invalidInput(
        `This clip cannot be made longer: its source file only has ${room} frames from where the clip starts, so it can last at most ${room} frames.`,
      );
    }
  };
  const c = target.clip;
  const end = c.start + c.duration;
  let verb: string;

  if (op.type === "delete") {
    verb = "Delete";
    if (c.track !== 0) target.removed = true;
    else {
      const order = aroll();
      if (order.length === 1) {
        throw errors.invalidInput(
          "This is the last A-roll clip, so it cannot be deleted: the video would be empty.",
        );
      }
      const cut = c.start;
      const length = c.duration;
      target.removed = true;
      rippleOthers(
        order.filter((w) => w !== target),
        (s) => startAfterRemoval(s, cut, length),
      );
    }
  } else if (op.type === "trim") {
    verb = "Trim";
    const { edge, frame } = op;
    if (c.track === 0) {
      const k = edge === "start" ? frame - c.start : frame - end;
      if (k === 0) throw errors.invalidInput("The clip's edge is already there.");
      const newDur = edge === "start" ? c.duration - k : c.duration + k;
      if (newDur < MIN_FRAMES) {
        throw errors.invalidInput(`This clip cannot be made shorter than ${MIN_FRAMES} frames.`);
      }
      checkMedia(c, newDur, edge === "start" ? k : 0);
      const at = c.start;
      const map =
        edge === "start"
          ? k > 0
            ? (s: number) => startAfterRemoval(s, at, k)
            : (s: number) => startAfterInsertion(s, at, -k)
          : k < 0
            ? (s: number) => startAfterRemoval(s, frame, -k)
            : (s: number) => startAfterInsertion(s, end, k);
      if (edge === "start" && c.mediaStart !== null) c.mediaStart += k;
      c.duration = newDur;
      rippleOthers(aroll(), map);
    } else {
      const { prevEnd, nextStart } = neighbours(target);
      if (edge === "start") {
        const k = frame - c.start;
        if (k === 0) throw errors.invalidInput("The clip's edge is already there.");
        const newDur = c.duration - k;
        if (newDur < MIN_FRAMES) {
          throw errors.invalidInput(`This clip cannot be made shorter than ${MIN_FRAMES} frames.`);
        }
        if (frame < prevEnd) {
          throw errors.invalidInput(
            `This clip cannot start before frame ${prevEnd}, where the previous clip on its track ends.`,
          );
        }
        checkMedia(c, newDur, k);
        if (c.mediaStart !== null) c.mediaStart += k;
        c.start = frame;
        c.duration = newDur;
      } else {
        const newDur = frame - c.start;
        if (frame === end) throw errors.invalidInput("The clip's edge is already there.");
        if (newDur < MIN_FRAMES) {
          throw errors.invalidInput(`This clip cannot be made shorter than ${MIN_FRAMES} frames.`);
        }
        if (frame > nextStart) {
          throw errors.invalidInput(
            `This clip cannot end after frame ${nextStart}, where the next clip on its track starts.`,
          );
        }
        const total = totalOf();
        if (frame > total) {
          throw errors.invalidInput(
            `This clip cannot end after the end of the video (frame ${total}).`,
          );
        }
        checkMedia(c, newDur, 0);
        c.duration = newDur;
      }
    }
  } else if (op.type === "split") {
    verb = "Split";
    const { frame } = op;
    if (c.file !== null && c.source === null) {
      throw errors.invalidInput("A motion graphic cannot be split; trim it or delete it instead.");
    }
    if (frame <= c.start || frame >= end) {
      throw errors.invalidInput("A clip can only be split at a frame inside it.");
    }
    if (frame - c.start < MIN_FRAMES || end - frame < MIN_FRAMES) {
      throw errors.invalidInput(
        `This clip cannot be split here: each part must be at least ${MIN_FRAMES} frames long.`,
      );
    }
    const first = frame - c.start;
    let n = 2;
    while (taken.has(`${c.id}-${n}`)) n += 1;
    const second: TimelineClip = {
      ...clone(c),
      id: `${c.id}-${n}`,
      start: frame,
      duration: end - frame,
      mediaStart: c.mediaStart === null ? null : c.mediaStart + first,
    };
    c.duration = first;
    added.push({
      clip: second,
      start0: frame,
      dur0: end - frame,
      removed: false,
      order: works.length,
    });
  } else {
    verb = "Move";
    const { frame } = op;
    if (c.track === 0) {
      const order = aroll();
      const total = totalOf();
      const s = c.start;
      const cuts = new Set([...order.map((w) => w.clip.start), total]);
      if (!cuts.has(frame)) {
        throw errors.invalidInput(
          "An A-roll clip can only be moved to a cut, the start of another A-roll clip or the end of the video.",
        );
      }
      if (frame === s || frame === end)
        throw errors.invalidInput("The clip is already at that cut.");
      const rest = order.filter((w) => w !== target);
      const index = frame === total ? rest.length : rest.findIndex((w) => w.clip.start === frame);
      const next = [...rest.slice(0, index), target, ...rest.slice(index)];
      const move = { s, e: end, p: frame };
      rippleOthers(next, (start) => startAfterMove(start, move));
    } else {
      if (frame === c.start) throw errors.invalidInput("The clip is already there.");
      const { prevEnd, nextStart } = neighbours(target);
      const total = totalOf();
      const newEnd = frame + c.duration;
      if (frame < prevEnd) {
        throw errors.invalidInput(
          `This clip cannot start before frame ${prevEnd}, where the previous clip on its track ends.`,
        );
      }
      if (newEnd > nextStart) {
        throw errors.invalidInput(
          `This clip cannot end after frame ${nextStart}, where the next clip on its track starts; it can start at frame ${nextStart - c.duration} at the latest.`,
        );
      }
      if (newEnd > total) {
        throw errors.invalidInput(
          `This clip cannot end after the end of the video (frame ${total}); it can start at frame ${Math.max(0, total - c.duration)} at the latest.`,
        );
      }
      c.start = frame;
    }
  }

  const all = [...works, ...added].filter((w) => !w.removed);
  const tracks: TimelineTrack[] = timeline.tracks
    .map((t) => ({
      index: t.index,
      name: t.name,
      clips: all
        .filter((w) => w.clip.track === t.index)
        .sort((a, b) => a.clip.start - b.clip.start || a.order - b.order)
        .map((w) => w.clip),
    }))
    .filter((t) => t.index < 10 || t.clips.length > 0);
  const duration = arollEnd(tracks);
  return { tracks, duration, label: `${verb} ${kindNoun(c.kind)}` };
}

// ---- revisions (server/src/timeline/revisions.js) ----

/** A hand step has a user and no job; undo never goes back across a job's revision. */
export const isHandStep = (r: RevisionView): boolean => r.userEmail !== null && r.jobId === null;

export function currentRevision(sim: Pick<MockTimeline, "revisions">): RevisionView | null {
  return sim.revisions.findLast((r) => !r.undone) ?? null;
}

function refresh(sim: Pick<MockTimeline, "revisions">): void {
  const current = currentRevision(sim);
  for (const r of sim.revisions) r.current = r === current;
}

export function canUndo(sim: Pick<MockTimeline, "revisions">): boolean {
  const current = currentRevision(sim);
  return current !== null && isHandStep(current) && sim.revisions.indexOf(current) > 0;
}

export const canRedo = (sim: Pick<MockTimeline, "revisions">): boolean =>
  sim.revisions.some((r) => r.undone);

/**
 * Saves the project as a new revision: the undone ones are dropped first (a new edit ends the redo
 * history), the number is above every number used, the newest 200 are kept.
 */
export function saveRevision(
  sim: TimelineSim,
  meta: { label: string; userEmail: string | null; jobId: string | null },
  now: number,
): RevisionView {
  for (const r of sim.revisions) if (r.undone) Reflect.deleteProperty(sim.snapshots, r.n);
  sim.revisions = sim.revisions.filter((r) => !r.undone);
  sim.lastRevision += 1;
  const revision: RevisionView = {
    n: sim.lastRevision,
    label: meta.label,
    userEmail: meta.userEmail,
    jobId: meta.jobId,
    createdAt: now,
    current: true,
    undone: false,
  };
  sim.revisions.push(revision);
  sim.timeline.revision = revision.n;
  sim.snapshots[revision.n] = clone(sim.timeline);
  while (sim.revisions.length > REVISIONS_KEPT) {
    const old = sim.revisions.shift();
    if (old) Reflect.deleteProperty(sim.snapshots, old.n);
  }
  refresh(sim);
  return revision;
}

function load(sim: TimelineSim, n: number): void {
  const snapshot = sim.snapshots[n];
  if (snapshot) sim.timeline = { ...clone(snapshot), revision: n };
}

/** Steps back over the current hand step; `false` when nothing can be undone. */
export function undoRevision(sim: TimelineSim): boolean {
  if (!canUndo(sim)) return false;
  const current = currentRevision(sim);
  const previous = current ? sim.revisions[sim.revisions.indexOf(current) - 1] : undefined;
  if (!current || !previous) return false;
  load(sim, previous.n);
  current.undone = true;
  refresh(sim);
  return true;
}

/** Brings back the lowest undone revision; `false` when there is none. */
export function redoRevision(sim: TimelineSim): boolean {
  const next = sim.revisions.find((r) => r.undone);
  if (!next) return false;
  load(sim, next.n);
  next.undone = false;
  refresh(sim);
  return true;
}

/** Puts revision `n` back as a new revision "Restored revision n" (a hand step). */
export function restoreRevision(
  sim: TimelineSim,
  n: number,
  userEmail: string | null,
  now: number,
  errors: MockErrors,
): RevisionView {
  const row = sim.revisions.find((r) => r.n === n);
  if (!row || !sim.snapshots[n]) {
    throw errors.notFound(`Revision ${n} does not exist; it may have been removed.`);
  }
  if (currentRevision(sim)?.n === n) {
    throw errors.invalidInput(`Revision ${n} is the one the video is at now.`);
  }
  load(sim, n);
  return saveRevision(sim, { label: `Restored revision ${n}`, userEmail, jobId: null }, now);
}

/** The timeline as `openTimeline` and every edit answer it: the revision and the flags are current. */
export function viewOf(sim: TimelineSim, locked: TimelineLock | null): Timeline {
  const current = currentRevision(sim);
  return {
    ...clone(sim.timeline),
    revision: current?.n ?? sim.timeline.revision,
    notes: clone(sim.notes),
    canUndo: canUndo(sim),
    canRedo: canRedo(sim),
    locked,
  };
}

// ---- change requests (server/src/timeline/notes.js) ----

export interface NoteInput {
  frame: number;
  shape: NoteShape | null;
  elementId: string | null;
  prompt: string;
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function validateNote(
  input: unknown,
  project: { duration: number; clipIds: ReadonlySet<string> },
  errors: MockErrors,
): NoteInput {
  if (!isRecord(input)) throw errors.invalidInput("The change request is missing.");
  const { frame, shape, elementId, prompt } = input;
  if (typeof frame !== "number" || !Number.isInteger(frame)) {
    throw errors.invalidInput("The frame of a change request must be a whole number.");
  }
  if (frame < 0 || frame >= project.duration) {
    throw errors.invalidInput(
      `The frame ${frame} is not inside the video, which has frames 0 to ${project.duration - 1}.`,
    );
  }
  let checked: NoteShape | null = null;
  if (shape !== null && shape !== undefined) {
    if (!isRecord(shape))
      throw errors.invalidInput("The marked area must be an ellipse or nothing.");
    const { cx, cy, rx, ry } = shape;
    if (!isNumber(cx) || !isNumber(cy) || !isNumber(rx) || !isNumber(ry)) {
      throw errors.invalidInput(
        "The marked area needs a centre (cx, cy) and radii (rx, ry) as numbers.",
      );
    }
    if (cx < 0 || cx > 1 || cy < 0 || cy > 1) {
      throw errors.invalidInput("The centre of the marked area must lie inside the frame.");
    }
    if (rx <= 0 || rx > 1 || ry <= 0 || ry > 1) {
      throw errors.invalidInput(
        "The marked area must have a size above zero and at most the whole frame.",
      );
    }
    checked = { cx, cy, rx, ry };
  }
  let element: string | null = null;
  if (elementId !== null && elementId !== undefined) {
    if (typeof elementId !== "string" || !project.clipIds.has(elementId)) {
      throw errors.invalidInput("The chosen clip is not in this video.");
    }
    element = elementId;
  }
  if (typeof prompt !== "string") throw errors.invalidInput("Write what should change.");
  const text = prompt.trim();
  const length = Array.from(text).length;
  if (length < 1) throw errors.invalidInput("Write what should change.");
  if (length > MAX_PROMPT_CHARS) {
    throw errors.invalidInput(
      `The text of a change request can have at most ${MAX_PROMPT_CHARS} characters.`,
    );
  }
  return { frame, shape: checked, elementId: element, prompt: text };
}

/** The clip a change request is about: the chosen one, else the topmost picture under its frame. */
export function targetOf(
  timeline: Pick<Timeline, "tracks">,
  note: TimelineNote,
): TimelineClip | null {
  const all = timeline.tracks.flatMap((t) => t.clips);
  if (note.elementId !== null) return all.find((c) => c.id === note.elementId) ?? null;
  const under = all
    .filter(
      (c) =>
        note.frame >= c.start &&
        note.frame < c.start + c.duration &&
        c.kind !== "sfx" &&
        c.kind !== "music" &&
        c.kind !== "fade",
    )
    .sort((a, b) => b.track - a.track);
  return under[0] ?? null;
}

/**
 * What a finished change request does to the project, visibly: a motion graphic gets a new file (only
 * that clip), a B-roll or overlay or hit a new source, an A-roll clip is tightened by a few frames.
 */
export function applyChange(sim: TimelineSim, note: TimelineNote, errors: MockErrors): void {
  const target = targetOf(sim.timeline, note);
  if (!target) return;
  const mark = (suffix: string) => {
    target.label = target.label.endsWith(suffix) ? target.label : `${target.label}${suffix}`;
  };
  if (target.file !== null && target.source === null) {
    target.file = `compositions/${target.id}-v2.html`;
    mark(" (revised)");
  } else if (target.track === 0) {
    const end = target.start + target.duration;
    if (target.duration >= 12) {
      try {
        const result = applyOp(
          sim.timeline,
          { type: "trim", clipId: target.id, edge: "end", frame: end - 6 },
          errors,
        );
        sim.timeline.tracks = result.tracks;
        sim.timeline.duration = result.duration;
        const again = targetOf(sim.timeline, { ...note, elementId: target.id });
        if (again) again.label = `${again.label} (tightened)`;
        return;
      } catch {
        // falls through to a relabel
      }
    }
    mark(" (tightened)");
  } else {
    target.source = `${(target.source ?? target.id).replace(/(-v\d+)?\.[a-z0-9]+$/i, "")}-v2.mp4`;
    mark(" (replaced)");
  }
}

/** What a request says when its job was stopped (a failed job's own sentence is used instead). */
export const NOTE_STOPPED = "The edit was stopped before it made this change.";

export const NOTE_STATES: readonly NoteState[] = ["pending", "running", "done", "failed"];

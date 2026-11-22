// What a hand edit may do, mirrored from the server (`server/src/timeline/edits.js`, `ripple.js`):
// the drag stops where the server would refuse, and each limit has the server's sentence for a
// tooltip. The server stays the judge; these checks only keep the screen from offering a drag that
// is certain to fail.

import type {
  ProjectViolation,
  Timeline,
  TimelineClip,
  TimelineLock,
  TimelineOp,
} from "@/lib/types";
import { arollClips, isMotionGraphic } from "./layout";
import type { ClipPart } from "./hit";

/** The shortest a clip can be, in frames. */
export const MIN_CLIP_FRAMES = 2;

export const LOCKED_REASON =
  "The video is being edited right now, so the timeline cannot be changed by hand until that edit ends.";
export const LAST_AROLL_REASON =
  "This is the last A-roll clip, so it cannot be deleted: the video would be empty.";
export const ONLY_AROLL_REASON =
  "This is the only A-roll clip, so there is no other cut to move it to.";
export const MOTION_SPLIT_REASON =
  "A motion graphic cannot be split; trim it or delete it instead.";
export const AROLL_CUT_REASON =
  "An A-roll clip can only be moved to a cut, the start of another A-roll clip or the end of the video.";
export const SHORTER_REASON = `This clip cannot be made shorter than ${MIN_CLIP_FRAMES} frames.`;
export const SPLIT_OUTSIDE_REASON = "A clip can only be split at a frame inside it.";
export const SPLIT_SHORT_REASON = `This clip cannot be split here: each part must be at least ${MIN_CLIP_FRAMES} frames long.`;

/** What stops hand edits as a whole: a job holding the project, or a profile violation. */
export interface EditGate {
  locked: TimelineLock | null;
  violations: readonly ProjectViolation[];
}

export interface Allowance {
  ok: boolean;
  /** A short sentence for a tooltip when `ok` is false. */
  reason: string | null;
}

const OK: Allowance = { ok: true, reason: null };
const no = (reason: string): Allowance => ({ ok: false, reason });

export function violationsReason(violations: readonly ProjectViolation[]): string {
  return `The project does not follow VidAI's rules yet, so it cannot be edited by hand: ${violations[0]?.message ?? ""}`;
}

/** `null` when hand edits are allowed at all, else the sentence. */
export function gateReason(gate: EditGate | undefined): string | null {
  if (!gate) return null;
  if (gate.locked) return LOCKED_REASON;
  if (gate.violations.length > 0) return violationsReason(gate.violations);
  return null;
}

function gated(gate: EditGate | undefined): Allowance | null {
  const reason = gateReason(gate);
  return reason === null ? null : no(reason);
}

export function canTrim(_clip: TimelineClip, gate?: EditGate): Allowance {
  return gated(gate) ?? OK;
}

export function canMove(timeline: Timeline, clip: TimelineClip, gate?: EditGate): Allowance {
  const blocked = gated(gate);
  if (blocked) return blocked;
  if (clip.track === 0 && arollClips(timeline).length < 2) return no(ONLY_AROLL_REASON);
  return OK;
}

export function canDelete(timeline: Timeline, clip: TimelineClip, gate?: EditGate): Allowance {
  const blocked = gated(gate);
  if (blocked) return blocked;
  if (clip.track === 0 && arollClips(timeline).length < 2) return no(LAST_AROLL_REASON);
  return OK;
}

/** Whether `clip` can be split at `frame` (or at all, with `frame` null). */
export function canSplit(clip: TimelineClip, frame: number | null, gate?: EditGate): Allowance {
  const blocked = gated(gate);
  if (blocked) return blocked;
  if (isMotionGraphic(clip)) return no(MOTION_SPLIT_REASON);
  if (frame === null) return OK;
  const end = clip.start + clip.duration;
  if (frame <= clip.start || frame >= end) return no(SPLIT_OUTSIDE_REASON);
  if (frame - clip.start < MIN_CLIP_FRAMES || end - frame < MIN_CLIP_FRAMES) {
    return no(SPLIT_SHORT_REASON);
  }
  return OK;
}

export function deleteOp(clip: TimelineClip): TimelineOp {
  return { type: "delete", clipId: clip.id };
}

export function splitOp(clip: TimelineClip, frame: number): TimelineOp {
  return { type: "split", clipId: clip.id, frame: Math.round(frame) };
}

/** A bound with the sentence that explains it. */
interface Bound {
  value: number;
  reason: string;
}

export interface Range {
  min: number;
  max: number;
  minReason: string | null;
  maxReason: string | null;
}

function range(lower: Bound[], upper: Bound[]): Range {
  let min = lower[0] ?? { value: 0, reason: "" };
  for (const bound of lower) if (bound.value > min.value) min = bound;
  let max = upper[0] ?? { value: Infinity, reason: "" };
  for (const bound of upper) if (bound.value < max.value) max = bound;
  return { min: min.value, max: max.value, minReason: min.reason, maxReason: max.reason };
}

/** Where the neighbours on its track stop a clip of another track than the A-roll. */
export function neighbours(
  timeline: Timeline,
  clip: TimelineClip,
): { prevEnd: number; nextStart: number } {
  let prevEnd = 0;
  let nextStart = Infinity;
  for (const other of timeline.tracks.find((t) => t.index === clip.track)?.clips ?? []) {
    if (other.id === clip.id) continue;
    if (other.start < clip.start) prevEnd = Math.max(prevEnd, other.start + other.duration);
    else nextStart = Math.min(nextStart, other.start);
  }
  return { prevEnd, nextStart };
}

const PREV_REASON = (frame: number) =>
  `This clip cannot start before frame ${frame}, where the previous clip on its track ends.`;
const NEXT_END_REASON = (frame: number) =>
  `This clip cannot end after frame ${frame}, where the next clip on its track starts.`;
const TOTAL_END_REASON = (total: number) =>
  `This clip cannot end after the end of the video (frame ${total}).`;
const EARLIER_REASON = (room: number) =>
  `This clip cannot start earlier: its source file begins only ${room} frames before the point where it starts now.`;
const LONGER_REASON = (room: number) =>
  `This clip cannot be made longer: its source file only has ${room} frames from where the clip starts, so it can last at most ${room} frames.`;

/**
 * The frames an edge of `clip` can be dragged to (the `frame` of a trim): the inclusive range the
 * server accepts, with the sentence of each end. The current position of the edge is inside it.
 */
export function trimRange(timeline: Timeline, clip: TimelineClip, edge: "start" | "end"): Range {
  const end = clip.start + clip.duration;
  const lower: Bound[] = [{ value: 0, reason: "" }];
  const upper: Bound[] = [];
  const aroll = clip.track === 0;
  const { prevEnd, nextStart } = aroll
    ? { prevEnd: 0, nextStart: Infinity }
    : neighbours(timeline, clip);
  if (edge === "start") {
    upper.push({ value: end - MIN_CLIP_FRAMES, reason: SHORTER_REASON });
    if (clip.mediaStart !== null) {
      lower.push({ value: clip.start - clip.mediaStart, reason: EARLIER_REASON(clip.mediaStart) });
    }
    if (!aroll) lower.push({ value: prevEnd, reason: PREV_REASON(prevEnd) });
  } else {
    lower.push({ value: clip.start + MIN_CLIP_FRAMES, reason: SHORTER_REASON });
    if (clip.mediaStart !== null && clip.sourceFrames !== null) {
      const room = clip.sourceFrames - clip.mediaStart;
      upper.push({ value: clip.start + room, reason: LONGER_REASON(room) });
    }
    if (!aroll) {
      if (nextStart !== Infinity) {
        upper.push({ value: nextStart, reason: NEXT_END_REASON(nextStart) });
      }
      upper.push({ value: timeline.duration, reason: TOTAL_END_REASON(timeline.duration) });
    }
  }
  return range(lower, upper);
}

/** The starts a clip of another track than the A-roll can be moved to. */
export function moveRange(timeline: Timeline, clip: TimelineClip): Range {
  const { prevEnd, nextStart } = neighbours(timeline, clip);
  const total = timeline.duration;
  const upper: Bound[] = [
    {
      value: total - clip.duration,
      reason: `This clip cannot end after the end of the video (frame ${total}); it can start at frame ${Math.max(0, total - clip.duration)} at the latest.`,
    },
  ];
  if (nextStart !== Infinity) {
    upper.push({
      value: nextStart - clip.duration,
      reason: `This clip cannot end after frame ${nextStart}, where the next clip on its track starts; it can start at frame ${nextStart - clip.duration} at the latest.`,
    });
  }
  return range([{ value: prevEnd, reason: PREV_REASON(prevEnd) }], upper);
}

/** The cuts of the A-roll: the start of every clip and the end of the video, in order. */
export function arollCuts(timeline: Timeline): number[] {
  return [...arollClips(timeline).map((c) => c.start), timeline.duration];
}

export interface DragInput {
  clip: TimelineClip;
  part: ClipPart;
  /** The frame under the pointer when the drag began. */
  fromFrame: number;
  /** The frame under the pointer now (a trim of the left edge goes to this frame). */
  toFrame: number;
}

export interface DragLimit {
  /** `min`/`max`: the range stopped the drag; `blocked`: no hand edit is possible. */
  kind: "min" | "max" | "blocked";
  reason: string;
}

export interface DragPreview {
  /** The op to send on release; `null` when nothing would change or the edit is refused. */
  op: TimelineOp | null;
  /** The edge (trim) or the start of the clip (move) after the limits, in frames. */
  frame: number;
  /** The clip's rectangle as the edit leaves it (an A-roll trim or move ripples the rest). */
  start: number;
  duration: number;
  /** The limit that stopped the drag, with its sentence; `null` when the pointer is inside. */
  limit: DragLimit | null;
  /** The drop lands where the clip is already. */
  noChange: boolean;
  /** An A-roll move: the cut the clip goes before; otherwise `null`. */
  dropCut: number | null;
}

function clamp(value: number, r: Range): { frame: number; limit: DragLimit | null } {
  if (value < r.min) return { frame: r.min, limit: { kind: "min", reason: r.minReason ?? "" } };
  if (value > r.max) return { frame: r.max, limit: { kind: "max", reason: r.maxReason ?? "" } };
  return { frame: value, limit: null };
}

function nearest(values: readonly number[], target: number): number {
  let best = values[0] ?? 0;
  for (const value of values) if (Math.abs(value - target) < Math.abs(best - target)) best = value;
  return best;
}

/**
 * The op of a drag, limited the way the server limits it.
 * - `start`/`end`: a trim to `toFrame`, held inside `trimRange`.
 * - `body`: another track's clip moves by the pointer's distance, held inside `moveRange`; an A-roll
 *   clip goes to the cut nearest to `toFrame` (`dropCut`).
 * Pass the gate to refuse the whole edit while a job holds the project or the profile is broken.
 */
export function dragToOp(timeline: Timeline, drag: DragInput, gate?: EditGate): DragPreview {
  const { clip, part } = drag;
  const end = clip.start + clip.duration;
  const base: DragPreview = {
    op: null,
    frame: clip.start,
    start: clip.start,
    duration: clip.duration,
    limit: null,
    noChange: true,
    dropCut: null,
  };
  const blocked = gateReason(gate);
  if (blocked !== null) return { ...base, limit: { kind: "blocked", reason: blocked } };
  const to = Math.round(drag.toFrame);
  if (part === "body") {
    if (clip.track === 0) {
      const allowed = canMove(timeline, clip);
      if (!allowed.ok) return { ...base, limit: { kind: "blocked", reason: allowed.reason ?? "" } };
      const cut = nearest(arollCuts(timeline), to);
      if (cut === clip.start || cut === end) return { ...base, dropCut: cut };
      const at = cut < clip.start ? cut : cut - clip.duration;
      return {
        ...base,
        op: { type: "move", clipId: clip.id, frame: cut },
        frame: at,
        start: at,
        noChange: false,
        dropCut: cut,
      };
    }
    const wanted = clip.start + (to - Math.round(drag.fromFrame));
    const { frame, limit } = clamp(wanted, moveRange(timeline, clip));
    return {
      ...base,
      op: frame === clip.start ? null : { type: "move", clipId: clip.id, frame },
      frame,
      start: frame,
      limit,
      noChange: frame === clip.start,
    };
  }
  const edge = part;
  const { frame, limit } = clamp(to, trimRange(timeline, clip, edge));
  const current = edge === "start" ? clip.start : end;
  const noChange = frame === current;
  const aroll = clip.track === 0;
  const start = edge === "start" && !aroll ? frame : clip.start;
  const duration =
    edge === "start"
      ? aroll
        ? clip.duration - (frame - clip.start)
        : end - frame
      : frame - clip.start;
  return {
    ...base,
    op: noChange ? null : { type: "trim", clipId: clip.id, edge, frame },
    frame,
    start,
    duration,
    limit,
    noChange,
  };
}

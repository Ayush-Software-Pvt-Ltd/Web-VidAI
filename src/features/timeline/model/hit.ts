// Hit tests and snapping.

import type { Timeline, TimelineClip } from "@/lib/types";
import { ROW_HEIGHT, type LaidOutClip, type Layout } from "./layout";
import { frameAtX, type View } from "./view";

export type ClipPart = "body" | "start" | "end";

/** The widest an edge zone gets, in pixels. */
export const EDGE_ZONE_PX = 8;

/**
 * The width of one edge zone for a clip `width` pixels wide: `EDGE_ZONE_PX`, but at most a third of
 * the clip, so a short clip keeps a body in the middle. Under 3 px a clip has no edge zones.
 */
export function edgeZone(width: number): number {
  return Math.min(EDGE_ZONE_PX, Math.floor(width / 3));
}

export interface Hit {
  clip: TimelineClip;
  part: ClipPart;
  laid: LaidOutClip;
}

/** The part of a laid out clip at viewport pixel `x` (which must be inside the clip). */
export function partAt(laid: LaidOutClip, x: number): ClipPart {
  const zone = edgeZone(laid.width);
  if (zone < 1) return "body";
  if (x < laid.x + zone) return "start";
  if (x >= laid.x + laid.width - zone) return "end";
  return "body";
}

/**
 * The clip and part at a point; `y` counts from the top of the rows (below the ruler). A later
 * clip wins where two overlap by a pixel. `null` for empty space.
 */
export function hitTest(layout: Layout, x: number, y: number): Hit | null {
  const row = Math.floor(y / ROW_HEIGHT);
  const track = layout.tracks[row];
  if (!track || y < 0) return null;
  let found: LaidOutClip | null = null;
  for (const laid of track.clips) {
    if (x >= laid.x && x < laid.x + laid.width) found = laid;
  }
  if (!found) return null;
  return { clip: found.clip, part: partAt(found, x), laid: found };
}

export type SnapSource = "playhead" | "start" | "end" | "clip";

export interface SnapCandidate {
  frame: number;
  source: SnapSource;
  /** The clip whose edge it is. */
  clipId: string | null;
}

export const SNAP_TOLERANCE_PX = 8;

/**
 * Where a drag can snap: the playhead, the start (0) and end of the video, and every clip edge of
 * every track, except the edges of the clip being dragged. Sorted by frame; one candidate per frame
 * (the playhead, start and end win over a clip edge).
 */
export function snapCandidates(
  timeline: Timeline,
  playhead: number,
  excludeClipId: string | null = null,
): SnapCandidate[] {
  const byFrame = new Map<number, SnapCandidate>();
  const add = (candidate: SnapCandidate, overwrite: boolean) => {
    if (overwrite || !byFrame.has(candidate.frame)) byFrame.set(candidate.frame, candidate);
  };
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) continue;
      add({ frame: clip.start, source: "clip", clipId: clip.id }, false);
      add({ frame: clip.start + clip.duration, source: "clip", clipId: clip.id }, false);
    }
  }
  add({ frame: 0, source: "start", clipId: null }, true);
  add({ frame: timeline.duration, source: "end", clipId: null }, true);
  add({ frame: playhead, source: "playhead", clipId: null }, true);
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

export interface Snapped {
  frame: number;
  /** What it snapped to, or `null` when nothing was near enough (then `frame` is `frame` rounded). */
  target: SnapCandidate | null;
}

/** The candidate nearest to `frame` within `tolerancePx` pixels, as whole frames. */
export function snapFrame(
  frame: number,
  candidates: readonly SnapCandidate[],
  pxPerFrame: number,
  tolerancePx = SNAP_TOLERANCE_PX,
): Snapped {
  let best: SnapCandidate | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.frame - frame) * pxPerFrame;
    if (distance <= tolerancePx && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best ? { frame: best.frame, target: best } : { frame: Math.round(frame), target: null };
}

/**
 * Snaps a clip that is moved: its start or its end, whichever is nearer to a candidate, so the clip
 * lands with that edge on the line. Returns the new start frame.
 */
export function snapMove(
  start: number,
  duration: number,
  candidates: readonly SnapCandidate[],
  pxPerFrame: number,
  tolerancePx = SNAP_TOLERANCE_PX,
): Snapped {
  const first = snapFrame(start, candidates, pxPerFrame, tolerancePx);
  const second = snapFrame(start + duration, candidates, pxPerFrame, tolerancePx);
  const distance = (s: Snapped, edge: number) => (s.target ? Math.abs(s.frame - edge) : Infinity);
  const a = distance(first, start);
  const b = distance(second, start + duration);
  if (a === Infinity && b === Infinity) return { frame: Math.round(start), target: null };
  if (a <= b) return first;
  return { frame: second.frame - duration, target: second.target };
}

/** The whole frame under a pointer in the rows area, as `frameAtX` rounded. */
export function pointerFrame(view: View, x: number): number {
  return Math.max(0, Math.round(frameAtX(view, x)));
}

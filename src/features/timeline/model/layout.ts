// The picture of the tracks: every clip as a rectangle in the order of the wire, and what each clip
// kind looks like. Colours are design tokens (Tailwind utilities backed by the `--c-*` variables of
// `src/styles.css`); none is added here.

import type { ClipKind, Timeline, TimelineClip, TimelineTrack } from "@/lib/types";
import type { View } from "./view";

export const ROW_HEIGHT = 40;
export const RULER_HEIGHT = 28;
/** A clip is always drawn at least this wide, so a one-frame clip at a far zoom stays visible. */
export const MIN_CLIP_PX = 2;

export type Tone = "accent" | "info" | "success" | "warning" | "danger" | "neutral";

export interface KindStyle {
  kind: ClipKind;
  /** The lane's name for a legend or tooltip. */
  label: string;
  tone: Tone;
  /** Background, text and border of a clip of this kind (full class names so Tailwind finds them). */
  className: string;
  /** The same clip when selected. */
  selectedClassName: string;
  /** Only the colour of the kind as a text colour (for a dot or a label). */
  dotClassName: string;
}

export const KIND_STYLES: Record<ClipKind, KindStyle> = {
  aroll: {
    kind: "aroll",
    label: "A-roll",
    tone: "accent",
    className: "bg-accent-soft text-accent-text border-accent/40",
    selectedClassName: "bg-accent-soft text-accent-text border-accent",
    dotClassName: "bg-accent",
  },
  broll: {
    kind: "broll",
    label: "B-roll",
    tone: "info",
    className: "bg-info-soft text-info border-info/40",
    selectedClassName: "bg-info-soft text-info border-info",
    dotClassName: "bg-info",
  },
  graphic: {
    kind: "graphic",
    label: "Motion graphic",
    tone: "warning",
    className: "bg-warning-soft text-warning border-warning/40",
    selectedClassName: "bg-warning-soft text-warning border-warning",
    dotClassName: "bg-warning",
  },
  overlay: {
    kind: "overlay",
    label: "Overlay",
    tone: "neutral",
    className: "bg-neutral-soft text-fg-muted border-border-strong",
    selectedClassName: "bg-neutral-soft text-fg border-fg-muted",
    dotClassName: "bg-fg-subtle",
  },
  hit: {
    kind: "hit",
    label: "Keyword hit",
    tone: "danger",
    className: "bg-danger-soft text-danger border-danger/40",
    selectedClassName: "bg-danger-soft text-danger border-danger",
    dotClassName: "bg-danger",
  },
  fade: {
    kind: "fade",
    label: "End fade",
    tone: "neutral",
    className: "bg-neutral-soft text-fg-subtle border-border",
    selectedClassName: "bg-neutral-soft text-fg-muted border-fg-subtle",
    dotClassName: "bg-fg-disabled",
  },
  sfx: {
    kind: "sfx",
    label: "Sound effect",
    tone: "success",
    className: "bg-success-soft text-success border-success/40",
    selectedClassName: "bg-success-soft text-success border-success",
    dotClassName: "bg-success",
  },
  music: {
    kind: "music",
    label: "Music",
    tone: "success",
    className: "bg-success-soft text-success border-success/40",
    selectedClassName: "bg-success-soft text-success border-success",
    dotClassName: "bg-success",
  },
};

export const CLIP_KINDS = Object.keys(KIND_STYLES) as ClipKind[];

export function kindStyle(kind: ClipKind): KindStyle {
  return KIND_STYLES[kind];
}

/** A sound clip (it has no picture). */
export function isSound(kind: ClipKind): boolean {
  return kind === "sfx" || kind === "music";
}

/** A motion graphic of its own file (not a B-roll with motion): it cannot be split. */
export function isMotionGraphic(clip: TimelineClip): boolean {
  return clip.file !== null && clip.source === null;
}

export interface LaidOutClip {
  clip: TimelineClip;
  /** Left edge in viewport pixels (content x minus the scroll). */
  x: number;
  width: number;
  /** Row of the track, from the top. */
  row: number;
  /** Top in pixels below the ruler. */
  y: number;
  height: number;
  style: KindStyle;
}

export interface LaidOutTrack {
  track: TimelineTrack;
  row: number;
  y: number;
  clips: LaidOutClip[];
}

export interface Layout {
  tracks: LaidOutTrack[];
  /** Height of all rows. */
  height: number;
}

/** Every track in the wire's order, one row each, with its clips as rectangles. */
export function layoutTimeline(timeline: Timeline, view: View): Layout {
  const tracks = timeline.tracks.map((track, row): LaidOutTrack => {
    const y = row * ROW_HEIGHT;
    return {
      track,
      row,
      y,
      clips: track.clips.map((clip) => ({
        clip,
        x: clip.start * view.pxPerFrame - view.scroll,
        width: Math.max(MIN_CLIP_PX, clip.duration * view.pxPerFrame),
        row,
        y,
        height: ROW_HEIGHT,
        style: kindStyle(clip.kind),
      })),
    };
  });
  return { tracks, height: tracks.length * ROW_HEIGHT };
}

/** Every clip of the timeline in the order tracks then start. */
export function allClips(timeline: Timeline): TimelineClip[] {
  return timeline.tracks.flatMap((track) => track.clips);
}

export function findClip(timeline: Timeline, clipId: string): TimelineClip | null {
  return allClips(timeline).find((clip) => clip.id === clipId) ?? null;
}

/** The clips of the A-roll track (track 0) in order of start. */
export function arollClips(timeline: Timeline): TimelineClip[] {
  return allClips(timeline)
    .filter((clip) => clip.track === 0)
    .sort((a, b) => a.start - b.start);
}

/** The clips that cover `frame` (start <= frame < start + duration), top track first. */
export function clipsAtFrame(timeline: Timeline, frame: number): TimelineClip[] {
  return allClips(timeline)
    .filter((c) => frame >= c.start && frame < c.start + c.duration)
    .sort((a, b) => b.track - a.track || a.start - b.start);
}

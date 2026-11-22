// Change requests: their order, the state each is in and what it allows (SPEC section 11, Change
// requests: only a pending request can be deleted, only a failed one can be sent again).

import type { NoteState, Timeline, TimelineClip, TimelineNote } from "@/lib/types";
import { findClip } from "./layout";
import { clampFrame, lastFrame } from "./time";
import type { Tone } from "./layout";

export interface NoteStatus {
  state: NoteState;
  label: string;
  tone: Tone;
  /** Only a request that has not started can be deleted. */
  canDelete: boolean;
  /** Only a failed request can be sent again. */
  canRetry: boolean;
  /** Jumping to the frame always works. */
  canJump: boolean;
  /** A job is working on it, or will (the project is not free for hand edits because of it). */
  active: boolean;
}

const STATUS: Record<NoteState, NoteStatus> = {
  pending: {
    state: "pending",
    label: "Waiting",
    tone: "neutral",
    canDelete: true,
    canRetry: false,
    canJump: true,
    active: true,
  },
  running: {
    state: "running",
    label: "Working on it",
    tone: "accent",
    canDelete: false,
    canRetry: false,
    canJump: true,
    active: true,
  },
  done: {
    state: "done",
    label: "Done",
    tone: "success",
    canDelete: false,
    canRetry: false,
    canJump: true,
    active: false,
  },
  failed: {
    state: "failed",
    label: "Failed",
    tone: "danger",
    canDelete: false,
    canRetry: true,
    canJump: true,
    active: false,
  },
};

export function noteStatus(note: Pick<TimelineNote, "state">): NoteStatus {
  return STATUS[note.state];
}

/** By frame, then by when it was made, then by id. */
export function sortNotes(notes: readonly TimelineNote[]): TimelineNote[] {
  return [...notes].sort(
    (a, b) => a.frame - b.frame || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
}

/** The frame a note points at, kept inside the video (a shorter video can leave it past the end). */
export function noteFrame(
  note: Pick<TimelineNote, "frame">,
  timeline: Pick<Timeline, "duration">,
): number {
  return clampFrame(note.frame, lastFrame(timeline.duration));
}

/** The clip a note is about, or `null` for the whole frame (or a clip that is gone). */
export function noteClip(
  timeline: Timeline,
  note: Pick<TimelineNote, "elementId">,
): TimelineClip | null {
  return note.elementId === null ? null : findClip(timeline, note.elementId);
}

/** The notes whose frame is `frame`, in order. */
export function notesAtFrame(notes: readonly TimelineNote[], frame: number): TimelineNote[] {
  return sortNotes(notes.filter((note) => note.frame === frame));
}

/** The next note after `frame` (or the previous, with `-1`), `null` at the last (first) one. */
export function adjacentNote(
  notes: readonly TimelineNote[],
  frame: number,
  direction: 1 | -1,
): TimelineNote | null {
  const sorted = sortNotes(notes);
  if (direction === 1) return sorted.find((note) => note.frame > frame) ?? null;
  return sorted.findLast((note) => note.frame < frame) ?? null;
}

/** How many requests wait or run. */
export function activeNoteCount(notes: readonly TimelineNote[]): number {
  return notes.filter((note) => noteStatus(note).active).length;
}

/** A short line for a note: its text cut to `max` characters. */
export function noteExcerpt(note: Pick<TimelineNote, "prompt">, max = 80): string {
  const text = note.prompt.replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 3)).join("")}...`;
}

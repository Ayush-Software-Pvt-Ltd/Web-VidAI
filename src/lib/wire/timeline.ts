// The timeline of a video as the browser sees it (docs/SPEC.md section 11). Pure declarations; every
// field is always present (`null` when empty). All times are whole frames of the project's frame rate.

import type { JobKind } from "./jobs.ts";

/** What a clip is for (profile rule 3); it fixes the track (rule 4). */
export type ClipKind = "aroll" | "broll" | "graphic" | "overlay" | "hit" | "fade" | "sfx" | "music";

/** The frame rate as a fraction: frame n starts at n * den / num seconds (30 is 30/1, 29.97 is 30000/1001). */
export interface TimelineFps {
  num: number;
  den: number;
}

export interface TimelineClip {
  /** The element's id; unique in the project. */
  id: string;
  kind: ClipKind;
  /** The text the timeline shows. */
  label: string;
  track: number;
  /** First frame on the timeline. */
  start: number;
  /** Length in frames. */
  duration: number;
  /** Media only: the source's name (the link name under assets/media/). */
  source: string | null;
  /** Media only: the frame of the source the clip starts at (rounded to a whole frame). */
  mediaStart: number | null;
  /** Video and audio only: the length of the whole source in project frames. */
  sourceFrames: number | null;
  /**
   * Motion graphics only: the project-relative file, `compositions/<id>.html`. A graphic cannot be split.
   * A B-roll with motion (push, pull, drift) is such a host too, but it carries `source`, `mediaStart` and
   * `sourceFrames` and behaves like a plain B-roll: trim, move, delete and split all work.
   */
  file: string | null;
}

export interface TimelineTrack {
  /** 0 A-roll, 1 B-roll and graphics, 2 overlays, 3 keyword hits, 4 the end fade, 10 and up sound. */
  index: number;
  /** Shown beside the track. */
  name: string;
  /** In order of start. */
  clips: TimelineClip[];
}

/** An ellipse on the frame, as fractions of its width and height (0 to 1). */
export interface NoteShape {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export type NoteState = "pending" | "running" | "done" | "failed";

/** One change request (SPEC section 11, Change requests). */
export interface TimelineNote {
  id: string;
  frame: number;
  shape: NoteShape | null;
  /** A clip id, or null for the whole frame. */
  elementId: string | null;
  prompt: string;
  state: NoteState;
  /** The job that took it, once there is one. */
  jobId: string | null;
  /** Why a failed request failed: the sentence of its job; null for every other state. */
  error: string | null;
  /** Milliseconds since 1970. */
  createdAt: number;
}

/** The job that holds the project: a locked timeline plays and takes change requests but no hand edits. */
export interface TimelineLock {
  jobId: string;
  kind: JobKind;
}

export interface Timeline {
  revision: number;
  fps: TimelineFps;
  width: number;
  height: number;
  /** The end of the A-roll in frames. */
  duration: number;
  /**
   * Tracks 0 to 4 always, then every sound track that has clips, from top to bottom on the screen as in
   * Premiere Pro: 4, 3, 2, 1, 0 (the layer drawn on top first), then 10, 11 and up. The UI keeps this order.
   */
  tracks: TimelineTrack[];
  notes: TimelineNote[];
  canUndo: boolean;
  canRedo: boolean;
  locked: TimelineLock | null;
}

/**
 * One hand edit (SPEC section 11, Hand edits). Frames are whole numbers on the timeline.
 * - `trim`: move one edge of the clip to `frame` (an A-roll clip ripples).
 * - `delete`: remove the clip.
 * - `split`: cut the clip at `frame`, which must be inside it.
 * - `move`: an A-roll clip goes to the cut at `frame` (the start of an A-roll clip, or the end of the
 *   video); any other clip starts at `frame`.
 */
export type TimelineOp =
  | { type: "trim"; clipId: string; edge: "start" | "end"; frame: number }
  | { type: "delete"; clipId: string }
  | { type: "split"; clipId: string; frame: number }
  | { type: "move"; clipId: string; frame: number };

/** One way a project breaks VidAI's rules (SPEC section 10, The profile). */
export interface ProjectViolation {
  /** The rule, 1 to 11. */
  rule: number;
  /** The clip concerned, or null. */
  elementId: string | null;
  /** A full sentence that names the element. */
  message: string;
}

/**
 * One saved state of a video's project (SPEC section 11, Revisions). `n` grows by one per saved
 * revision and is never reused for another state of the same video.
 */
export interface RevisionView {
  n: number;
  /** "Trim A-roll", "Change request", "Edit", "Re-Edit", "Restored revision 3", "Changed outside VidAI". */
  label: string;
  /** Who made it; `null` for a job or for a change made outside VidAI. */
  userEmail: string | null;
  /** The job that made it, or `null` for a hand edit. */
  jobId: string | null;
  /** Milliseconds since 1970. */
  createdAt: number;
  /** The revision the project is at now (the newest one that is not undone). */
  current: boolean;
  /** Undone and still available to redo; greyed in the list. */
  undone: boolean;
}

/**
 * The answer of `openTimeline` (SPEC section 11, Preview and Timeline data).
 * `timeline` is `null` only when the project cannot be read at all (no root element or no usable
 * `edit.json`); `violations` then says why.
 */
export interface OpenTimelineResult {
  timeline: Timeline | null;
  /** The preview address `/p/<token>/`; `null` when the server has no preview. */
  previewUrl: string | null;
  /** What breaks VidAI's rules; the screen allows no hand edit while this is not empty. */
  violations: ProjectViolation[];
  /** The smooth preview copies of this video (SPEC section 11, Preview copies). */
  previewCopies: PreviewCopiesState;
}

/** The input of `addTimelineNote` (SPEC section 11, Change requests). */
export interface AddNoteInput {
  /** A frame inside the video. */
  frame: number;
  shape: NoteShape | null;
  /** A clip id, or `null` for the whole frame. */
  elementId: string | null;
  /** 1 to 4000 characters after trimming. */
  prompt: string;
}

/** Event `timeline-changed`: the project of a video is at a new revision (reload it). */
export interface TimelineChangedPayload {
  /** `<channelId>/<folder name>`. */
  videoId: string;
  revision: number;
}

/** Event `note-updated`: a change request was added, changed state or was deleted. */
export interface NoteUpdatedPayload {
  videoId: string;
  note: TimelineNote;
  /** True when the request was deleted (`note.state` is then its last state). */
  removed: boolean;
}

/**
 * How far the preview copies of a video's heavy media are (SPEC section 11, Preview copies).
 * The screen shows "Preparing smooth preview (done + 1 of total)" while `done < total`, and plays
 * the original files meanwhile. Files whose copy failed are not counted.
 */
export interface PreviewCopiesState {
  /** Heavy files of the project that get a copy. */
  total: number;
  /** Of those, how many have their copy. */
  done: number;
  /** A copy of this video is being made right now (false while it waits behind another video's). */
  running: boolean;
}

/** Event `preview-copies-changed`: the state of a video's preview copies changed. */
export interface PreviewCopiesChangedPayload {
  /** `<channelId>/<folder name>`. */
  videoId: string;
  copies: PreviewCopiesState;
}

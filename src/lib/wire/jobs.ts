// Jobs as the browser sees them (SPEC section 8). Pure declarations; every field is always present
// (`null` when empty) and every time is milliseconds since 1970.

import type { Setup } from "../wire.ts";
import type { VideoType } from "./channels.ts";
import type { HarnessProgram } from "./harness.ts";
import type { JobProgress } from "./progress.ts";

/** `edit`, `reEdit` and `timelineEdit` are agent jobs; `render` runs HyperFrames without an agent. */
export type JobKind = "edit" | "reEdit" | "timelineEdit" | "render";

/** The three lines of section 8; a kind always waits in the same one. */
export type JobQueue = "edits" | "timeline" | "renders";

export type JobState =
  "queued" | "running" | "pausing" | "paused" | "stopping" | "stopped" | "failed" | "completed";

/** A job is active in these states; a video has at most one active job. */
export type ActiveJobState = "queued" | "running" | "pausing" | "paused" | "stopping";

export interface JobView {
  id: string;
  /** `<channelId>/<folder name>`. */
  videoId: string;
  /** The user who started it. */
  userId: string;
  kind: JobKind;
  queue: JobQueue;
  state: JobState;
  /** Edit queue only; always false in the other two queues. */
  urgent: boolean;
  /** Place in its line while `queued` (1 = next); `null` in every other state. */
  position: number | null;
  /** When it joined the line (Start Editing, Re-Edit, a change request, Render Final). */
  joinedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Time spent running; pauses and waiting excluded. */
  activeMs: number;
  /** Set while running, so the page can tick a clock. */
  runningSince: number | null;
  /** When a `queued` edit held back only by the start delay will start; `null` in every other case. */
  startsAt: number | null;
  /** One short line, for example "Running ffmpeg". */
  lastActivity: string | null;
  /** A sentence for the user, set for `failed`. */
  error: string | null;
  /** `null` until the engine reports any. */
  progress: JobProgress | null;
  videoType: VideoType;
  /** The setup the job's session runs on; `null` for `render`. */
  setup: Setup | null;
  /** The program that does the editing; `null` for `render`. */
  harness: HarnessProgram | null;
  /** `null` is the program's default, and always `null` for `render`. */
  model: string | null;
  effort: string | null;
  /** What the model calls cost so far, when the program reports it. */
  costUsd: number | null;
}

/** The totals of one line, for everybody (no names): how full it is. */
export interface QueueSummary {
  queue: JobQueue;
  /** Jobs holding a slot (running, pausing, stopping). */
  running: number;
  /** Jobs waiting in the line. */
  waiting: number;
  /** Jobs that may hold a slot at once (the admin's limit for this line). */
  slots: number;
}

/** One of the user's own jobs in `getQueue`. */
export interface QueueEntry {
  job: JobView;
  /** The user's own channel and video folder names, for the row. */
  channelName: string;
  folderName: string;
  /** Jobs waiting in front of this one (`position - 1`); `null` unless the job is `queued`. */
  ahead: number | null;
}

/** What `getQueue` returns: only the signed-in user's own waiting and running jobs. */
export interface QueueView {
  /** All three lines, in the order edits, timeline, renders. */
  queues: QueueSummary[];
  /** The user's jobs that wait or hold a slot, in all three lines: running first, then by position. */
  jobs: QueueEntry[];
}

/** One row of the admin's Queue page: every active job of every user. */
export interface AdminQueueEntry {
  jobId: string;
  queue: JobQueue;
  kind: JobKind;
  state: ActiveJobState;
  urgent: boolean;
  /** Place in its line while `queued`; `null` otherwise. */
  position: number | null;
  /** When a `queued` edit held back only by the start delay will start; `null` otherwise. */
  startsAt: number | null;
  joinedAt: number;
  userId: string;
  userEmail: string;
  channelName: string;
  folderName: string;
  /** `<channelId>/<folder name>`. */
  videoId: string;
}

/** What `adminGetQueue` returns. */
export interface AdminQueueView {
  queues: QueueSummary[];
  /** Each line in turn: jobs holding a slot, then the waiting ones by position, then paused ones. */
  jobs: AdminQueueEntry[];
}

/** Payload of the `job-updated` event: sent to the job's owner and to every admin. */
export type JobUpdatedPayload = JobView;

/** Payload of the `queue-changed` event: sent to everybody signed in when positions may have changed. */
export interface QueueChangedPayload {
  queue: JobQueue;
}

/** Input of `startEdit`. */
export interface StartEditInput {
  /** `<channelId>/<folder name>`. */
  videoId: string;
  /** Only for users who may mark an edit as urgent. */
  urgent: boolean;
}

/** Input of `reEdit`. */
export interface ReEditInput {
  videoId: string;
  /** What to change, 1 to 8000 characters. */
  text: string;
  urgent: boolean;
}

/** Input of `pauseJob`, `continueJob` and `stopJob`. */
export interface JobIdInput {
  jobId: string;
}

/** Input of `getJobLog`: the lines after `after` (a `seq`), or all of them when `null`. */
export interface GetJobLogInput {
  jobId: string;
  after: number | null;
}

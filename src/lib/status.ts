/**
 * Wording of a video's status pill and of a job's state (SPEC sections 8 and 16). Presentation
 * only: which actions a video offers (`VideoView.actions`), a job's position and whether it is held
 * back all come from the server; this module only finds the words, tone and icon for them.
 */
import { formatStartsIn } from "./format";
import type {
  ChannelVideoType,
  JobKind,
  JobState,
  JobView,
  VideoAction,
  VideoType,
  VideoView,
} from "./types";
import { ACTIVE_JOB_STATES } from "./types";

export type StatusTone = "neutral" | "info" | "accent" | "warning" | "success" | "danger";

/**
 * Which icon a status wants; the component maps the name to a drawing. `spinner` is for work that
 * is going on, `clock` for waiting, `pause` and `stop` for those states, `alert` for failure,
 * `check` for a result, and `dot` for nothing special.
 */
export type StatusIcon = "dot" | "clock" | "spinner" | "pause" | "stop" | "alert" | "check";

export interface JobStatus {
  label: string;
  tone: StatusTone;
  icon: StatusIcon;
  /** True while a program is working on it (for live indicators). */
  live: boolean;
}

export type VideoStatus = JobStatus;

/** What a running job of each kind is called ("Editing", "Re-editing", ...). */
export const RUNNING_LABEL: Record<JobKind, string> = {
  edit: "Editing",
  reEdit: "Re-editing",
  timelineEdit: "Applying changes",
  render: "Rendering",
};

/** The name of a kind of job in a sentence or a tag ("Edit", "Re-Edit", "Change requests", "Final render"). */
export const JOB_KIND_LABEL: Record<JobKind, string> = {
  edit: "Edit",
  reEdit: "Re-Edit",
  timelineEdit: "Change requests",
  render: "Final render",
};

/** The status of one job by itself (a queue row, the activity panel's job line). */
export function jobStatus(job: Pick<JobView, "state" | "kind">): JobStatus {
  switch (job.state) {
    case "queued":
      return { label: "Queued", tone: "info", icon: "clock", live: false };
    case "running":
      return { label: RUNNING_LABEL[job.kind], tone: "accent", icon: "spinner", live: true };
    case "pausing":
      return { label: "Pausing", tone: "warning", icon: "spinner", live: true };
    case "paused":
      return { label: "Paused", tone: "warning", icon: "pause", live: false };
    case "stopping":
      return { label: "Stopping", tone: "neutral", icon: "spinner", live: true };
    case "stopped":
      return { label: "Stopped", tone: "neutral", icon: "stop", live: false };
    case "failed":
      return { label: "Needs attention", tone: "danger", icon: "alert", live: false };
    case "completed":
      return { label: "Done", tone: "success", icon: "check", live: false };
  }
}

/**
 * The status pill of a video: an active or failed job decides; otherwise the output it left
 * behind ("Final rendered", "Edited"); otherwise "Stopped" after a stopped first edit, or "Not
 * edited".
 */
export function videoStatus(
  video: Pick<VideoView, "job" | "edited" | "finalRendered">,
): VideoStatus {
  const job = video.job;
  if (job && job.state !== "stopped" && job.state !== "completed") return jobStatus(job);
  if (video.finalRendered)
    return { label: "Final rendered", tone: "success", icon: "check", live: false };
  if (video.edited) return { label: "Edited", tone: "success", icon: "check", live: false };
  if (job?.state === "stopped") return jobStatus(job);
  return { label: "Not edited", tone: "neutral", icon: "dot", live: false };
}

/**
 * Position of a video in the "sort by status" order (SPEC section 16), ascending: 0 Needs
 * attention (failed job), 1 Not edited, 2 Editing (any other active job), 3 Edited, 4 Rendering
 * (a running render job), 5 Final rendered. Uses the same fields as `videoStatus`, so a job always
 * outranks the output it left behind.
 */
export function statusRank(video: Pick<VideoView, "job" | "edited" | "finalRendered">): number {
  const job = video.job;
  if (job?.state === "failed") return 0;
  if (job?.state === "running" && job.kind === "render") return 4;
  if (job && (ACTIVE_JOB_STATES as readonly JobState[]).includes(job.state)) return 2;
  if (video.finalRendered) return 5;
  return video.edited ? 3 : 1;
}

/** What the queue facts of a waiting job say, in the words a person reads under its status. */
export interface QueueNote {
  /** "Waiting, position 3" (SPEC section 8); "Waiting" while the server gave no position. */
  text: string;
  /** The reason it is not starting yet, or `null`: the start delay's countdown or the per-user limit. */
  detail: string | null;
  /** The job was marked Urgent (it is ahead of the others that wait). */
  urgent: boolean;
  /** Held back by the per-user limit of edits at the same time. */
  waitingForLimit: boolean;
}

export interface QueueNoteContext {
  now?: number;
  /** How many of the user's own edits hold a slot (`ownRunningEdits(queue)`). */
  ownRunningEdits?: number;
  /** The per-user limit from the public settings; 0 is no limit. */
  maxEditsPerUser?: number;
}

/**
 * Whether a waiting edit can only be held back by the per-user limit: the user has as many edits
 * running as the limit allows. Only edits have the limit (SPEC section 8).
 */
export function waitsForUserLimit(
  job: Pick<JobView, "queue" | "state">,
  { ownRunningEdits = 0, maxEditsPerUser = 0 }: QueueNoteContext,
): boolean {
  return (
    job.state === "queued" &&
    job.queue === "edits" &&
    maxEditsPerUser > 0 &&
    ownRunningEdits >= maxEditsPerUser
  );
}

/**
 * The queue facts of a job that waits (`queued`), or `null` for a job in any other state. The
 * start delay's countdown says "Earliest start" when the per-user limit may also hold the job.
 */
export function queueNote(
  job: Pick<JobView, "queue" | "state" | "position" | "urgent" | "startsAt">,
  context: QueueNoteContext = {},
): QueueNote | null {
  if (job.state !== "queued") return null;
  const waitingForLimit = waitsForUserLimit(job, context);
  const countdown =
    job.startsAt === null
      ? null
      : formatStartsIn(job.startsAt, context.now ?? Date.now(), waitingForLimit);
  const limit = context.maxEditsPerUser ?? 0;
  const detail =
    countdown ??
    (waitingForLimit
      ? `You can edit ${limit === 1 ? "1 video" : `${limit} videos`} at a time. This one starts when another is done.`
      : null);
  return {
    text: job.position === null ? "Waiting" : `Waiting, position ${job.position}`,
    detail,
    urgent: job.urgent,
    waitingForLimit,
  };
}

/** Colour of a progress bar: live, frozen, failed or just finished. */
export type ProgressTone = "accent" | "muted" | "danger" | "success";

/** What the progress bar of a video shows (SPEC section 16, Main window). */
export interface ProgressView {
  /** 0..100, or `null` while nothing was reported yet (the bar shows only its track). */
  percent: number | null;
  stage: string | null;
  tone: ProgressTone;
  /** When the job completed (ms since 1970); the bar is shown full for a moment after it, then hidden. */
  doneAt: number | null;
}

/**
 * The progress bar of a video, or `null` when it has none: running jobs fill in the accent colour,
 * queued ones show the track (and what an earlier run reached), pausing, paused, stopping and
 * stopped ones freeze in a muted tone, failed ones in the danger tone, and a completed job fills
 * to 100. A stopped job shows its bar only while the row still says "Stopped", and finished jobs
 * only when they reported progress.
 */
export function progressView(
  video: Pick<VideoView, "job" | "edited" | "finalRendered">,
): ProgressView | null {
  const job = video.job;
  if (!job) return null;
  const percent = job.progress === null ? null : Math.min(100, Math.max(0, job.progress.percent));
  const stage = job.progress?.stage ?? null;
  const view = (tone: ProgressTone, doneAt: number | null = null): ProgressView => ({
    percent,
    stage,
    tone,
    doneAt,
  });
  switch (job.state) {
    case "running":
      return view("accent");
    case "queued":
    case "pausing":
    case "paused":
    case "stopping":
      return view("muted");
    case "stopped":
      return percent === null || video.edited || video.finalRendered ? null : view("muted");
    case "failed":
      return percent === null ? null : view("danger");
    case "completed":
      return job.endedAt === null
        ? null
        : { percent: 100, stage, tone: "success", doneAt: job.endedAt };
  }
}

/** Button wording for every action the server can offer (SPEC section 16). */
export const ACTION_LABELS: Record<VideoAction, string> = {
  startEdit: "Start Editing",
  pause: "Pause Editing",
  continue: "Continue Editing",
  stop: "Stop Editing",
  reEdit: "Re-Edit",
  review: "Review",
  renderFinal: "Render Final",
  upload: "Upload Files",
  diskCleanup: "Disk Cleanup",
  archive: "Archive",
  unarchive: "Unarchive",
  startNow: "Start now",
};

export function videoTypeLabel(type: VideoType): string {
  return type === "long" ? "Long 16:9" : "Short 9:16";
}

/** The choices of a channel's video type setting, in display order. */
export const CHANNEL_TYPE_LABELS: Record<ChannelVideoType, string> = {
  auto: "Auto-detect",
  long: "Always Long",
  short: "Always Short",
};

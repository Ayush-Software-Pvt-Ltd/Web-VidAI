/**
 * The progress bar of a video as the list row and the activity panel show it (SPEC section 9):
 * `progressView` from `@/lib/status`, plus the moment after completion, when the full bar stays
 * for `DONE_HOLD_MS`, fades out over `DONE_FADE_MS` and is then removed, so finished rows are clean.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useAppState } from "@/lib/appEnv";
import { ownRunningEdits } from "@/lib/store";
import {
  progressView,
  queueNote,
  type ProgressView,
  type QueueNote,
  type QueueNoteContext,
} from "@/lib/status";
import type { JobState, JobView, VideoView } from "@/lib/types";

/** How long a completed bar stays full after the job ended. */
export const DONE_HOLD_MS = 2500;
/** How long it then takes to fade out. */
export const DONE_FADE_MS = 500;

export interface ShownProgress extends ProgressView {
  /** The completed bar is fading out. */
  fading: boolean;
}

type DonePhase = "hold" | "fade" | "gone";

function donePhase(doneAt: number, now: number): DonePhase {
  if (now >= doneAt + DONE_HOLD_MS + DONE_FADE_MS) return "gone";
  return now >= doneAt + DONE_HOLD_MS ? "fade" : "hold";
}

const never = () => () => {};

/** The phase of a completed bar, re-rendering only when it changes (two timers per completion). */
function useDonePhase(doneAt: number | null): DonePhase | null {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (doneAt === null) return () => {};
      const timers = [doneAt + DONE_HOLD_MS, doneAt + DONE_HOLD_MS + DONE_FADE_MS]
        .filter((at) => at > Date.now())
        .map((at) => setTimeout(notify, at - Date.now()));
      return () => {
        for (const timer of timers) clearTimeout(timer);
      };
    },
    [doneAt],
  );
  return useSyncExternalStore(doneAt === null ? never : subscribe, () =>
    doneAt === null ? null : donePhase(doneAt, Date.now()),
  );
}

/** How a frozen bar's state is announced after its percent. */
const FROZEN: Partial<Record<JobState, string>> = {
  queued: "queued",
  pausing: "pausing",
  paused: "paused",
  stopping: "stopping",
  stopped: "stopped",
  failed: "failed",
  completed: "done",
};

/**
 * The accessible name and value of a video's progress bar: "Progress of <video>, <stage>" and
 * "46%", or "46%, paused" while it is frozen.
 */
export function progressA11y(
  video: Pick<VideoView, "folderName" | "job">,
  view: Pick<ProgressView, "percent" | "stage">,
): { label: string; valueText: string | undefined } {
  const label = `Progress of ${video.folderName}${view.stage ? `, ${view.stage}` : ""}`;
  if (view.percent === null) return { label, valueText: undefined };
  const state = video.job ? FROZEN[video.job.state] : undefined;
  const percent = `${Math.floor(view.percent)}%`;
  return { label, valueText: state ? `${percent}, ${state}` : percent };
}

/** What the progress bar of `video` shows right now, or `null` for no bar at all. */
export function useShownProgress(
  video: Pick<VideoView, "job" | "edited" | "finalRendered">,
): ShownProgress | null {
  const view = progressView(video);
  const phase = useDonePhase(view?.doneAt ?? null);
  if (!view || phase === "gone") return null;
  return { ...view, fading: phase === "fade" };
}

/** What a waiting job says, line by line, under its status (SPEC sections 8 and 16). */
export interface WaitingText {
  /** "Waiting, position 3" ("Waiting" while the server gave no position). */
  headline: string;
  /** "Urgent" when the job was marked Urgent, else `null`. */
  urgent: string | null;
  /**
   * Why it is not starting yet: the start delay's countdown ("Starts in 6 min", "Earliest start in
   * 6 min" while the per-user limit may also hold it) or the per-user limit's sentence; `null`
   * when only the line holds it back.
   */
  reason: string | null;
  /** Held back by the per-user limit of edits at the same time. */
  waitingForLimit: boolean;
}

function textOf(note: QueueNote): WaitingText {
  return {
    headline: note.text,
    urgent: note.urgent ? "Urgent" : null,
    reason: note.detail,
    waitingForLimit: note.waitingForLimit,
  };
}

/**
 * The waiting text of a job, or `null` for a job that is not queued. Pure: `context` carries the
 * clock, how many edits the user has running and the per-user limit (`useWaitingText` fills them
 * from the app state). The wording is `queueNote` of `@/lib/status`.
 */
export function waitingText(
  job: Pick<JobView, "queue" | "state" | "position" | "urgent" | "startsAt">,
  context: QueueNoteContext = {},
): WaitingText | null {
  const note = queueNote(job, context);
  return note ? textOf(note) : null;
}

/** The current time, ticking every second while `active` (for a countdown). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      setNow(Date.now());
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [active]);
  return now;
}

/**
 * The waiting text of a job as it should be shown now: the position, Urgent, the start delay with
 * the time left (counting down) and the per-user limit. `null` for a job that is not waiting.
 */
export function useWaitingText(job: JobView | null): WaitingText | null {
  const maxEditsPerUser = useAppState((s) => s.workspace.data?.settings.maxEditsPerUser ?? 0);
  const running = useAppState((s) => ownRunningEdits(s.queue.data));
  const counting = job?.state === "queued" && job.startsAt !== null;
  const now = useNow(counting);
  if (!job) return null;
  return waitingText(job, { now, ownRunningEdits: running, maxEditsPerUser });
}

import { ChevronDown, ChevronUp, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, IconButton, ProgressBar } from "@/components/ui";
import { useAppState, useAppStoreApi } from "@/lib/appEnv";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import { toApiError } from "@/lib/errors";
import { findVideo } from "@/lib/store";
import { jobStatus } from "@/lib/status";
import type { JobView, Timeline, TimelineNote } from "@/lib/types";
import { useWaitingText } from "@/features/jobs";
import {
  adjacentNote,
  noteClip,
  noteExcerpt,
  noteFrame,
  noteStatus,
  sortNotes,
  timeCode,
} from "../model";
import { usePlayback, usePlaybackFrame } from "../playback";
import { clipName, failureSentence, useRequests } from "./requestsState";

/** The job a request belongs to: its own once it has one, else the one that will take it. */
function useNoteJob(videoId: string, note: TimelineNote): JobView | null {
  return useAppState((s) => {
    const latest = findVideo(s.library.data, videoId)?.job ?? null;
    if (note.jobId !== null) {
      const queued = s.queue.data?.jobs.find((entry) => entry.job.id === note.jobId)?.job;
      if (queued) return queued;
      return latest?.id === note.jobId ? latest : null;
    }
    // A waiting request without a job yet: the change request job that waits for its turn.
    return latest?.kind === "timelineEdit" && latest.state === "queued" ? latest : null;
  });
}

/** The revision a job made, when the revision list is loaded. */
function useRevisionOf(videoId: string, note: TimelineNote): number | null {
  return useAppState((s) => {
    if (note.state !== "done" || note.jobId === null) return null;
    const list = s.timelines[videoId]?.revisions.data ?? null;
    return list?.find((revision) => revision.jobId === note.jobId)?.n ?? null;
  });
}

/** One line under a request that says where it stands. */
function NoteProgress({ note, job }: { note: TimelineNote; job: JobView | null }) {
  const waiting = useWaitingText(note.state === "pending" ? job : null);
  if (note.state === "pending") {
    return (
      <div className="flex flex-col gap-0.5 text-sm text-fg-muted">
        <span>
          {waiting ? waiting.headline : "Waiting for the other work on this video to finish."}
        </span>
        {waiting?.reason && <span>{waiting.reason}</span>}
      </div>
    );
  }
  if (note.state === "running") {
    const percent = job?.progress?.percent ?? null;
    const label =
      !job || job.state === "running"
        ? (job?.progress?.stage ?? "Working on it")
        : jobStatus(job).label;
    const left = job?.progress?.secondsLeft ?? null;
    return (
      <div className="flex flex-col gap-1">
        <ProgressBar
          value={percent}
          label={`Progress of the change request, ${label}`}
          valueText={percent === null ? undefined : `${Math.floor(percent)}%`}
        />
        <span className="text-sm text-fg-muted">
          {label}
          {percent === null ? "" : `, ${Math.floor(percent)}%`}
          {left === null ? "" : `, about ${formatDuration(left * 1000)} left`}
        </span>
      </div>
    );
  }
  return null;
}

function NoteRow({
  videoId,
  timeline,
  note,
}: {
  videoId: string;
  timeline: Timeline;
  note: TimelineNote;
}) {
  const store = useAppStoreApi();
  const playback = usePlayback();
  const selected = useRequests((s) => s.selectedId === note.id);
  const select = useRequests((s) => s.select);
  const job = useNoteJob(videoId, note);
  const revision = useRevisionOf(videoId, note);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"delete" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = noteStatus(note);
  const clip = noteClip(timeline, note);
  const frame = noteFrame(note, timeline);
  const long = Array.from(note.prompt.trim()).length > Array.from(noteExcerpt(note)).length;

  const jump = () => {
    select(note.id);
    playback.seek(frame);
  };
  const run = async (kind: "delete" | "retry") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "delete") await store.getState().deleteTimelineNote(videoId, note.id);
      else await store.getState().retryTimelineNote(videoId, note.id);
    } catch (failure) {
      setError(toApiError(failure).message);
    }
    setBusy(null);
  };

  const where = clip
    ? clipName(clip)
    : note.elementId !== null
      ? "A clip that is not in the video any more"
      : "The whole picture";

  return (
    <li
      data-note={note.id}
      aria-current={selected || undefined}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border p-2.5",
        selected ? "border-accent bg-accent-soft/50" : "border-separator",
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={jump}
          aria-label={`Go to ${timeCode(frame, timeline.fps)}`}
          className="focus-ring rounded-sm text-sm font-medium text-fg tabular hover:underline"
        >
          {timeCode(frame, timeline.fps)}
        </button>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="min-w-0 flex-1 truncate text-right text-xs text-fg-subtle" dir="auto">
          {where}
        </span>
      </div>
      <button
        type="button"
        onClick={jump}
        className="focus-ring rounded-sm text-left text-base text-fg select-text"
        dir="auto"
      >
        <span className={cn(open ? "whitespace-pre-wrap" : "line-clamp-2")}>
          {open ? note.prompt.trim() : noteExcerpt(note, 120)}
        </span>
      </button>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
          className="focus-ring self-start rounded-sm text-sm text-accent-text hover:underline"
        >
          {open ? "Show less" : "Show all"}
        </button>
      )}
      <NoteProgress note={note} job={job} />
      {note.state === "failed" && (
        <p className="text-sm text-danger">{failureSentence(note, job)}</p>
      )}
      {note.state === "done" && (
        <p className="text-sm text-success">
          {revision === null ? "Applied" : `Applied in revision ${revision}`}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {(status.canDelete || status.canRetry) && (
        <div className="flex items-center gap-1.5">
          {status.canRetry && (
            <Button
              size="sm"
              icon={<RotateCcw />}
              loading={busy === "retry"}
              disabled={busy !== null}
              onClick={() => {
                void run("retry");
              }}
            >
              Try Again
            </Button>
          )}
          {status.canDelete && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 />}
              loading={busy === "delete"}
              disabled={busy !== null}
              onClick={() => {
                void run("delete");
              }}
            >
              Delete
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** Previous and next request around the playhead. */
function NoteNav({ timeline }: { timeline: Timeline }) {
  const playback = usePlayback();
  const frame = usePlaybackFrame();
  const select = useRequests((s) => s.select);
  const previous = adjacentNote(timeline.notes, frame, -1);
  const next = adjacentNote(timeline.notes, frame, 1);
  const go = (note: TimelineNote | null) => {
    if (!note) return;
    select(note.id);
    playback.seek(noteFrame(note, timeline));
  };
  return (
    <div className="flex items-center gap-0.5">
      <IconButton
        label="Previous request"
        size="sm"
        icon={<ChevronUp />}
        disabled={previous === null}
        onClick={() => {
          go(previous);
        }}
      />
      <IconButton
        label="Next request"
        size="sm"
        icon={<ChevronDown />}
        disabled={next === null}
        onClick={() => {
          go(next);
        }}
      />
    </div>
  );
}

/** Loads the revision list once, so a finished request can say which revision it made. */
function useRevisionsForDone(videoId: string, timeline: Timeline): void {
  const store = useAppStoreApi();
  const status = useAppState((s) => s.timelines[videoId]?.revisions.status ?? "idle");
  const hasDone = timeline.notes.some((n) => n.state === "done" && n.jobId !== null);
  useEffect(() => {
    if (hasDone && status === "idle") void store.getState().loadRevisions(videoId);
  }, [hasDone, status, store, videoId]);
}

/**
 * The change requests of the video, by frame, each with its state (SPEC section 11): a click
 * jumps to its frame and selects it, a waiting one can be deleted, a failed one sent again.
 */
export function NoteList({ videoId, timeline }: { videoId: string; timeline: Timeline }) {
  useRevisionsForDone(videoId, timeline);
  const notes = sortNotes(timeline.notes);
  return (
    <section aria-label="Change requests" className="flex flex-col gap-2">
      <div className="flex h-6 items-center justify-between">
        <h3 className="text-sm font-semibold text-fg-muted">
          Change requests{notes.length > 0 ? ` (${notes.length})` : ""}
        </h3>
        {notes.length > 0 && <NoteNav timeline={timeline} />}
      </div>
      {notes.length === 0 ? (
        <p className="rounded-lg border border-dashed border-separator px-3 py-4 text-sm text-fg-muted">
          Pause on a frame and circle what should look different, then say how. VidAI changes only
          that part and the timeline updates.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.map((note) => (
            <NoteRow key={note.id} videoId={videoId} timeline={timeline} note={note} />
          ))}
        </ul>
      )}
    </section>
  );
}

import { Clapperboard, Download, FileVideo, Play } from "lucide-react";
import { useId, useState } from "react";
import { Badge, Button, Dialog, ProgressBar } from "@/components/ui";
import { useApi, useAppState } from "@/lib/appEnv";
import { formatBytes, formatDuration, formatTimeAgo } from "@/lib/format";
import { findVideo } from "@/lib/store";
import { ACTIVE_JOB_STATES, type JobView, type OutputFile, type VideoView } from "@/lib/types";
import {
  RenderFinalSheet,
  actionLabel,
  usePendingJobAction,
  useRunJobAction,
  useWaitingText,
} from "@/features/jobs";
import { activeNoteCount } from "../model";

/** The sentence under the button: Render Final is never started by anything else. */
export const ONLY_ON_REQUEST = "The final video is only made when you ask for it here.";

const isActive = (job: JobView | null): job is JobView =>
  job !== null && (ACTIVE_JOB_STATES as readonly string[]).includes(job.state);

/** The progress, time left and Stop of a final render that waits or runs. */
function RenderProgress({ video, job }: { video: VideoView; job: JobView }) {
  const run = useRunJobAction();
  const pending = usePendingJobAction(video.id);
  const waiting = useWaitingText(job);
  const percent = job.progress?.percent ?? null;
  const left = job.progress?.secondsLeft ?? null;
  const text = waiting
    ? waiting.headline
    : job.state === "running"
      ? `${job.progress?.stage ?? "Rendering"}${percent === null ? "" : `, ${Math.floor(percent)}%`}${
          left === null ? "" : `, about ${formatDuration(left * 1000)} left`
        }`
      : job.state === "stopping"
        ? "Stopping"
        : job.state === "pausing" || job.state === "paused"
          ? "Paused"
          : "Rendering";
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-separator bg-subtle p-2.5">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-fg" aria-live="polite">
          {text}
        </p>
        <Button
          size="sm"
          loading={pending === "stop"}
          disabled={job.state === "stopping"}
          onClick={() => {
            run(video, "stop");
          }}
        >
          {actionLabel(video, "stop")}
        </Button>
      </div>
      {waiting?.reason && <p className="text-sm text-fg-muted">{waiting.reason}</p>}
      {job.state !== "queued" && (
        <ProgressBar
          value={percent}
          tone={job.state === "running" ? "accent" : "muted"}
          label="Progress of the final render"
          valueText={percent === null ? undefined : `${Math.floor(percent)}%`}
        />
      )}
    </div>
  );
}

/** A finished video with Play (in a dialog) and Download. */
function FinalRow({
  video,
  file,
  latest,
}: {
  video: VideoView;
  file: OutputFile;
  latest: boolean;
}) {
  const api = useApi();
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = api.fileUrl(video.id, file.path);
  return (
    <li className="flex items-center gap-2 rounded-lg border border-separator p-2">
      <span className="flex shrink-0 text-fg-subtle [&_svg]:size-4">
        <FileVideo aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="truncate text-sm font-medium text-fg select-text"
            dir="auto"
            title={file.path}
          >
            {file.name}
          </span>
          {latest && <Badge tone="accent">Latest</Badge>}
        </div>
        <p className="truncate text-xs text-fg-muted">
          {formatBytes(file.size)}, rendered {formatTimeAgo(file.modifiedAt)}
        </p>
      </div>
      <Button
        size="sm"
        icon={<Play />}
        aria-label={`Play ${file.name}`}
        onClick={() => {
          setFailed(false);
          setPlaying(true);
        }}
      >
        Play
      </Button>
      <a
        href={api.fileUrl(video.id, file.path, { download: true })}
        download
        aria-label={`Download ${file.name}`}
        className="focus-ring inline-flex h-6 items-center gap-1 rounded-md bg-control px-2 text-sm font-medium text-fg shadow-control hover:bg-control-hover [&_svg]:size-3.5"
      >
        <Download aria-hidden />
        Download
      </a>
      <Dialog open={playing} onOpenChange={setPlaying} title={file.name} size="lg">
        {failed ? (
          <div className="flex aspect-video items-center justify-center rounded-md bg-muted px-4 text-center text-sm text-fg-muted">
            This video cannot be played in the page. Download it to watch it.
          </div>
        ) : (
          <video
            controls
            autoPlay
            src={url}
            aria-label={`Player of ${file.name}`}
            onError={() => {
              setFailed(true);
            }}
            className="max-h-[60vh] w-full rounded-md bg-black"
          />
        )}
      </Dialog>
    </li>
  );
}

/**
 * Render Final of the timeline screen (SPEC sections 11 and 12): the button that opens the
 * resolution sheet, why it is not available now, the progress of a render, and the finished
 * videos. The server stays the judge; its refusal is shown by the sheet.
 */
export function RenderFinalSection({ videoId }: { videoId: string }) {
  const video = useAppState((s) => findVideo(s.library.data, videoId));
  const notes = useAppState((s) => s.timelines[videoId]?.timeline.data?.notes ?? null);
  const violations = useAppState((s) => s.timelines[videoId]?.violations ?? []);
  const [open, setOpen] = useState(false);
  const noteId = useId();

  const job = video?.job ?? null;
  const renderJob = isActive(job) && job.kind === "render" ? job : null;
  const otherJob = isActive(job) && job.kind !== "render" ? job : null;
  const waitingNotes = notes === null ? 0 : activeNoteCount(notes);
  const failedRender = job?.kind === "render" && job.state === "failed" ? job : null;

  const reason =
    video === null
      ? "This video is not in your library."
      : renderJob
        ? "A final render of this video is already queued or running."
        : waitingNotes > 0
          ? `Render Final waits until ${waitingNotes === 1 ? "the change request is" : `all ${waitingNotes} change requests are`} applied.`
          : otherJob
            ? "Render Final waits until the work on this video has finished."
            : violations.length > 0
              ? `The project has errors, so it cannot be rendered. ${violations[0]?.message ?? ""}`.trim()
              : null;

  const finals = [...(video?.output.finals ?? [])].sort((a, b) => b.modifiedAt - a.modifiedAt);

  return (
    <section aria-label="Render Final" className="flex flex-col gap-2">
      <Button
        variant="secondary"
        icon={<Clapperboard />}
        disabled={reason !== null}
        aria-describedby={noteId}
        onClick={() => {
          setOpen(true);
        }}
      >
        Render Final
      </Button>
      <div id={noteId} className="flex flex-col gap-1 text-sm text-fg-muted">
        {reason !== null && <p>{reason}</p>}
        <p>{ONLY_ON_REQUEST}</p>
      </div>
      {renderJob && video && <RenderProgress video={video} job={renderJob} />}
      {failedRender?.error && !renderJob && (
        <p role="alert" className="text-sm text-danger">
          {failedRender.error}
        </p>
      )}
      {video && finals.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-sm font-semibold text-fg-muted">Finished videos</h3>
          <ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
            {finals.map((file, index) => (
              <FinalRow key={file.path} video={video} file={file} latest={index === 0} />
            ))}
          </ul>
        </div>
      )}
      <RenderFinalSheet videoId={videoId} open={open} onOpenChange={setOpen} />
    </section>
  );
}

import { Coins, Info, Timer, TriangleAlert, X } from "lucide-react";
import { Badge, IconButton, ProgressBar, StatusPill, Tooltip } from "@/components/ui";
import { useAppState } from "@/lib/appEnv";
import { cn } from "@/lib/cn";
import { activeMsNow, formatCost, formatDuration } from "@/lib/format";
import { videoStatus, videoTypeLabel } from "@/lib/status";
import type { HarnessPublicView, JobKind, JobQueue, JobView, VideoView } from "@/lib/types";
import {
  Callout,
  JobActionButtons,
  jobKindTag,
  jobProgram,
  jobService,
  modelAndEffort,
  progressA11y,
  useShownProgress,
  useWaitingText,
  videoTypeSource,
  type ShownProgress,
  type WaitingText,
} from "@/features/jobs";
import { failureAdvice, stoppedAdvice } from "./logFormat";
import { formatTimeLeft } from "./timeLeft";
import { useNow } from "./useNow";

/** The line a job waits in or runs in (SPEC section 8). */
const QUEUE_LABEL: Record<JobQueue, string> = {
  edits: "Edits",
  timeline: "Change requests",
  renders: "Final renders",
};

const STOPPED_TITLE: Record<JobKind, string> = {
  edit: "Editing was stopped.",
  reEdit: "The re-edit was stopped.",
  timelineEdit: "Applying the changes was stopped.",
  render: "The render was stopped.",
};

/**
 * The model of a job as people read it: the job carries the model id; the public harness view
 * knows its name while the admin has not changed the model since.
 */
function modelNameOf(job: JobView, harness: HarnessPublicView | null): string | null {
  if (job.model === null) return null;
  return harness?.model === job.model ? (harness.modelName ?? job.model) : job.model;
}

/**
 * The stage (or, for a waiting job, its position in the line), the percent and a bar across the
 * header, with the time left and what holds a waiting job back (the start delay's countdown or the
 * per-user limit). A completed bar stays for a moment and then folds away (the space it took closes
 * smoothly, so nothing below jumps).
 */
function ProgressBlock({
  video,
  job,
  progress,
  waiting,
}: {
  video: VideoView;
  job: JobView;
  progress: ShownProgress;
  waiting: WaitingText | null;
}) {
  const secondsLeft = job.progress?.secondsLeft ?? null;
  const left = job.state === "running" && secondsLeft !== null ? formatTimeLeft(secondsLeft) : null;
  const label = waiting
    ? waiting.headline
    : (progress.stage ?? (progress.percent === null ? "Getting started" : null));
  return (
    <div
      data-progress-block
      className={cn(
        "grid transition-[grid-template-rows,opacity,margin] duration-500 motion-reduce:transition-none",
        progress.fading ? "-mt-3 grid-rows-[0fr] opacity-0" : "grid-rows-[1fr]",
      )}
    >
      <div className="flex min-h-0 flex-col gap-1.5 overflow-hidden">
        <div className="flex items-baseline gap-3 text-sm">
          <span className="min-w-0 flex-1 truncate">
            <span className="text-fg">{label}</span>
            {left && <span className="text-fg-muted"> · {left}</span>}
          </span>
          {progress.percent !== null && (
            <span className="shrink-0 font-medium text-fg tabular">
              {Math.floor(progress.percent)}%
            </span>
          )}
        </div>
        <ProgressBar
          value={progress.percent}
          tone={progress.tone}
          {...progressA11y(video, progress)}
          className="h-1.5"
        />
        {waiting?.reason && (
          <p
            className="text-sm text-fg-muted"
            role={job.startsAt !== null ? "timer" : undefined}
            data-waiting-reason
          >
            {waiting.reason}
          </p>
        )}
      </div>
    </div>
  );
}

function ElapsedClock({ job }: { job: JobView }) {
  const now = useNow(job.runningSince !== null);
  return (
    <Tooltip content="Active time. Pauses and time in the queue are not counted.">
      <span
        tabIndex={0}
        className="focus-ring ml-auto flex shrink-0 items-center gap-1 rounded-sm text-sm text-fg-muted tabular [&_svg]:size-3.5"
      >
        <Timer aria-hidden />
        <span aria-label="Active time">{formatDuration(activeMsNow(job, now))}</span>
      </span>
    </Tooltip>
  );
}

/** What the model calls cost so far, quietly beside the clock. */
function CostLabel({ costUsd }: { costUsd: number | null }) {
  const text = formatCost(costUsd);
  if (text === "") return null;
  return (
    <Tooltip content="What the model calls of this job have cost so far.">
      <span
        tabIndex={0}
        className="focus-ring flex shrink-0 items-center gap-1 rounded-sm text-sm text-fg-muted tabular [&_svg]:size-3.5"
      >
        <Coins aria-hidden />
        <span aria-label="Cost">{text}</span>
      </span>
    </Tooltip>
  );
}

/** The facts of a job as a quiet list: its line, the program, the service and the model. */
function JobFacts({ job, harness }: { job: JobView; harness: HarnessPublicView | null }) {
  const service = jobService(job);
  const active = job.state !== "stopped" && job.state !== "failed" && job.state !== "completed";
  const rows: [string, string][] = [];
  if (active) rows.push(["Queue", QUEUE_LABEL[job.queue]]);
  if (job.harness !== null) rows.push(["Program", jobProgram(job)]);
  if (service !== null) rows.push(["Service", service]);
  if (job.setup !== null) {
    rows.push(["Model", modelAndEffort(modelNameOf(job, harness), job.effort)]);
  }
  if (rows.length === 0) return null;
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 text-sm">
      {rows.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-fg-subtle">{name}</dt>
          <dd className="truncate text-fg-muted" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The top of the activity panel: name, status, clock and cost, progress (or the waiting position
 * and the start delay countdown), program and model, the job buttons, and what a failed or
 * stopped job needs next.
 */
export function PanelHeader({
  video,
  channelName,
  onClose,
}: {
  video: VideoView;
  channelName: string;
  onClose: () => void;
}) {
  const harness = useAppState((s) => s.harness.data);
  const job = video.job;
  const status = videoStatus(video);
  const kindTag = jobKindTag(video);
  const progress = useShownProgress(video);
  const waiting = useWaitingText(job);
  const stopNote = job?.state === "stopped" ? stoppedAdvice(job, video.actions) : null;

  return (
    <header className="flex shrink-0 flex-col gap-3 border-b border-separator px-3 pt-3 pb-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2
            dir="auto"
            title={video.folderName}
            className="line-clamp-2 text-md font-semibold break-words text-fg select-text"
          >
            {video.folderName}
          </h2>
          {/* Wraps between whole phrases, so the type and where it comes from stay readable. */}
          <p className="mt-0.5 line-clamp-2 text-sm break-words text-fg-muted" dir="auto">
            {channelName}
            <span aria-hidden> · </span>
            <span className="whitespace-nowrap">{videoTypeLabel(video.videoType)}</span>{" "}
            <span className="whitespace-nowrap text-fg-subtle">({videoTypeSource(video)})</span>
          </p>
        </div>
        <IconButton
          label="Close activity"
          icon={<X />}
          size="sm"
          className="-mt-0.5 -mr-1"
          onClick={onClose}
        />
      </div>

      <div className="flex min-w-0 items-center gap-1.5">
        <StatusPill tone={status.tone} label={status.label} live={status.live} />
        {kindTag && <Badge variant="outline">{kindTag}</Badge>}
        {waiting?.urgent && <Badge tone="warning">{waiting.urgent}</Badge>}
        {/* A job that never ran has no active time and no cost to show yet. */}
        {job && (job.startedAt !== null || job.activeMs > 0) && <ElapsedClock job={job} />}
        {job && <CostLabel costUsd={job.costUsd} />}
      </div>

      {job && progress && (
        <ProgressBlock video={video} job={job} progress={progress} waiting={waiting} />
      )}

      {job && <JobFacts job={job} harness={harness} />}

      <JobActionButtons video={video} emphasis className="flex-wrap" />

      {job?.state === "failed" && (
        <Callout
          tone="danger"
          icon={<TriangleAlert />}
          title={job.error ?? (job.kind === "render" ? "The render failed." : "The edit failed.")}
        >
          {failureAdvice(job, video.actions)}
        </Callout>
      )}
      {job?.state === "stopped" && (
        <Callout tone="info" icon={<Info />} title={STOPPED_TITLE[job.kind]}>
          {stopNote}
        </Callout>
      )}
    </header>
  );
}

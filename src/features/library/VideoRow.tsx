/**
 * One row of the video list (SPEC section 16): the video folder name with the type badge, the
 * status pill with the job's stage and percent, the last activity and a ticking clock while a job
 * runs, what a waiting job waits for ("Waiting, position 3", Urgent, the start delay countdown,
 * the per-user limit), the action buttons from `video.actions` (`JobActionButtons`, which also
 * shows the command in flight), the row menu, and a 2 px progress bar along the bottom edge that
 * takes the place of the row separator while it is shown. A video whose files are still arriving
 * says "Uploading" and has no Start Editing (the server leaves it out of `actions`).
 */
import { Ellipsis, ListTree } from "lucide-react";
import { memo, type CSSProperties } from "react";
import {
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  ProgressBar,
  StatusPill,
  TruncatedText,
} from "@/components/ui";
import {
  ACTION_SPECS,
  actionLabel,
  JobActionButtons,
  menuActionsOf,
  progressA11y,
  useRunJobAction,
  useShownProgress,
  waitingText,
} from "@/features/jobs";
import { useAppState } from "@/lib/appEnv";
import { cn } from "@/lib/cn";
import { activeMsNow, formatDuration } from "@/lib/format";
import { ownRunningEdits } from "@/lib/store";
import type { VideoView } from "@/lib/types";
import { rowDetail, rowStatus, type RowDetail } from "./presentation";
import { RowUploadSlot } from "./RowUploadSlot";
import { useNow } from "./useNow";
import { VideoTypeMenu } from "./VideoTypeMenu";

export const ROW_HEIGHT = 56;

/** Active edit time, ticking every second while the job runs. */
function JobClock({ job }: { job: NonNullable<VideoView["job"]> }) {
  const running = job.runningSince !== null;
  const now = useNow(1000, running);
  const ms = running ? activeMsNow(job, now) : job.activeMs;
  if (!running && ms === 0) return null;
  return (
    <span
      className="ml-auto shrink-0 text-sm text-fg-subtle tabular"
      aria-label={`Active for ${formatDuration(ms)}`}
      role="timer"
    >
      {formatDuration(ms)}
    </span>
  );
}

/**
 * What a waiting job says: "Waiting, position 3", the Urgent badge, and why it is not starting yet
 * (the start delay's countdown, ticking on the shared clock so only this text re-renders, or the
 * per-user limit's sentence). Like the last activity line it takes the room that is left and is
 * the first to be cut off.
 */
function WaitingLine({
  job,
  separated,
}: {
  job: NonNullable<VideoView["job"]>;
  separated: boolean;
}) {
  const maxEditsPerUser = useAppState((s) => s.workspace.data?.settings.maxEditsPerUser ?? 0);
  const running = useAppState((s) => ownRunningEdits(s.queue.data));
  const now = useNow(1000, job.startsAt !== null);
  const text = waitingText(job, { now, ownRunningEdits: running, maxEditsPerUser });
  if (text === null) return null;
  return (
    <span className="flex min-w-0 flex-1 basis-0 items-center gap-2 overflow-hidden text-sm text-fg-muted">
      {separated && (
        <span aria-hidden className="shrink-0 text-fg-subtle">
          ·
        </span>
      )}
      <span className="shrink-0">{text.headline}</span>
      {text.urgent !== null && (
        <Badge tone="warning" className="shrink-0">
          {text.urgent}
        </Badge>
      )}
      {text.reason !== null && (
        <span
          role={job.startsAt !== null ? "timer" : undefined}
          className={cn("flex min-w-0", job.startsAt !== null && "tabular")}
        >
          <TruncatedText text={text.reason} side="bottom" />
        </span>
      )}
    </span>
  );
}

/** "Building graphics - 46%": the stage gives way first, the percent always stays readable. */
function ProgressSummary({ stage, percent }: { stage: string | null; percent: number }) {
  return (
    <span data-progress-summary className="flex min-w-0 text-sm text-fg-muted">
      {stage !== null && (
        <>
          <TruncatedText text={stage} side="bottom" />
          <span aria-hidden className="shrink-0 whitespace-pre">
            {" - "}
          </span>
        </>
      )}
      <span className="shrink-0 tabular">{Math.floor(percent)}%</span>
    </span>
  );
}

function RowMenu({ video, tabbable }: { video: VideoView; tabbable: boolean }) {
  const selectVideo = useAppState((s) => s.selectVideo);
  const run = useRunJobAction();
  // The rare actions the server offers (Upload, Disk Cleanup, Unarchive) in its order.
  const extra = menuActionsOf(video);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton
          label={`More for ${video.folderName}`}
          noTooltip
          icon={<Ellipsis />}
          size="sm"
          tabIndex={tabbable ? 0 : -1}
          className="data-[state=open]:bg-pressed data-[state=open]:text-fg"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[220px]">
        {extra.map((action) => {
          const Icon = ACTION_SPECS[action].icon;
          return (
            <DropdownMenuItem
              key={action}
              icon={<Icon />}
              onSelect={() => {
                run(video, action);
              }}
            >
              {actionLabel(video, action)}
            </DropdownMenuItem>
          );
        })}
        {extra.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuItem
          icon={<ListTree />}
          onSelect={() => {
            selectVideo(video.id);
          }}
        >
          View activity
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface VideoRowProps {
  video: VideoView;
  /** Shown before the folder name ("Channel / Video") when the list mixes channels. */
  channelName?: string;
  /** Position in the whole list (for keyboard navigation and aria-posinset). */
  index: number;
  setSize: number;
  selected: boolean;
  /** The row that holds the list's single tab stop. */
  active: boolean;
  /** Narrow list: icon-only action buttons. */
  compact: boolean;
  style: CSSProperties;
  onSelect: (videoId: string, index: number) => void;
  onFocusRow: (videoId: string) => void;
}

function VideoRowImpl({
  video,
  channelName,
  index,
  setSize,
  selected,
  active,
  compact,
  style,
  onSelect,
  onFocusRow,
}: VideoRowProps) {
  const status = rowStatus(video);
  const detail = rowDetail(video, status);
  const detailId = `row-detail-${index}`;
  const job = video.job;
  const showClock =
    job !== null &&
    (job.state === "running" ||
      job.state === "pausing" ||
      job.state === "paused" ||
      job.state === "stopping");
  const progress = useShownProgress(video);
  // The error of a failed job matters more than how far it got; the bar still shows that.
  const summary =
    progress !== null &&
    progress.percent !== null &&
    progress.doneAt === null &&
    job?.state !== "failed"
      ? { stage: progress.stage, percent: progress.percent }
      : null;
  // The detail line never says again what the progress summary just said.
  const detailText =
    summary?.stage != null &&
    detail.text?.trim().toLowerCase() === summary.stage.trim().toLowerCase()
      ? null
      : detail.text;
  const waiting = job?.state === "queued" ? job : null;
  // While its bar is shown, the bar's track is the row's bottom line.
  const barShown = progress !== null && !progress.fading;

  return (
    <div
      role="listitem"
      aria-setsize={setSize}
      aria-posinset={index + 1}
      data-row-index={index}
      data-video-id={video.id}
      data-selected={selected || undefined}
      style={style}
      onClick={(event) => {
        // Only a click on the row itself selects it. Its controls do not, and neither do clicks
        // in their menus: React bubbles those out of the portal into this handler although they
        // happen outside the row's DOM.
        const target = event.target as Node;
        if (!event.currentTarget.contains(target)) return;
        if (target instanceof Element && target.closest("[data-row-controls]")) return;
        onSelect(video.id, index);
      }}
      onFocus={() => {
        onFocusRow(video.id);
      }}
      className={cn(
        "group/row absolute inset-x-0 flex items-center gap-3 border-b border-separator pr-3 pl-4",
        "transition-[border-color] duration-500",
        // The focus ring is drawn above the progress bar.
        "after:pointer-events-none after:absolute after:inset-0 after:z-[1]",
        "has-[[data-row-main]:focus-visible]:after:shadow-[inset_0_0_0_2px_var(--c-focus)]",
        selected ? "bg-selected" : "hover:bg-hover",
        barShown && "border-b-transparent",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {/* The channel is capped at 40% of this line, which is as wide as the column however short the
            names are: a percentage of a name block sized by its own content would cut the channel
            of a row with a short video name. The video name is the part that gives way. */}
        <div className="flex min-w-0 items-center text-base">
          {/* The channel stays outside the button, so the button's name is the folder name. */}
          {channelName !== undefined && (
            <>
              <TruncatedText
                text={channelName}
                side="bottom"
                className="max-w-[40%] shrink-0 text-fg-muted"
              />
              <span className="shrink-0 whitespace-pre text-fg-subtle"> / </span>
            </>
          )}
          <button
            type="button"
            data-row-main
            tabIndex={active ? 0 : -1}
            aria-current={selected ? "true" : undefined}
            aria-describedby={detailId}
            className="flex min-w-0 shrink text-left font-medium text-fg outline-none"
          >
            <TruncatedText text={video.folderName} side="bottom" />
          </button>
          <span data-row-controls className="ml-2 flex shrink-0">
            <VideoTypeMenu video={video} tabbable={active} />
          </span>
        </div>
        <div id={detailId} className="flex min-w-0 items-center gap-2">
          <StatusPill tone={status.tone} label={status.label} live={status.live} />
          {summary && <ProgressSummary stage={summary.stage} percent={summary.percent} />}
          {waiting !== null ? (
            <WaitingLine job={waiting} separated={summary !== null} />
          ) : (
            detailText && (
              <DetailText text={detailText} tone={detail.tone} separated={summary !== null} />
            )
          )}
          {showClock && <JobClock job={job} />}
          <RowUploadSlot video={video} />
        </div>
      </div>
      <div data-row-controls className="flex shrink-0 items-center gap-1.5">
        <JobActionButtons video={video} compact={compact} tabbable={active} />
        <RowMenu video={video} tabbable={active} />
      </div>
      {progress && (
        <ProgressBar
          value={progress.percent}
          tone={progress.tone}
          {...progressA11y(video, progress)}
          className={cn(
            "pointer-events-none absolute inset-x-0 -bottom-px h-[2px] rounded-none bg-border",
            "transition-opacity duration-500",
            progress.fading && "opacity-0",
          )}
        />
      )}
    </div>
  );
}

const detailTones = { muted: "text-fg-muted", danger: "text-danger", warning: "text-warning" };

/**
 * The detail line after the pill. It only takes the room that is left, so it is the first to be
 * cut off; `separated` starts it with a dot after the progress summary; `timer` marks a countdown.
 */
function DetailText({
  text,
  tone,
  separated = false,
  timer = false,
}: RowDetail & { text: string; separated?: boolean; timer?: boolean }) {
  return (
    <span
      role={timer ? "timer" : undefined}
      className={cn(
        "flex min-w-0 flex-1 basis-0 overflow-hidden text-sm",
        timer && "tabular",
        detailTones[tone],
      )}
    >
      {separated && (
        <span aria-hidden className="shrink-0 pr-2 text-fg-subtle">
          ·
        </span>
      )}
      <TruncatedText text={text} side="bottom" />
    </span>
  );
}

export const VideoRow = memo(VideoRowImpl);

/** A placeholder row while the library loads. */
export function SkeletonRow({ nameWidth, style }: { nameWidth: number; style?: CSSProperties }) {
  return (
    <div
      aria-hidden
      style={style}
      className="flex items-center gap-3 border-b border-separator pr-3 pl-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <span
            className="h-3 animate-pulse rounded-full bg-muted"
            style={{ width: `min(${nameWidth}%, ${nameWidth * 7}px)` }}
          />
          <span className="h-3 w-14 animate-pulse rounded-sm bg-muted" />
        </div>
        <span className="h-3 w-20 animate-pulse rounded-full bg-muted" />
      </div>
      <span className="h-6 w-24 animate-pulse rounded-md bg-muted" />
    </div>
  );
}

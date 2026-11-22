/**
 * The activity panel for the selected video (SPEC section 16): status, waiting position, progress,
 * active time, cost, program and model, the job buttons, the live log with auto-scroll, and the
 * outputs. Rendered by the main window; it shows nothing while no video is selected, and closing
 * it clears the selection.
 */
import { CircleAlert, Clock, Sparkles } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  Button,
  CopyButton,
  EmptyState,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui";
import { useAppState, useAppStoreApi } from "@/lib/appEnv";
import { hasOpenLayer, isEditableTarget, isPlainKey } from "@/lib/keyboard";
import type { JobLogState } from "@/lib/store";
import { ACTIVE_JOB_STATES, type JobState, type LogEntry, type VideoView } from "@/lib/types";
import { agentName, findVideo, jobProgram } from "@/features/jobs";
import { JobLog } from "./JobLog";
import { logToText } from "./logFormat";
import { Outputs } from "./Outputs";
import { PanelHeader } from "./PanelHeader";
import { PanelResizer } from "./PanelResizer";
import { useActivityTab, type ActivityTab } from "./tabStore";
import { clampWidth, defaultWidth, loadStoredWidth, storeWidth, widthRange } from "./panelWidth";

const NO_ENTRIES: readonly LogEntry[] = [];

function isActive(state: JobState): boolean {
  return (ACTIVE_JOB_STATES as readonly JobState[]).includes(state);
}

/** Before the user ever chose: outputs first for a finished, edited video, the log otherwise. */
function initialTab(video: VideoView): ActivityTab {
  const job = video.job;
  if (job && (isActive(job.state) || job.state === "failed")) return "log";
  return video.edited ? "outputs" : "log";
}

function LogArea({
  video,
  log,
  entries,
}: {
  video: VideoView;
  log: JobLogState | undefined;
  entries: readonly LogEntry[];
}) {
  const store = useAppStoreApi();
  const program = useAppState((s) => s.harness.data?.program ?? null);
  const job = video.job;

  if (!job) {
    return (
      <EmptyState
        className="h-full"
        icon={<Sparkles />}
        title="Not edited yet"
        description={`Start Editing, then follow here what ${agentName(program)} does, live.`}
      />
    );
  }
  const worker = job.kind === "render" ? "the render" : jobProgram(job);
  if (entries.length > 0) return <JobLog key={job.id} entries={entries} />;
  if (log?.status === "loading" || log === undefined || log.jobId !== job.id) {
    return (
      <div className="flex h-full items-center justify-center text-fg-subtle">
        <Spinner size={16} label="Loading the log" />
      </div>
    );
  }
  if (log.status === "error") {
    return (
      <EmptyState
        className="h-full"
        tone="error"
        icon={<CircleAlert />}
        title="Could not load the log"
        description={log.error?.message}
        action={
          <Button
            onClick={() => {
              void store.getState().loadJobLog(video.id, job.id);
            }}
          >
            Try Again
          </Button>
        }
      />
    );
  }
  if (job.state === "queued") {
    const held = job.startsAt !== null;
    return (
      <EmptyState
        className="h-full"
        icon={<Clock />}
        title={held ? "Waiting for the start delay" : "Waiting for a free slot"}
        description={
          held
            ? `Edits start a few minutes apart, so they do not all use the server at once. The log starts as soon as ${worker} starts working on this video.`
            : `The log starts as soon as ${worker} starts working on this video.`
        }
      />
    );
  }
  return (
    <EmptyState
      className="h-full"
      icon={<Clock />}
      title="No activity yet"
      description={
        job.kind === "render"
          ? "What the render does shows up here."
          : `What ${agentName(job.harness)} does shows up here.`
      }
    />
  );
}

function PanelBody({ video, onClose }: { video: VideoView; onClose: () => void }) {
  const store = useAppStoreApi();
  const log = useAppState((s) => s.jobLogs[video.id]);
  const channelName = useAppState(
    (s) => s.workspace.data?.channels.find((c) => c.id === video.channelId)?.name ?? "",
  );
  const chosen = useActivityTab((s) => s.chosen);
  const choose = useActivityTab((s) => s.choose);
  // Fixed when the video opens, so a job finishing under the user's eyes does not switch tabs.
  const [initial] = useState(() => initialTab(video));
  const tab = chosen ?? initial;
  const jobId = video.job?.id ?? null;
  // Entries of an older job are not shown while the new job's log loads.
  const entries = jobId !== null && log?.jobId === jobId ? log.entries : NO_ENTRIES;

  // Load the log when the panel opens and whenever a new job starts; `job-log` events keep it fresh.
  useEffect(() => {
    if (jobId !== null) void store.getState().loadJobLog(video.id, jobId);
  }, [store, video.id, jobId]);
  // The store keeps a log only while the panel shows it.
  useEffect(() => {
    const videoId = video.id;
    return () => {
      store.getState().forgetJobLog(videoId);
    };
  }, [store, video.id]);

  return (
    <>
      <PanelHeader video={video} channelName={channelName} onClose={onClose} />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          choose(value as ActivityTab);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex shrink-0 items-end gap-2 border-b border-separator px-3">
          <TabsList className="flex-1 border-b-0" aria-label="Activity">
            <TabsTrigger value="log">Log</TabsTrigger>
            <TabsTrigger value="outputs">Outputs</TabsTrigger>
          </TabsList>
          {tab === "log" && entries.length > 0 && (
            <CopyButton
              text={() => logToText(entries)}
              label="Copy the whole log"
              className="mb-1 -mr-1"
            />
          )}
        </div>
        <TabsContent value="log" className="min-h-0 flex-1">
          <LogArea video={video} log={log} entries={entries} />
        </TabsContent>
        <TabsContent value="outputs" className="min-h-0 flex-1">
          <Outputs video={video} />
        </TabsContent>
      </Tabs>
    </>
  );
}

export interface ActivityPanelProps {
  /** The width the panel always leaves to the content at its left (the video list). */
  minContentWidth?: number;
  /**
   * Puts focus back after the panel closed while it had focus (Esc, Close), for example on the
   * video's row in the list. Gets the id of the video the panel showed.
   */
  onReturnFocus?: (videoId: string) => void;
}

/**
 * The panel at the right of the main window. Esc closes it from anywhere in the window unless a
 * dialog, sheet, menu or popover is open or a text field has focus (they use Esc themselves);
 * this is the only Esc handling of the panel and the list.
 */
export function ActivityPanel({ minContentWidth = 0, onReturnFocus }: ActivityPanelProps) {
  const selectedVideoId = useAppState((s) => s.selectedVideoId);
  if (!selectedVideoId) return null;
  return (
    <Panel
      videoId={selectedVideoId}
      minContentWidth={minContentWidth}
      onReturnFocus={onReturnFocus}
    />
  );
}

function Panel({
  videoId,
  minContentWidth,
  onReturnFocus,
}: {
  videoId: string;
  minContentWidth: number;
  onReturnFocus: ((videoId: string) => void) | undefined;
}) {
  const store = useAppStoreApi();
  const video = useAppState((s) => findVideo(s.library.data, videoId));
  const libraryLoaded = useAppState((s) => s.library.data !== null);
  const panelId = useId();
  const asideRef = useRef<HTMLElement>(null);

  // ---- Width: what the user chose, within what the window allows ------------------------------
  const [chosen, setChosen] = useState<number | null>(loadStoredWidth);
  const [available, setAvailable] = useState(0);
  useLayoutEffect(() => {
    const container = asideRef.current?.parentElement;
    if (!container) return;
    const measure = () => {
      setAvailable(container.clientWidth);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    measure();
    return () => {
      observer.disconnect();
    };
  }, []);
  const range = widthRange(available, minContentWidth);
  const width =
    chosen === null ? defaultWidth(available, minContentWidth) : clampWidth(chosen, range);

  // ---- Closing ---------------------------------------------------------------------------------
  const close = () => {
    const active = document.activeElement;
    const hadFocus =
      active === null || active === document.body || asideRef.current?.contains(active) === true;
    store.getState().selectVideo(null);
    if (hadFocus) onReturnFocus?.(videoId);
  };
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    // Capture phase: runs before an open menu or dialog handles (and removes itself on) Esc.
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlainKey(event, "Escape") || event.defaultPrevented) return;
      if (hasOpenLayer() || isEditableTarget(event.target)) return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, []);

  return (
    <aside
      ref={asideRef}
      id={panelId}
      aria-label="Activity"
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-separator bg-surface"
    >
      <PanelResizer
        width={width}
        min={range.min}
        max={range.max}
        controls={panelId}
        onResize={(next, done) => {
          setChosen(next);
          if (done) storeWidth(next);
        }}
        onReset={() => {
          setChosen(null);
          storeWidth(null);
        }}
      />
      {video ? (
        <PanelBody key={video.id} video={video} onClose={close} />
      ) : libraryLoaded ? (
        <EmptyState
          className="h-full"
          icon={<CircleAlert />}
          title="This video is gone"
          description="It was archived, renamed or removed."
          action={<Button onClick={close}>Close</Button>}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-fg-subtle">
          <Spinner size={16} label="Loading" />
        </div>
      )}
    </aside>
  );
}

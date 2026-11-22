/**
 * The Timeline screen (SPEC section 11): the player on top, the tracks below, the change requests
 * and Render Final in a column at the side. It opens `openTimeline` for its video, plays and scrubs
 * through the player bridge, and sends hand edits, undo, redo and restore through the store.
 */
import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Callout } from "@/features/jobs/Callout";
import { Spinner } from "@/components/ui";
import { useApi, useAppState, useAppStoreApi, usePlatform } from "@/lib/appEnv";
import { cn } from "@/lib/cn";
import { folderNameOf, channelIdOf } from "@/lib/videoId";
import { findChannel, findJob, findVideo, selectPreviewCopies } from "@/lib/store";
import { JOB_KIND_LABEL } from "@/lib/status";
import type { JobKind, ProjectViolation, Timeline } from "@/lib/types";
import { findClip, gateReason, xAtFrame, type Allowance, type EditGate } from "./model";
import { KeyRegistryContext, createKeyRegistry } from "./keys";
import { useLock } from "./useLock";
import { createPlaybackStore, PlaybackContext } from "./playback";
import { RequestsPanel } from "./requests";
import { Header } from "./screen/Header";
import { KeyboardHelp } from "./screen/KeyboardHelp";
import { PlayerFrame } from "./screen/PlayerFrame";
import type { PlayerBridge } from "./screen/playerBridge";
import { Revisions } from "./screen/Revisions";
import { LoadingState, NoProjectState, UnavailableState, UnreadableState } from "./screen/States";
import { Tracks } from "./screen/Tracks";
import { Transport } from "./screen/Transport";
import { useEdits } from "./screen/useEdits";
import { useMeasure } from "./screen/useMeasure";
import { RATES, deleteSelected, splitSelected, useShortcuts } from "./screen/useShortcuts";
import { useView } from "./screen/useView";

const WHAT: Record<JobKind, string> = {
  edit: "An edit",
  reEdit: "A Re-Edit",
  timelineEdit: "A change request",
  render: "A final render",
};

/** The column beside the player (change requests, Render Final): 360 px, the middle of the 340 to 380 the panel is made for. */
export const PANEL_WIDTH = 360;
/**
 * Below this width of the screen the column no longer fits beside the player (the player would be
 * under 680 px wide, 380 px high for a 16:9 picture) and goes under the tracks; see `Loaded`.
 */
export const SIDE_COLUMN_MIN_WIDTH = 1040;

const OK: Allowance = { ok: true, reason: null };
const no = (reason: string): Allowance => ({ ok: false, reason });
const ENDED = ["completed", "failed", "stopped"];

export function TimelineView({ videoId }: { videoId: string }) {
  return <Screen key={videoId} videoId={videoId} />;
}

function Screen({ videoId }: { videoId: string }) {
  const entry = useAppState((s) => s.timelines[videoId]);
  const library = useAppState((s) => s.library.data);
  const open = useAppState((s) => s.openTimelineOf);
  const forget = useAppState((s) => s.forgetTimeline);
  const setView = useAppState((s) => s.setView);
  useEffect(() => {
    void open(videoId);
    return () => forget(videoId);
  }, [videoId, open, forget]);
  const back = useCallback(() => setView("main"), [setView]);

  const timeline = entry?.timeline.data ?? null;
  if (timeline) {
    return (
      <Loaded
        videoId={videoId}
        timeline={timeline}
        previewUrl={entry?.previewUrl ?? null}
        violations={entry?.violations ?? []}
      />
    );
  }
  const status = entry?.timeline.status;
  if (!entry || status === "idle" || status === "loading") return <LoadingState />;
  if (status === "error") {
    const error = entry.timeline.error;
    const video = findVideo(library, videoId);
    if (error?.code === "notFound" && video && !video.edited)
      return <NoProjectState onBack={back} />;
    return (
      <UnavailableState
        message={error?.message ?? "The timeline could not be opened."}
        onBack={back}
        onRetry={error?.code === "notFound" ? undefined : () => void open(videoId)}
      />
    );
  }
  return <UnreadableState violations={entry.violations} onBack={back} />;
}

function ViolationsCallout({ violations }: { violations: readonly ProjectViolation[] }) {
  const shown = violations.slice(0, 3);
  return (
    <Callout
      tone="warning"
      icon={<TriangleAlert />}
      title="This project does not follow VidAI's rules yet, so hand edits are off."
      className="mx-3 mt-2"
    >
      <p>Ask for a change request or run Re-Edit, and VidAI will fix it. You can still play it.</p>
      <ul className="mt-1 list-disc pl-4">
        {shown.map((violation, index) => (
          <li key={index}>{violation.message}</li>
        ))}
        {violations.length > shown.length && <li>And {violations.length - shown.length} more.</li>}
      </ul>
    </Callout>
  );
}

interface LoadedProps {
  videoId: string;
  timeline: Timeline;
  previewUrl: string | null;
  violations: ProjectViolation[];
}

function Loaded({ videoId, timeline, previewUrl, violations }: LoadedProps) {
  const api = useApi();
  const store = useAppStoreApi();
  const { platform } = usePlatform();
  const setView = useAppState((s) => s.setView);
  const library = useAppState((s) => s.library.data);
  const workspace = useAppState((s) => s.workspace.data);
  const copies = useAppState(selectPreviewCopies(videoId));
  const edits = useEdits(videoId);

  const [holder] = useState<{ current: PlayerBridge | null }>(() => ({ current: null }));
  const [playback] = useState(() =>
    createPlaybackStore({
      seek: (frame) => holder.current?.seek(frame),
      play: () => holder.current?.play(),
      pause: () => holder.current?.pause(),
    }),
  );
  const [viewportRef, viewport] = useMeasure();
  const [bodyRef, body] = useMeasure();
  // Not measured yet (0) counts as wide, so the first paint is the usual layout.
  const stacked = body.width > 0 && body.width < SIDE_COLUMN_MIN_WIDTH;
  const [keys] = useState(createKeyRegistry);
  const control = useView(timeline.duration, viewport.width);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const selected = selectedId ? findClip(timeline, selectedId) : null;

  const lock = useLock(videoId, timeline);
  const lockId = lock?.jobId ?? null;
  const lockKind = lock?.kind ?? null;
  const gate: EditGate = useMemo(
    () => ({
      locked: lockId !== null && lockKind !== null ? { jobId: lockId, kind: lockKind } : null,
      violations,
    }),
    [lockId, lockKind, violations],
  );
  const why = gateReason(gate);
  const undo = why ? no(why) : timeline.canUndo ? OK : no("There is nothing to undo.");
  const redo = why ? no(why) : timeline.canRedo ? OK : no("There is nothing to redo.");

  // A lock that outlives its job (no revision came with its end) is dropped by loading it again.
  const job = findJob(library, videoId);
  const lockJob = lock && job?.id === lock.jobId ? job : null;
  const lockEnded = timeline.locked !== null && (lockJob === null || ENDED.includes(lockJob.state));
  useEffect(() => {
    if (!lockEnded) return;
    let stale = false;
    api.getTimeline({ videoId }).then(
      (fresh) => !stale && store.getState().applyTimeline(videoId, fresh),
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [lockEnded, lockJob?.state, api, store, videoId]);

  const renewPreview = useCallback(async () => {
    await store.getState().openTimelineOf(videoId);
    return store.getState().timelines[videoId]?.previewUrl ?? null;
  }, [store, videoId]);

  const zoomAtPlayhead = useCallback(
    (steps: number) => {
      const x = xAtFrame(control.view, playback.getState().frame);
      const inside = x >= 0 && x <= viewport.width;
      control.zoom(steps, inside ? x : viewport.width / 2);
    },
    [control, playback, viewport.width],
  );
  const stepRate = useCallback((direction: -1 | 1) => {
    setRate((current) => {
      const at = RATES.indexOf(current);
      return RATES[Math.min(RATES.length - 1, Math.max(0, at + direction))] ?? 1;
    });
  }, []);

  const shortcuts = {
    platform,
    keys,
    playback,
    bridgeRef: holder,
    timeline,
    gate,
    selected,
    edits,
    undo,
    redo,
    zoomAtPlayhead,
    fit: control.fit,
    stepRate,
  };
  useShortcuts(shortcuts);

  const channelName = findChannel(workspace, channelIdOf(videoId))?.name ?? null;
  const preparing = copies.running && copies.total > 0;

  return (
    <PlaybackContext value={playback}>
      <KeyRegistryContext value={keys}>
        <div className="flex h-full min-h-0 flex-col bg-window">
          <Header
            channelName={channelName}
            videoName={folderNameOf(videoId)}
            revision={timeline.revision}
            saving={edits.busy}
            undo={undo}
            redo={redo}
            onBack={() => setView("main")}
            onUndo={() => void edits.undo()}
            onRedo={() => void edits.redo()}
            onRevisions={() => setRevisionsOpen(true)}
            onHelp={() => setHelpOpen(true)}
          />
          {lock && (
            <p
              role="status"
              data-testid="lock-line"
              className="flex shrink-0 items-center gap-2 border-b border-border bg-subtle px-3 py-1.5 text-sm text-fg-muted"
            >
              <Spinner size={12} />
              {WHAT[lock.kind]} is working on this video
              {lockJob?.progress ? ` (${Math.round(lockJob.progress.percent)}%)` : ""}.{" "}
              {JOB_KIND_LABEL[lock.kind]} is shown here when it ends; hand edits are off until then.
            </p>
          )}
          {!lock && violations.length > 0 && <ViolationsCallout violations={violations} />}
          {/* Side by side, or - in a narrow window - one scrolling column with the player pinned on top. */}
          <div
            ref={bodyRef}
            data-measure="body"
            data-layout={stacked ? "stacked" : "side"}
            className={cn("min-h-0 flex-1", stacked ? "flex flex-col overflow-y-auto" : "flex")}
          >
            <div className={stacked ? "contents" : "flex min-w-0 flex-1 flex-col"}>
              <div
                className={cn(
                  "relative flex flex-col",
                  stacked ? "sticky top-0 z-10 h-[42vh] min-h-[220px] shrink-0" : "min-h-0 flex-1",
                )}
              >
                <PlayerFrame
                  videoId={videoId}
                  width={timeline.width}
                  height={timeline.height}
                  fps={timeline.fps}
                  duration={timeline.duration}
                  revision={timeline.revision}
                  previewUrl={previewUrl}
                  playback={playback}
                  bridgeRef={holder}
                  renewPreview={renewPreview}
                  volume={volume}
                  muted={muted}
                  rate={rate}
                />
                {preparing && (
                  <p
                    role="status"
                    className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-xs text-white"
                  >
                    <Spinner size={12} />
                    Preparing smooth preview ({Math.min(copies.done + 1, copies.total)} of{" "}
                    {copies.total})
                  </p>
                )}
              </div>
              <Transport
                timeline={timeline}
                gate={gate}
                selected={selected}
                volume={volume}
                muted={muted}
                onVolume={setVolume}
                onMuted={setMuted}
                onSplit={() => splitSelected({ ...shortcuts })}
                onDelete={() => deleteSelected({ ...shortcuts })}
                onZoom={zoomAtPlayhead}
                onFit={control.fit}
              />
              <section
                aria-label="Timeline"
                className={cn(
                  "flex shrink-0 flex-col border-t border-border bg-window",
                  stacked ? "h-[260px]" : "max-h-[45%] min-h-[96px]",
                )}
              >
                <Tracks
                  timeline={timeline}
                  control={control}
                  viewportRef={viewportRef}
                  width={viewport.width}
                  gate={gate}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onEdit={(op) => void edits.edit(op)}
                />
              </section>
            </div>
            <div
              className={cn(
                "flex shrink-0 flex-col border-border",
                stacked ? "border-t" : "overflow-y-auto border-l",
              )}
              style={stacked ? undefined : { width: PANEL_WIDTH }}
            >
              <RequestsPanel videoId={videoId} />
            </div>
          </div>
          <Revisions
            open={revisionsOpen}
            onOpenChange={setRevisionsOpen}
            videoId={videoId}
            restoreAllowance={why ? no(why) : OK}
            onRestore={edits.restore}
          />
          <KeyboardHelp open={helpOpen} onOpenChange={setHelpOpen} />
        </div>
      </KeyRegistryContext>
    </PlaybackContext>
  );
}

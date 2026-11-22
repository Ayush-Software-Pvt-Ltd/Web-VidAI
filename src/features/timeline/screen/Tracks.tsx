/**
 * The ruler and the tracks: every clip as a rectangle, the playhead, the change request markers and
 * the hand edits (select, trim and move by dragging, with snapping). Only clips near the viewport are
 * rendered. What the server would refuse is not offered: a not-allowed cursor and the reason.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "@/lib/cn";
import type { Timeline, TimelineClip, TimelineOp } from "@/lib/types";
import {
  RULER_HEIGHT,
  ROW_HEIGHT,
  canMove,
  canTrim,
  clipLengthText,
  dragToOp,
  frameAtX,
  gateReason,
  kindStyle,
  edgeZone,
  layoutTimeline,
  lastFrame,
  noteFrame,
  noteStatus,
  rulerTicks,
  snapCandidates,
  snapFrame,
  snapMove,
  timeCode,
  wholeFrameAtX,
  xAtFrame,
  type ClipPart,
  type DragPreview,
  type EditGate,
  type LaidOutClip,
  type SnapCandidate,
  type Tone,
  isMotionGraphic,
} from "../model";
import { PRIORITY, useKeyClaim } from "../keys";
import { usePlayback, usePlaybackFrame } from "../playback";
import type { ViewControl } from "./useView";

export const LABEL_WIDTH = 96;
/** Clips this far outside the viewport are still rendered, so a fast scroll never shows a gap. */
const OVERSCAN_PX = 120;
const DRAG_START_PX = 3;
const SCRUB_INTERVAL_MS = 40;

const TONE_DOT: Record<Tone, string> = {
  accent: "bg-accent",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-fg-subtle",
};

interface Drag {
  clip: TimelineClip;
  part: ClipPart;
  row: number;
  startClientX: number;
  fromRaw: number;
  fromFrame: number;
  moved: boolean;
  preview: DragPreview | null;
  snap: SnapCandidate | null;
}

export interface TracksProps {
  timeline: Timeline;
  control: ViewControl;
  /** Measures the viewport (the area right of the labels). */
  viewportRef: (node: HTMLDivElement | null) => void;
  width: number;
  gate: EditGate;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onEdit: (op: TimelineOp) => void;
}

function clipTitle(clip: TimelineClip, timeline: Timeline, why: string | null): string {
  const lines = [
    clip.label,
    kindStyle(clip.kind).label,
    `Starts ${timeCode(clip.start, timeline.fps)}`,
    `Length ${clipLengthText(clip.duration, timeline.fps)}`,
  ];
  if (clip.source) lines.push(`Source ${clip.source}`);
  if (why) lines.push(why);
  return lines.join("\n");
}

function Playhead({ control, duration }: { control: ViewControl; duration: number }) {
  const frame = usePlaybackFrame();
  const { reveal } = control;
  useEffect(() => reveal(frame), [frame, reveal]);
  const x = xAtFrame(control.view, frame);
  return (
    <div
      role="slider"
      aria-label="Playhead"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={lastFrame(duration)}
      aria-valuenow={frame}
      tabIndex={-1}
      data-testid="playhead"
      className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-danger"
      style={{ left: x, display: x < -1 ? "none" : undefined }}
    >
      <span className="absolute -top-px -left-[5px] size-[11px] rounded-b-sm bg-danger [clip-path:polygon(0_0,100%_0,50%_100%)]" />
    </div>
  );
}

export function Tracks({
  timeline,
  control,
  viewportRef,
  width,
  gate,
  selectedId,
  onSelect,
  onEdit,
}: TracksProps) {
  const playback = usePlayback();
  const { view } = control;
  const node = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const focusRequest = useRef<string | null>(null);
  const scrubbing = useRef(false);
  const lastSeek = useRef({ at: 0, frame: -1, pending: null as number | null });
  const layout = useMemo(() => layoutTimeline(timeline, view), [timeline, view]);
  const ticks = useMemo(
    () => rulerTicks(view, timeline.fps, timeline.duration, width),
    [view, timeline.fps, timeline.duration, width],
  );
  const latest = useRef({ timeline, view, gate, onEdit });
  useLayoutEffect(() => {
    latest.current = { timeline, view, gate, onEdit };
  });

  const setNode = (next: HTMLDivElement | null) => {
    node.current = next;
    viewportRef(next);
  };
  const localX = (clientX: number) => clientX - (node.current?.getBoundingClientRect().left ?? 0);
  const maxFrame = lastFrame(timeline.duration);

  // Ctrl or Cmd with the wheel zooms around the pointer (a pinch arrives the same way); the wheel
  // alone scrolls along the time axis. Needs a non-passive listener to stop the page from zooming.
  useEffect(() => {
    const element = node.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const steps = Math.max(-1, Math.min(1, -event.deltaY / 100));
        control.zoom(steps, event.clientX - element.getBoundingClientRect().left);
      } else {
        control.scrollBy(event.deltaX + event.deltaY);
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [control]);

  // Keyboard navigation between clips asks for the focus; the element may only exist after the
  // view has scrolled to it.
  useEffect(() => {
    const id = focusRequest.current;
    if (id === null || !node.current) return;
    const target = Array.from(node.current.querySelectorAll<HTMLElement>("[data-clip]")).find(
      (element) => element.dataset.clip === id,
    );
    if (target) {
      target.focus();
      focusRequest.current = null;
    }
  });

  // Scrubbing: seek while dragging on the ruler, at most every SCRUB_INTERVAL_MS, and the last
  // frame when the pointer is released.
  const scrubTo = (clientX: number, flush: boolean) => {
    const frame = wholeFrameAtX(latest.current.view, localX(clientX), maxFrame);
    const state = lastSeek.current;
    const now = performance.now();
    if (!flush && now - state.at < SCRUB_INTERVAL_MS) {
      state.pending = frame;
      return;
    }
    state.pending = null;
    state.at = now;
    if (frame !== state.frame) {
      state.frame = frame;
      playback.seek(frame);
    }
  };
  const onRulerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    scrubbing.current = true;
    if ("setPointerCapture" in event.currentTarget) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    lastSeek.current = { at: 0, frame: -1, pending: null };
    scrubTo(event.clientX, true);
  };
  const onRulerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubbing.current) scrubTo(event.clientX, false);
  };
  const onRulerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrubbing.current) return;
    scrubbing.current = false;
    scrubTo(event.clientX, true);
  };

  // Dragging a clip: the pointer is followed on the window until it is released.
  const active = drag !== null;
  const update = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };
  useEffect(() => {
    if (!active) return;
    const move = (event: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const { timeline: t, view: v, gate: g } = latest.current;
      const moved = d.moved || Math.abs(event.clientX - d.startClientX) >= DRAG_START_PX;
      if (!moved) return;
      const raw = frameAtX(v, localX(event.clientX));
      const candidates = snapCandidates(t, playback.getState().frame, d.clip.id);
      let toFrame = Math.round(raw);
      let snap: SnapCandidate | null = null;
      if (d.part !== "body") {
        const snapped = snapFrame(raw, candidates, v.pxPerFrame);
        toFrame = snapped.frame;
        snap = snapped.target;
      } else if (d.clip.kind !== "aroll") {
        const start = d.clip.start + (raw - d.fromRaw);
        const snapped = snapMove(start, d.clip.duration, candidates, v.pxPerFrame);
        toFrame = d.fromFrame + (snapped.frame - d.clip.start);
        snap = snapped.target;
      }
      const preview = dragToOp(
        t,
        { clip: d.clip, part: d.part, fromFrame: d.fromFrame, toFrame },
        g,
      );
      update({ ...d, moved: true, preview, snap });
    };
    const up = () => {
      const d = dragRef.current;
      update(null);
      if (d?.moved && d.preview?.op && !d.preview.noChange) latest.current.onEdit(d.preview.op);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [active, playback]);
  // Esc cancels the drag (the screen's key owner asks here first, before a request being drawn).
  useKeyClaim(
    "Escape",
    () => {
      if (dragRef.current === null) return false;
      update(null);
      return true;
    },
    PRIORITY.drag,
  );

  const onClipDown = (event: ReactPointerEvent<HTMLDivElement>, laid: LaidOutClip) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const { clip } = laid;
    onSelect(clip.id);
    const target = event.target instanceof HTMLElement ? event.target : null;
    const part: ClipPart = (target?.dataset.part as ClipPart | undefined) ?? "body";
    const allow = part === "body" ? canMove(timeline, clip, gate) : canTrim(clip, gate);
    if (!allow.ok) {
      setHint(allow.reason);
      return;
    }
    const fromRaw = frameAtX(view, localX(event.clientX));
    update({
      clip,
      part,
      row: laid.row,
      startClientX: event.clientX,
      fromRaw,
      fromFrame: Math.round(fromRaw),
      moved: false,
      preview: null,
      snap: null,
    });
  };

  const onClipKey = (event: React.KeyboardEvent<HTMLDivElement>, clip: TimelineClip) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const move = (to: TimelineClip | null) => {
      event.preventDefault();
      if (!to) return;
      onSelect(to.id);
      focusRequest.current = to.id;
      control.reveal(to.start);
    };
    const rows = timeline.tracks.filter((track) => track.clips.length > 0);
    const at = rows.findIndex((track) => track.index === clip.track);
    const row = rows[at];
    if (!row) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const index = row.clips.findIndex((c) => c.id === clip.id);
      move(row.clips[index + (event.key === "ArrowLeft" ? -1 : 1)] ?? null);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const other = rows[at + (event.key === "ArrowUp" ? -1 : 1)];
      let best: TimelineClip | null = null;
      for (const c of other?.clips ?? []) {
        if (!best || Math.abs(c.start - clip.start) < Math.abs(best.start - clip.start)) best = c;
      }
      move(best);
    }
  };

  const why = gateReason(gate);
  const firstClip = layout.tracks.find((t) => t.clips.length > 0)?.clips[0]?.clip.id ?? null;
  const tabStop = selectedId ?? firstClip;
  const preview = drag?.moved ? drag.preview : null;
  const snapFrameAt = drag?.moved ? (drag.snap?.frame ?? preview?.dropCut ?? null) : null;
  const note = preview?.limit?.reason ?? hint ?? "";
  const visible = (laid: LaidOutClip) =>
    laid.x + laid.width >= -OVERSCAN_PX && laid.x <= width + OVERSCAN_PX;

  return (
    <div className="flex min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      <div
        className="sticky left-0 z-30 shrink-0 border-r border-border bg-window"
        style={{ width: LABEL_WIDTH }}
      >
        <div
          className="sticky top-0 z-10 border-b border-border bg-window"
          style={{ height: RULER_HEIGHT }}
        />
        {timeline.tracks.map((track) => (
          <div
            key={track.index}
            className="flex items-center truncate border-b border-border px-2 text-xs text-fg-muted"
            style={{ height: ROW_HEIGHT }}
          >
            {track.name}
          </div>
        ))}
      </div>
      <div
        ref={setNode}
        data-measure="tracks"
        data-role="tracks"
        className="relative min-w-0 flex-1 overflow-hidden"
      >
        <div
          data-testid="ruler"
          role="group"
          aria-label="Ruler, click or drag to move the playhead"
          className="sticky top-0 z-10 cursor-pointer touch-none border-b border-border bg-window select-none"
          style={{ height: RULER_HEIGHT }}
          onPointerDown={onRulerDown}
          onPointerMove={onRulerMove}
          onPointerUp={onRulerUp}
          onPointerCancel={onRulerUp}
        >
          {ticks.map((tick) => (
            <div
              key={tick.frame}
              className="pointer-events-none absolute bottom-0"
              style={{ left: tick.x }}
            >
              <div className={cn("w-px bg-border-strong", tick.major ? "h-2.5" : "h-1.5")} />
              {tick.label && (
                <span className="absolute bottom-2 left-1 text-[10px] leading-none whitespace-nowrap text-fg-subtle tabular-nums">
                  {tick.label}
                </span>
              )}
            </div>
          ))}
          {timeline.notes.map((note) => {
            const frame = noteFrame(note, timeline);
            const status = noteStatus(note);
            return (
              <button
                key={note.id}
                type="button"
                data-testid="note-marker"
                data-state={note.state}
                aria-label={`Change request at ${timeCode(frame, timeline.fps)}, ${status.label}`}
                title={`Change request at ${timeCode(frame, timeline.fps)} (${status.label})`}
                className="focus-ring absolute top-0 z-10 -ml-1.5 flex h-3 w-3 items-start justify-center"
                style={{ left: xAtFrame(view, frame) }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => playback.seek(frame)}
              >
                <span className={cn("size-2.5 rounded-b-full", TONE_DOT[status.tone])} />
              </button>
            );
          })}
        </div>
        <div
          data-testid="rows"
          className="relative"
          style={{ height: layout.height }}
          onPointerDown={() => {
            onSelect(null);
            setHint(null);
          }}
        >
          {layout.tracks.map((row) => (
            <div
              key={row.track.index}
              className="absolute right-0 left-0 border-b border-border"
              style={{ top: row.y, height: ROW_HEIGHT }}
            >
              {row.clips.filter(visible).map((laid) => {
                const { clip } = laid;
                const selected = clip.id === selectedId;
                const body = canMove(timeline, clip, gate);
                const trim = canTrim(clip, gate);
                const zone = edgeZone(laid.width);
                const style = kindStyle(clip.kind);
                return (
                  <div
                    key={clip.id}
                    role="button"
                    tabIndex={clip.id === tabStop ? 0 : -1}
                    data-clip={clip.id}
                    data-kind={clip.kind}
                    aria-pressed={selected}
                    aria-label={`${style.label} ${clip.label}, starts ${timeCode(clip.start, timeline.fps)}, ${clipLengthText(clip.duration, timeline.fps)}${isMotionGraphic(clip) ? ", motion graphic" : ""}`}
                    title={clipTitle(clip, timeline, why)}
                    className={cn(
                      "focus-ring absolute top-1 flex items-center overflow-hidden rounded-md border px-1.5 text-xs font-medium select-none",
                      selected ? style.selectedClassName : style.className,
                      selected && "ring-1 ring-current",
                      body.ok ? "cursor-grab" : "cursor-not-allowed",
                      drag?.moved && drag.clip.id === clip.id && "opacity-40",
                    )}
                    style={{ left: laid.x, width: laid.width, height: ROW_HEIGHT - 8 }}
                    onPointerDown={(event) => onClipDown(event, laid)}
                    onPointerUp={() => setHint(null)}
                    onFocus={() => !selected && onSelect(clip.id)}
                    onKeyDown={(event) => onClipKey(event, clip)}
                  >
                    {zone >= 1 && (
                      <>
                        <div
                          data-part="start"
                          aria-hidden
                          className={cn(
                            "absolute inset-y-0 left-0",
                            trim.ok ? "cursor-ew-resize" : "cursor-not-allowed",
                          )}
                          style={{ width: zone }}
                        />
                        <div
                          data-part="end"
                          aria-hidden
                          className={cn(
                            "absolute inset-y-0 right-0",
                            trim.ok ? "cursor-ew-resize" : "cursor-not-allowed",
                          )}
                          style={{ width: zone }}
                        />
                      </>
                    )}
                    <span className="pointer-events-none truncate">{clip.label}</span>
                  </div>
                );
              })}
            </div>
          ))}
          {preview && drag && (
            <div
              data-testid="drag-preview"
              className="pointer-events-none absolute z-10 rounded-md border border-dashed border-fg bg-fg/10"
              style={{
                top: drag.row * ROW_HEIGHT + 4,
                left: xAtFrame(view, preview.start),
                width: Math.max(2, preview.duration * view.pxPerFrame),
                height: ROW_HEIGHT - 8,
              }}
            />
          )}
        </div>
        {snapFrameAt !== null && (
          <div
            data-testid="snap-line"
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-accent"
            style={{ left: xAtFrame(view, snapFrameAt) }}
          />
        )}
        <Playhead control={control} duration={timeline.duration} />
        <div
          role="status"
          data-testid="drag-note"
          className={cn(
            "pointer-events-none absolute bottom-1.5 left-1.5 z-30 max-w-[80%] rounded-md bg-elevated px-2 py-1 text-xs text-fg shadow-popover",
            note === "" && "hidden",
          )}
        >
          {note}
        </div>
      </div>
    </div>
  );
}

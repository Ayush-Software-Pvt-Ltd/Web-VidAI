import { useRef, useState, type PointerEvent } from "react";
import { useAppState } from "@/lib/appEnv";
import { cn } from "@/lib/cn";
import type { NoteShape, TimelineNote } from "@/lib/types";
import {
  noteStatus,
  notesAtFrame,
  shapeFromPointer,
  shapeToPixels,
  type Box,
  type Point,
} from "../model";
import type { Tone } from "../model";
import { usePlaybackFrame } from "../playback";
import { useRequests } from "./requestsState";

export interface FrameOverlayProps {
  videoId: string;
  /** The displayed size of the frame, in CSS pixels. */
  box: Box;
}

/** The colour of a mark by the state of its request (white where the state is plain "waiting"). */
const TONE_CLASS: Record<Tone, string> = {
  accent: "text-accent",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  neutral: "text-white",
};

/** One ellipse with a dark halo, so it reads on any picture. */
function Ellipse({
  shape,
  box,
  className,
  width,
  dashed,
  fill,
}: {
  shape: NoteShape;
  box: Box;
  className: string;
  width: number;
  dashed?: boolean;
  fill?: boolean;
}) {
  const px = shapeToPixels(shape, box);
  const common = { cx: px.cx, cy: px.cy, rx: px.rx, ry: px.ry, fill: "none" };
  return (
    <g className={className}>
      <ellipse {...common} stroke="rgba(0,0,0,0.55)" strokeWidth={width + 2} />
      <ellipse
        {...common}
        stroke="currentColor"
        strokeWidth={width}
        strokeDasharray={dashed ? "6 4" : undefined}
        fill={fill ? "currentColor" : "none"}
        fillOpacity={fill ? 0.14 : undefined}
      />
    </g>
  );
}

function NoteMark({ note, box, selected }: { note: TimelineNote; box: Box; selected: boolean }) {
  const className = TONE_CLASS[noteStatus(note).tone];
  const width = selected ? 3.5 : 2;
  if (note.shape === null) {
    // A request about the whole frame: a frame-sized outline just inside the picture.
    const inset = width + 1;
    return (
      <g className={className} data-note={note.id} data-selected={selected || undefined}>
        <rect
          x={inset}
          y={inset}
          width={Math.max(0, box.width - inset * 2)}
          height={Math.max(0, box.height - inset * 2)}
          rx={4}
          fill="none"
          stroke="currentColor"
          strokeWidth={width}
          strokeDasharray="8 5"
        />
      </g>
    );
  }
  return (
    <g data-note={note.id} data-selected={selected || undefined}>
      <Ellipse shape={note.shape} box={box} className={className} width={width} fill={selected} />
    </g>
  );
}

/**
 * Drawn over the player (SPEC section 11, Change requests). Idle, it shows the marks of the
 * requests at the playhead and lets every pointer event through to the player. While the user
 * asks for a change it takes the pointer: a drag draws an ellipse, a click marks a point.
 */
export function FrameOverlay({ videoId, box }: FrameOverlayProps) {
  const frame = usePlaybackFrame();
  const drawing = useRequests((s) => s.drawing);
  const shape = useRequests((s) => s.shape);
  const selectedId = useRequests((s) => s.selectedId);
  const setShape = useRequests((s) => s.setShape);
  const notes = useAppState((s) => s.timelines[videoId]?.timeline.data?.notes ?? null);
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const pointOf = (event: PointerEvent<HTMLDivElement>): Point => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    // The box is in CSS pixels of the frame; a scaled page maps the pointer back into them.
    const sx = rect.width > 0 ? box.width / rect.width : 1;
    const sy = rect.height > 0 ? box.height / rect.height : 1;
    return { x: (event.clientX - rect.left) * sx, y: (event.clientY - rect.top) * sy };
  };

  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (!drawing || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = pointOf(event);
    setDrag({ from: at, to: at });
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const to = pointOf(event);
    setDrag({ from: drag.from, to });
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const to = pointOf(event);
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (box.width > 0 && box.height > 0) setShape(shapeFromPointer(drag.from, to, box));
  };
  const abandon = (event: PointerEvent<HTMLDivElement>) => {
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const live =
    drag !== null && box.width > 0 && box.height > 0
      ? shapeFromPointer(drag.from, drag.to, box)
      : null;
  const shown = live ?? shape;
  const marks = drawing || notes === null ? [] : notesAtFrame(notes, frame);

  return (
    <div
      ref={ref}
      data-drawing={drawing || undefined}
      role={drawing ? "group" : undefined}
      aria-label={drawing ? "Draw on the frame" : undefined}
      aria-hidden={drawing ? undefined : true}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={abandon}
      style={{
        pointerEvents: drawing ? "auto" : "none",
        touchAction: drawing ? "none" : undefined,
      }}
      className={cn("absolute inset-0 select-none", drawing && "cursor-crosshair")}
    >
      {box.width > 0 && box.height > 0 && (
        <svg
          width={box.width}
          height={box.height}
          viewBox={`0 0 ${box.width} ${box.height}`}
          className="pointer-events-none absolute top-0 left-0 overflow-visible"
          aria-hidden
        >
          {marks.map((note) => (
            <NoteMark key={note.id} note={note} box={box} selected={note.id === selectedId} />
          ))}
          {drawing && shown && (
            <Ellipse shape={shown} box={box} className="text-accent" width={2.5} dashed fill />
          )}
        </svg>
      )}
      {drawing && (
        <p className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 rounded-md bg-black/65 px-2.5 py-1 text-sm whitespace-nowrap text-white">
          {shown ? "Drag again to redraw the circle" : "Drag to circle what should change"}
        </p>
      )}
    </div>
  );
}

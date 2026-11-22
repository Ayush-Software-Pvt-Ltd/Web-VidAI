/**
 * The divider on the left edge of the activity panel (a WAI-ARIA window splitter). Drag it, or
 * focus it and use Left / Right (Shift for bigger steps), Home / End for the smallest and largest
 * width, and Enter (or a double click) for the default width.
 */
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { screenPerLayout } from "@/lib/zoom";

const STEP = 16;
const BIG_STEP = 64;

export interface PanelResizerProps {
  /** The panel's current width in px. */
  width: number;
  min: number;
  max: number;
  /** A new width while dragging (`done` false) or a finished change (`done` true). */
  onResize: (width: number, done: boolean) => void;
  /** Back to the default width. */
  onReset: () => void;
  /** Id of the panel, for `aria-controls`. */
  controls: string;
}

export function PanelResizer({ width, min, max, onResize, onReset, controls }: PanelResizerProps) {
  // `scale` is screen px per layout px (the page zoom): pointer positions are in screen px, the
  // width in layout px.
  const drag = useRef<{ x: number; width: number; last: number; scale: number } | null>(null);

  const clamp = (value: number) => Math.round(Math.min(max, Math.max(min, value)));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    const panel = event.currentTarget.parentElement ?? event.currentTarget;
    drag.current = { x: event.clientX, width, last: width, scale: screenPerLayout(panel) };
    document.documentElement.dataset.resizing = "col";
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    // The panel is at the right: moving the divider left makes it wider.
    const next = clamp(start.width + (start.x - event.clientX) / start.scale);
    if (next === start.last) return;
    start.last = next;
    onResize(next, false);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    drag.current = null;
    delete document.documentElement.dataset.resizing;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onResize(start.last, true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = width + step;
        break;
      case "ArrowRight":
        next = width - step;
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = max;
        break;
      case "Enter":
        event.preventDefault();
        onReset();
        return;
      default:
        return;
    }
    event.preventDefault();
    onResize(clamp(next), true);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize activity panel"
      aria-controls={controls}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      // An 8 px hit area centred on the panel's 1 px left border; a line shows on hover and focus.
      className="group/resizer absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none outline-none"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-1 w-px bg-transparent transition-colors delay-75 duration-150 group-hover/resizer:bg-accent group-focus-visible/resizer:w-0.5 group-focus-visible/resizer:bg-focus group-active/resizer:bg-accent"
      />
    </div>
  );
}

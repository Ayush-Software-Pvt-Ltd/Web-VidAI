// The view of the timeline: how many pixels one frame takes (zoom), where the visible part starts
// (scroll, in pixels of the zoomed content) and the ruler ticks for it.
//
// Limits (decision): at most 8 px per frame (one frame is a clearly visible block) and at least
// 0.02 px per frame (one pixel is 50 frames; an hour at 30 fps is 2160 px). A zoom step is a factor
// of 1.5. "Fit" shows the whole video in the viewport, but never zooms in past the maximum.

import type { TimelineFps } from "@/lib/types";
import { nominalFps, rulerLabel } from "./time";

export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 8;
export const ZOOM_FACTOR = 1.5;
/** Empty space after the last frame, in pixels, so the end can be grabbed and dropped on. */
export const END_PADDING_PX = 48;
/** Ticks are never closer than this many pixels; labelled ticks never closer than `MIN_LABEL_PX`. */
export const MIN_TICK_PX = 10;
export const MIN_LABEL_PX = 72;

export interface View {
  /** Pixels per frame. */
  pxPerFrame: number;
  /** Pixels of the content that are scrolled out on the left. */
  scroll: number;
}

export interface Tick {
  frame: number;
  /** Pixel position in the viewport (content x minus the scroll). */
  x: number;
  major: boolean;
  /** Text for a major tick; `null` for a minor one. */
  label: string | null;
}

export function clampZoom(pxPerFrame: number): number {
  if (!Number.isFinite(pxPerFrame)) return ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pxPerFrame));
}

/** The zoom after `steps` steps in (positive) or out (negative). */
export function zoomBy(pxPerFrame: number, steps: number): number {
  return clampZoom(pxPerFrame * ZOOM_FACTOR ** steps);
}

/** The zoom that shows `duration` frames in `viewportWidth` pixels (with the end padding). */
export function fitZoom(duration: number, viewportWidth: number): number {
  if (duration <= 0 || viewportWidth <= END_PADDING_PX) return ZOOM_MAX;
  return clampZoom((viewportWidth - END_PADDING_PX) / duration);
}

export function contentWidth(duration: number, pxPerFrame: number): number {
  return Math.max(0, duration) * pxPerFrame + END_PADDING_PX;
}

/** The scroll kept inside the content: 0 up to what shows the end padding at the right edge. */
export function clampScroll(
  scroll: number,
  duration: number,
  pxPerFrame: number,
  viewportWidth: number,
): number {
  const max = Math.max(0, contentWidth(duration, pxPerFrame) - viewportWidth);
  return Math.min(max, Math.max(0, scroll));
}

/**
 * The x in layout px (what `View` and every drawn position use) of a pointer at `clientX`, for a
 * viewport whose box on screen is `rect` and whose layout width is `layoutWidth`. The app's text
 * size is a CSS `zoom` on <html>: `clientX` and `getBoundingClientRect` count in screen px, the
 * zoom times the layout px that `ResizeObserver` and the styles use, so the offset into the box is
 * scaled back by the ratio of the two widths (1 without zoom, and in any browser that reports
 * layout px).
 */
export function pointerX(
  clientX: number,
  rect: { left: number; width: number },
  layoutWidth: number,
) {
  const scale = rect.width > 0 && layoutWidth > 0 ? layoutWidth / rect.width : 1;
  return (clientX - rect.left) * scale;
}

/** The frame (a fraction) under pixel `x` of the viewport. */
export function frameAtX(view: View, x: number): number {
  return (x + view.scroll) / view.pxPerFrame;
}

/** The whole frame under pixel `x`, kept in 0 to `max`. */
export function wholeFrameAtX(view: View, x: number, max: number): number {
  return Math.min(Math.max(0, Math.round(frameAtX(view, x))), Math.max(0, max));
}

/** The pixel position in the viewport of the start of `frame`. */
export function xAtFrame(view: View, frame: number): number {
  return frame * view.pxPerFrame - view.scroll;
}

/**
 * Zooms by `steps` and scrolls so that the frame under `anchorX` stays where it is (the playhead
 * or the pointer).
 */
export function zoomAround(
  view: View,
  steps: number,
  anchorX: number,
  duration: number,
  viewportWidth: number,
): View {
  const pxPerFrame = zoomBy(view.pxPerFrame, steps);
  const frame = frameAtX(view, anchorX);
  const scroll = clampScroll(frame * pxPerFrame - anchorX, duration, pxPerFrame, viewportWidth);
  return { pxPerFrame, scroll };
}

/** The scroll that shows `frame` with `margin` pixels of room, or the same scroll when it shows. */
export function scrollToReveal(
  view: View,
  frame: number,
  duration: number,
  viewportWidth: number,
  margin = 24,
): number {
  const x = xAtFrame(view, frame);
  let scroll = view.scroll;
  if (x < margin) scroll = frame * view.pxPerFrame - margin;
  else if (x > viewportWidth - margin) scroll = frame * view.pxPerFrame - viewportWidth + margin;
  return clampScroll(scroll, duration, view.pxPerFrame, viewportWidth);
}

/** The steps a ruler can have, in frames, from fine to coarse, for a nominal rate of `n`. */
export function tickSteps(n: number): number[] {
  const steps = new Set<number>();
  for (const f of [1, 2, 5, 10]) if (f < n) steps.add(f);
  if (n % 2 === 0 && n / 2 > 10) steps.add(n / 2);
  for (const s of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14_400, 28_800]) {
    steps.add(s * n);
  }
  return [...steps].sort((a, b) => a - b);
}

/**
 * The ticks of the visible part. The labelled (major) step is the finest of `tickSteps` that is at
 * least `MIN_LABEL_PX` wide; the minor step is the finest divisor of it at least `MIN_TICK_PX` wide.
 * Frames are whole numbers.
 */
export function rulerTicks(
  view: View,
  fps: TimelineFps,
  duration: number,
  viewportWidth: number,
): Tick[] {
  const steps = tickSteps(nominalFps(fps));
  const wide = (step: number) => step * view.pxPerFrame;
  const major = steps.find((s) => wide(s) >= MIN_LABEL_PX) ?? steps[steps.length - 1] ?? 1;
  const minor = steps.find((s) => major % s === 0 && wide(s) >= MIN_TICK_PX && s <= major) ?? major;
  const from = Math.max(0, Math.floor(frameAtX(view, -MIN_LABEL_PX) / minor) * minor);
  const to = Math.min(
    Math.max(0, duration),
    Math.ceil(frameAtX(view, viewportWidth + MIN_LABEL_PX)),
  );
  const ticks: Tick[] = [];
  for (let frame = from; frame <= to; frame += minor) {
    const isMajor = frame % major === 0;
    ticks.push({
      frame,
      x: xAtFrame(view, frame),
      major: isMajor,
      label: isMajor ? rulerLabel(frame, fps) : null,
    });
  }
  return ticks;
}

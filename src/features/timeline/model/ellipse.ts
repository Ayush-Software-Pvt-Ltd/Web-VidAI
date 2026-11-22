// The ellipse of a change request, in fractions of the frame (`NoteShape` as the wire has it).
// The server needs: centre between 0 and 1, radii above 0 and at most 1 (`validateNote`).
//
// Decisions the validator leaves open:
// - A drag from one point to another draws the ellipse in the box those two points span (like an
//   ellipse tool), so it never leaves the frame and its radii are at most 0.5.
// - A pointer that moved less than `CLICK_PX` in both directions is a click, not a drag: the shape
//   is a small circle of `POINT_RADIUS_PX` pixels (of the displayed frame) around the point.
// - A drag is never thinner than `MIN_RADIUS_PX` pixels in either direction.

import type { NoteShape } from "@/lib/types";

export const CLICK_PX = 4;
export const POINT_RADIUS_PX = 24;
export const MIN_RADIUS_PX = 6;

/** The displayed size of the frame in pixels (the container the overlay is mounted in). */
export interface Box {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A shape in pixels of the box (centre and radii). */
export interface PixelShape {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

/** A point inside the box. */
export function clampPoint(point: Point, box: Box): Point {
  return { x: clamp(point.x, 0, box.width), y: clamp(point.y, 0, box.height) };
}

/** Whether the two pointer positions are a click (no real drag). */
export function isClick(from: Point, to: Point): boolean {
  return Math.abs(to.x - from.x) < CLICK_PX && Math.abs(to.y - from.y) < CLICK_PX;
}

/** The shape a click at `point` gives: a small circle, kept inside the frame. */
export function pointShape(point: Point, box: Box): NoteShape {
  const p = clampPoint(point, box);
  return {
    cx: p.x / box.width,
    cy: p.y / box.height,
    rx: Math.min(1, POINT_RADIUS_PX / box.width),
    ry: Math.min(1, POINT_RADIUS_PX / box.height),
  };
}

/**
 * The shape of a drag between two pointer positions in a box of any size. Positions outside the box
 * count as on its edge; a click gives `pointShape`; each radius is at least `MIN_RADIUS_PX`.
 */
export function shapeFromPointer(from: Point, to: Point, box: Box): NoteShape {
  if (box.width <= 0 || box.height <= 0) return { cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5 };
  if (isClick(from, to)) return pointShape(from, box);
  const a = clampPoint(from, box);
  const b = clampPoint(to, box);
  const rx = Math.max(Math.abs(b.x - a.x) / 2, Math.min(MIN_RADIUS_PX, box.width / 2));
  const ry = Math.max(Math.abs(b.y - a.y) / 2, Math.min(MIN_RADIUS_PX, box.height / 2));
  // Keep the whole ellipse inside the frame when the minimum widened it at an edge.
  const cx = clamp((a.x + b.x) / 2, rx, box.width - rx);
  const cy = clamp((a.y + b.y) / 2, ry, box.height - ry);
  return { cx: cx / box.width, cy: cy / box.height, rx: rx / box.width, ry: ry / box.height };
}

/** The shape in pixels of the box, for drawing. */
export function shapeToPixels(shape: NoteShape, box: Box): PixelShape {
  return {
    cx: shape.cx * box.width,
    cy: shape.cy * box.height,
    rx: shape.rx * box.width,
    ry: shape.ry * box.height,
  };
}

/** The shape of a drawing in pixels of the box. */
export function pixelsToShape(shape: PixelShape, box: Box): NoteShape {
  return clampShape({
    cx: shape.cx / box.width,
    cy: shape.cy / box.height,
    rx: shape.rx / box.width,
    ry: shape.ry / box.height,
  });
}

/** The shape with the centre inside the frame and radii in (0, 1]; what `validateNote` accepts. */
export function clampShape(shape: NoteShape): NoteShape {
  const tiny = 1e-4;
  return {
    cx: clamp(shape.cx, 0, 1),
    cy: clamp(shape.cy, 0, 1),
    rx: clamp(shape.rx, tiny, 1),
    ry: clamp(shape.ry, tiny, 1),
  };
}

/** Whether a shape is what the server accepts. */
export function isValidShape(shape: NoteShape): boolean {
  const finite = [shape.cx, shape.cy, shape.rx, shape.ry].every(Number.isFinite);
  return (
    finite &&
    shape.cx >= 0 &&
    shape.cx <= 1 &&
    shape.cy >= 0 &&
    shape.cy <= 1 &&
    shape.rx > 0 &&
    shape.rx <= 1 &&
    shape.ry > 0 &&
    shape.ry <= 1
  );
}

/** Whether a point (in pixels of the box) is inside the drawn ellipse. */
export function shapeContains(shape: NoteShape, point: Point, box: Box): boolean {
  const px = shapeToPixels(shape, box);
  if (px.rx <= 0 || px.ry <= 0) return false;
  const dx = (point.x - px.cx) / px.rx;
  const dy = (point.y - px.cy) / px.ry;
  return dx * dx + dy * dy <= 1;
}

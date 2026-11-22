import { describe, expect, it } from "vitest";
import {
  CLICK_PX,
  MIN_RADIUS_PX,
  POINT_RADIUS_PX,
  clampPoint,
  clampShape,
  isClick,
  isValidShape,
  pixelsToShape,
  pointShape,
  shapeContains,
  shapeFromPointer,
  shapeToPixels,
} from "./ellipse";

const box = { width: 640, height: 360 };

describe("pointer to shape", () => {
  it("draws the ellipse in the box the two points span", () => {
    const shape = shapeFromPointer({ x: 100, y: 100 }, { x: 300, y: 200 }, box);
    expect(shape.cx).toBeCloseTo(200 / 640, 9);
    expect(shape.cy).toBeCloseTo(150 / 360, 9);
    expect(shape.rx).toBeCloseTo(100 / 640, 9);
    expect(shape.ry).toBeCloseTo(50 / 360, 9);
  });
  it("gives the same shape in any direction and in a box of any size", () => {
    const a = shapeFromPointer({ x: 300, y: 200 }, { x: 100, y: 100 }, box);
    const b = shapeFromPointer({ x: 100, y: 100 }, { x: 300, y: 200 }, box);
    expect(a).toEqual(b);
    const big = shapeFromPointer(
      { x: 200, y: 200 },
      { x: 600, y: 400 },
      { width: 1280, height: 720 },
    );
    const small = shapeFromPointer(
      { x: 100, y: 100 },
      { x: 300, y: 200 },
      { width: 640, height: 360 },
    );
    expect(big.rx).toBeCloseTo(small.rx, 9);
    expect(big.cy).toBeCloseTo(small.cy, 9);
  });
  it("clamps pointer positions into the frame", () => {
    const shape = shapeFromPointer({ x: -50, y: -50 }, { x: 9000, y: 9000 }, box);
    expect(shape).toEqual({ cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5 });
    expect(clampPoint({ x: -1, y: 400 }, box)).toEqual({ x: 0, y: 360 });
    expect(isValidShape(shape)).toBe(true);
  });
  it("a click is a small circle, kept inside the frame", () => {
    expect(isClick({ x: 10, y: 10 }, { x: 10 + CLICK_PX - 1, y: 10 })).toBe(true);
    expect(isClick({ x: 10, y: 10 }, { x: 10 + CLICK_PX, y: 10 })).toBe(false);
    const click = shapeFromPointer({ x: 320, y: 180 }, { x: 321, y: 181 }, box);
    expect(click).toEqual(pointShape({ x: 320, y: 180 }, box));
    expect(click.rx).toBeCloseTo(POINT_RADIUS_PX / 640, 9);
    expect(click.ry).toBeCloseTo(POINT_RADIUS_PX / 360, 9);
    const corner = pointShape({ x: -20, y: 9999 }, box);
    expect(corner.cx).toBe(0);
    expect(corner.cy).toBe(1);
    expect(isValidShape(corner)).toBe(true);
  });
  it("a drag is never thinner than the minimum and stays inside at an edge", () => {
    const line = shapeFromPointer({ x: 100, y: 100 }, { x: 300, y: 100 + CLICK_PX }, box);
    expect(line.ry * 360).toBeGreaterThanOrEqual(MIN_RADIUS_PX - 1e-9);
    const edge = shapeFromPointer({ x: 0, y: 0 }, { x: 100, y: CLICK_PX }, box);
    expect(edge.cy - edge.ry).toBeGreaterThanOrEqual(-1e-12);
    expect(edge.cx - edge.rx).toBeGreaterThanOrEqual(-1e-12);
    expect(isValidShape(edge)).toBe(true);
  });
  it("copes with an empty or tiny box", () => {
    expect(
      isValidShape(shapeFromPointer({ x: 0, y: 0 }, { x: 5, y: 5 }, { width: 0, height: 0 })),
    ).toBe(true);
    const tiny = shapeFromPointer({ x: 0, y: 0 }, { x: 20, y: 20 }, { width: 8, height: 8 });
    expect(isValidShape(tiny)).toBe(true);
  });
});

describe("pixels", () => {
  it("round-trips through pixels", () => {
    const shape = { cx: 0.25, cy: 0.5, rx: 0.1, ry: 0.2 };
    const px = shapeToPixels(shape, box);
    expect(px).toEqual({ cx: 160, cy: 180, rx: 64, ry: 72 });
    const back = pixelsToShape(px, box);
    expect(back.cx).toBeCloseTo(shape.cx, 9);
    expect(back.ry).toBeCloseTo(shape.ry, 9);
    const other = shapeToPixels(shape, { width: 1280, height: 720 });
    expect(other.rx).toBe(128);
  });
  it("clampShape gives what the validator accepts", () => {
    expect(clampShape({ cx: -1, cy: 2, rx: 0, ry: 5 })).toEqual({ cx: 0, cy: 1, rx: 1e-4, ry: 1 });
    expect(isValidShape(clampShape({ cx: Number.NaN, cy: 0.5, rx: 0.1, ry: 0.1 }))).toBe(true);
  });
  it.each([
    [{ cx: 0, cy: 0, rx: 0.1, ry: 0.1 }, true],
    [{ cx: 1, cy: 1, rx: 1, ry: 1 }, true],
    [{ cx: 1.01, cy: 0.5, rx: 0.1, ry: 0.1 }, false],
    [{ cx: 0.5, cy: -0.01, rx: 0.1, ry: 0.1 }, false],
    [{ cx: 0.5, cy: 0.5, rx: 0, ry: 0.1 }, false],
    [{ cx: 0.5, cy: 0.5, rx: 0.1, ry: 1.01 }, false],
    [{ cx: 0.5, cy: 0.5, rx: Number.NaN, ry: 0.1 }, false],
  ])("isValidShape(%j) is %s (the server's rule)", (shape, ok) => {
    expect(isValidShape(shape)).toBe(ok);
  });
  it("tests a point against the drawn ellipse", () => {
    const shape = { cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25 };
    expect(shapeContains(shape, { x: 320, y: 180 }, box)).toBe(true);
    expect(shapeContains(shape, { x: 320 + 160, y: 180 }, box)).toBe(true);
    expect(shapeContains(shape, { x: 320 + 161, y: 180 }, box)).toBe(false);
    expect(shapeContains(shape, { x: 320, y: 180 + 91 }, box)).toBe(false);
  });
});

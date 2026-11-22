import { describe, expect, it } from "vitest";
import {
  END_PADDING_PX,
  MIN_LABEL_PX,
  MIN_TICK_PX,
  ZOOM_MAX,
  ZOOM_MIN,
  clampScroll,
  clampZoom,
  contentWidth,
  fitZoom,
  frameAtX,
  pointerX,
  rulerTicks,
  scrollToReveal,
  tickSteps,
  wholeFrameAtX,
  xAtFrame,
  zoomAround,
  zoomBy,
} from "./view";

const F30 = { num: 30, den: 1 };

describe("zoom", () => {
  it("is limited", () => {
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(1000)).toBe(ZOOM_MAX);
    expect(clampZoom(Number.NaN)).toBe(ZOOM_MIN);
    expect(zoomBy(ZOOM_MAX, 3)).toBe(ZOOM_MAX);
    expect(zoomBy(ZOOM_MIN, -3)).toBe(ZOOM_MIN);
    expect(zoomBy(2, 0)).toBe(2);
    expect(zoomBy(2, 1)).toBeCloseTo(3, 9);
    expect(zoomBy(3, -1)).toBeCloseTo(2, 9);
  });
  it("fits the whole video, never past the maximum", () => {
    expect(fitZoom(1000, 1048)).toBeCloseTo(1, 9);
    expect(fitZoom(10, 1048)).toBe(ZOOM_MAX);
    expect(fitZoom(0, 1000)).toBe(ZOOM_MAX);
    expect(fitZoom(10_000_000, 1000)).toBe(ZOOM_MIN);
    expect(fitZoom(100, 10)).toBe(ZOOM_MAX);
  });
});

describe("positions", () => {
  const view = { pxPerFrame: 2, scroll: 100 };
  it("converts both ways with the scroll", () => {
    expect(frameAtX(view, 0)).toBe(50);
    expect(xAtFrame(view, 50)).toBe(0);
    expect(xAtFrame(view, 0)).toBe(-100);
    expect(frameAtX(view, xAtFrame(view, 123))).toBe(123);
  });
  it("whole frame at x is rounded and kept inside", () => {
    expect(wholeFrameAtX(view, 1, 399)).toBe(51);
    expect(wholeFrameAtX(view, -500, 399)).toBe(0);
    expect(wholeFrameAtX(view, 100_000, 399)).toBe(399);
    expect(wholeFrameAtX({ pxPerFrame: 0.02, scroll: 0 }, 5, 399)).toBe(250);
  });
  it("content width has the end padding", () => {
    expect(contentWidth(400, 2)).toBe(800 + END_PADDING_PX);
    expect(contentWidth(0, 2)).toBe(END_PADDING_PX);
  });
  it("scroll stays inside the content", () => {
    expect(clampScroll(-10, 400, 2, 500)).toBe(0);
    expect(clampScroll(10_000, 400, 2, 500)).toBe(800 + END_PADDING_PX - 500);
    expect(clampScroll(10_000, 10, 2, 500)).toBe(0);
  });
  it("zooming around a point keeps the frame under it", () => {
    const start = { pxPerFrame: 2, scroll: 100 };
    const next = zoomAround(start, 1, 300, 1000, 500);
    expect(next.pxPerFrame).toBeCloseTo(3, 9);
    expect(frameAtX(next, 300)).toBeCloseTo(frameAtX(start, 300), 6);
    const atMax = zoomAround({ pxPerFrame: ZOOM_MAX, scroll: 0 }, 1, 100, 1000, 500);
    expect(atMax.pxPerFrame).toBe(ZOOM_MAX);
    expect(atMax.scroll).toBe(0);
  });
  it("reveals a frame only when it is off screen", () => {
    const start = { pxPerFrame: 2, scroll: 0 };
    expect(scrollToReveal(start, 100, 1000, 500)).toBe(0);
    expect(scrollToReveal(start, 400, 1000, 500)).toBe(400 * 2 - 500 + 24);
    expect(scrollToReveal({ pxPerFrame: 2, scroll: 600 }, 10, 1000, 500)).toBe(0);
  });
});

describe("ruler ticks", () => {
  it("steps are ascending, whole frames, with sub-second steps below the rate", () => {
    for (const n of [24, 30, 60]) {
      const steps = tickSteps(n);
      expect([...steps].sort((a, b) => a - b)).toEqual(steps);
      expect(steps.every(Number.isInteger)).toBe(true);
      expect(steps).toContain(n);
      expect(steps).toContain(60 * n);
    }
    expect(tickSteps(30)).toEqual(expect.arrayContaining([1, 2, 5, 10, 15, 30, 60]));
    expect(tickSteps(24)).toContain(12);
  });

  it.each([ZOOM_MIN, 0.05, 0.2, 1, 3, ZOOM_MAX])(
    "never denser than the minimum, at %f px per frame",
    (pxPerFrame) => {
      const ticks = rulerTicks({ pxPerFrame, scroll: 0 }, F30, 100_000, 1200);
      expect(ticks.length).toBeGreaterThan(1);
      for (let i = 1; i < ticks.length; i += 1) {
        const a = ticks[i - 1];
        const b = ticks[i];
        expect((b?.x ?? 0) - (a?.x ?? 0)).toBeGreaterThanOrEqual(MIN_TICK_PX - 1e-9);
      }
      const labelled = ticks.filter((t) => t.label !== null);
      for (let i = 1; i < labelled.length; i += 1) {
        expect((labelled[i]?.x ?? 0) - (labelled[i - 1]?.x ?? 0)).toBeGreaterThanOrEqual(
          MIN_LABEL_PX - 1e-9,
        );
      }
      expect(ticks.every((t) => Number.isInteger(t.frame))).toBe(true);
      expect(ticks.every((t) => t.major === (t.label !== null))).toBe(true);
    },
  );

  it("labels round time values at a usual zoom", () => {
    const ticks = rulerTicks({ pxPerFrame: 2, scroll: 0 }, F30, 400, 800);
    const labels = ticks.filter((t) => t.label !== null).map((t) => t.label);
    expect(labels[0]).toBe("0:00");
    expect(ticks[0]).toMatchObject({ frame: 0, x: 0, major: true });
    expect(labels.length).toBeGreaterThan(2);
  });

  it("shows frame steps at the maximum zoom and minutes at the minimum", () => {
    const fine = rulerTicks({ pxPerFrame: ZOOM_MAX, scroll: 0 }, F30, 400, 800);
    expect(fine[1]?.frame).toBe(2);
    const coarse = rulerTicks({ pxPerFrame: ZOOM_MIN, scroll: 0 }, F30, 100_000, 1000);
    const majors = coarse.filter((t) => t.major);
    expect((majors[1]?.frame ?? 0) % 1800).toBe(0);
  });

  it("only covers the visible part and the video", () => {
    const view = { pxPerFrame: 4, scroll: 2000 };
    const ticks = rulerTicks(view, F30, 10_000, 400);
    expect(ticks[0]?.frame).toBeGreaterThanOrEqual(400);
    expect(ticks.at(-1)?.frame).toBeLessThanOrEqual(10_000);
    const short = rulerTicks({ pxPerFrame: 4, scroll: 0 }, F30, 20, 800);
    expect(short.at(-1)?.frame).toBeLessThanOrEqual(20);
    expect(rulerTicks({ pxPerFrame: 4, scroll: 0 }, F30, 0, 800)).toHaveLength(1);
  });

  it("works at 23.976, 29.97 and 60 fps", () => {
    for (const fps of [
      { num: 24000, den: 1001 },
      { num: 30000, den: 1001 },
      { num: 60, den: 1 },
    ]) {
      const ticks = rulerTicks({ pxPerFrame: 4, scroll: 0 }, fps, 5000, 900);
      expect(ticks.some((t) => t.label === "0:01")).toBe(true);
    }
  });
});

describe("pointerX", () => {
  it("is the offset into the viewport when nothing is zoomed", () => {
    expect(pointerX(350, { left: 100, width: 600 }, 600)).toBe(250);
  });

  it("scales the screen px of a zoomed page back to layout px", () => {
    // A page zoom of 1.4: the box is 600 layout px wide, 840 on screen, starting at 140 on screen.
    const rect = { left: 140, width: 840 };
    expect(pointerX(140, rect, 600)).toBe(0);
    expect(pointerX(140 + 420, rect, 600)).toBeCloseTo(300, 9);
    expect(pointerX(140 + 840, rect, 600)).toBeCloseTo(600, 9);
  });

  it("does not divide by zero before the viewport is measured", () => {
    expect(pointerX(30, { left: 10, width: 0 }, 0)).toBe(20);
    expect(pointerX(30, { left: 10, width: 100 }, 0)).toBe(20);
  });
});

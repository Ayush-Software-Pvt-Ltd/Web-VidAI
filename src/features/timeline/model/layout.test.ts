import { describe, expect, it } from "vitest";
import {
  CLIP_KINDS,
  MIN_CLIP_PX,
  ROW_HEIGHT,
  allClips,
  arollClips,
  clipsAtFrame,
  findClip,
  isMotionGraphic,
  isSound,
  kindStyle,
  layoutTimeline,
} from "./layout";
import {
  EDGE_ZONE_PX,
  SNAP_TOLERANCE_PX,
  edgeZone,
  hitTest,
  partAt,
  snapCandidates,
  snapFrame,
  snapMove,
} from "./hit";
import { clip, sample } from "./testTimeline";

describe("kinds", () => {
  it("every kind has a label, a tone and token classes only", () => {
    expect(CLIP_KINDS).toHaveLength(8);
    for (const kind of CLIP_KINDS) {
      const style = kindStyle(kind);
      expect(style.kind).toBe(kind);
      expect(style.label.length).toBeGreaterThan(0);
      expect(style.className).not.toMatch(/#|rgb|\[/);
      expect(style.selectedClassName).not.toBe(style.className);
    }
  });
  it("classifies sound and motion graphics", () => {
    expect(isSound("sfx")).toBe(true);
    expect(isSound("music")).toBe(true);
    expect(isSound("broll")).toBe(false);
    expect(isMotionGraphic(clip("g", "graphic", 1, 0, 10, { file: "compositions/g.html" }))).toBe(
      true,
    );
    expect(
      isMotionGraphic(
        clip("b", "broll", 1, 0, 10, { file: "compositions/b.html", source: "b.mp4" }),
      ),
    ).toBe(false);
  });
});

describe("layout", () => {
  it("lays tracks out in the wire's order, one row each", () => {
    const layout = layoutTimeline(sample(), { pxPerFrame: 2, scroll: 40 });
    expect(layout.tracks.map((t) => t.track.index)).toEqual([0, 1, 2, 3, 4, 10]);
    expect(layout.height).toBe(6 * ROW_HEIGHT);
    const a2 = layout.tracks[0]?.clips[1];
    expect(a2).toMatchObject({ x: 160, width: 300, row: 0, y: 0 });
    const music = layout.tracks[5]?.clips[0];
    expect(music).toMatchObject({ row: 5, y: 5 * ROW_HEIGHT, x: -40 });
  });
  it("draws a one-frame clip at a far zoom at least a few pixels wide", () => {
    const timeline = sample();
    timeline.tracks[2]?.clips.push(clip("o-1", "overlay", 2, 10, 1, { source: null }));
    const laid = layoutTimeline(timeline, { pxPerFrame: 0.02, scroll: 0 });
    expect(laid.tracks[2]?.clips[0]?.width).toBe(MIN_CLIP_PX);
  });
  it("finds clips", () => {
    const timeline = sample();
    expect(allClips(timeline)).toHaveLength(8);
    expect(findClip(timeline, "b-2")?.start).toBe(80);
    expect(findClip(timeline, "nope")).toBeNull();
    expect(arollClips(timeline).map((c) => c.id)).toEqual(["a-1", "a-2", "a-3"]);
  });
  it("lists the clips under a frame from the top track down, edges half open", () => {
    const timeline = sample();
    expect(clipsAtFrame(timeline, 30).map((c) => c.id)).toEqual(["m-1", "b-1", "a-1"]);
    expect(clipsAtFrame(timeline, 100).map((c) => c.id)).toEqual(["m-1", "b-2", "a-2"]);
    expect(clipsAtFrame(timeline, 60).map((c) => c.id)).toEqual(["m-1", "a-1"]);
    expect(clipsAtFrame(timeline, 400)).toEqual([]);
    expect(clipsAtFrame(timeline, 0).map((c) => c.id)).toEqual(["m-1", "a-1"]);
  });
});

describe("hit tests", () => {
  it.each([
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 1],
    [8, 2],
    [24, 8],
    [300, 8],
  ])("edge zone of a %ipx clip is %i", (width, zone) => {
    expect(edgeZone(width)).toBe(zone);
    expect(zone).toBeLessThanOrEqual(EDGE_ZONE_PX);
  });

  const layout = layoutTimeline(sample(), { pxPerFrame: 2, scroll: 0 });
  it("finds the part of a clip", () => {
    // a-2 spans x 200 to 500 on row 0
    expect(hitTest(layout, 200, 5)).toMatchObject({ part: "start", clip: { id: "a-2" } });
    expect(hitTest(layout, 207, 5)?.part).toBe("start");
    expect(hitTest(layout, 208, 5)?.part).toBe("body");
    expect(hitTest(layout, 491, 5)?.part).toBe("body");
    expect(hitTest(layout, 492, 5)?.part).toBe("end");
    expect(hitTest(layout, 499, 5)?.part).toBe("end");
  });
  it("misses empty space and outside the rows", () => {
    expect(hitTest(layout, 501 + 400, 5)).toBeNull();
    expect(hitTest(layout, 100, ROW_HEIGHT * 2 + 3)).toBeNull();
    expect(hitTest(layout, 100, -1)).toBeNull();
    expect(hitTest(layout, 100, ROW_HEIGHT * 99)).toBeNull();
    expect(hitTest(layout, -5, 5)).toBeNull();
  });
  it("picks the row", () => {
    expect(hitTest(layout, 100, ROW_HEIGHT + 3)?.clip.id).toBe("b-1");
    expect(hitTest(layout, 100, ROW_HEIGHT * 5 + 3)?.clip.id).toBe("m-1");
  });
  it("keeps a body on a short clip", () => {
    const timeline = sample();
    timeline.tracks[2]?.clips.push(clip("o-1", "overlay", 2, 10, 3, { source: null }));
    const short = layoutTimeline(timeline, { pxPerFrame: 3, scroll: 0 });
    const laid = short.tracks[2]?.clips[0];
    expect(laid?.width).toBe(9);
    const parts = [30, 33, 35, 38].map((x) => laid && partAt(laid, x));
    expect(parts).toEqual(["start", "body", "body", "end"]);
    const tiny = layoutTimeline(timeline, { pxPerFrame: 0.5, scroll: 0 }).tracks[2]?.clips[0];
    if (!tiny) throw new Error("no clip");
    expect(partAt(tiny, tiny.x + 0.5)).toBe("body");
  });
});

describe("snapping", () => {
  it("collects the playhead, start, end and every edge once, sorted", () => {
    const timeline = sample();
    const candidates = snapCandidates(timeline, 123);
    const frames = candidates.map((c) => c.frame);
    expect(frames).toEqual([...frames].sort((a, b) => a - b));
    expect(new Set(frames).size).toBe(frames.length);
    expect(frames).toEqual(expect.arrayContaining([0, 20, 60, 80, 100, 120, 123, 250, 400]));
    expect(candidates.find((c) => c.frame === 123)?.source).toBe("playhead");
    expect(candidates.find((c) => c.frame === 0)?.source).toBe("start");
    expect(candidates.find((c) => c.frame === 400)?.source).toBe("end");
    expect(candidates.find((c) => c.frame === 250)).toMatchObject({ source: "clip" });
  });
  it("lets the playhead win over an edge at the same frame", () => {
    const candidates = snapCandidates(sample(), 100);
    expect(candidates.find((c) => c.frame === 100)?.source).toBe("playhead");
  });
  it("leaves out the dragged clip's own edges", () => {
    const frames = snapCandidates(sample(), 5, "b-1").map((c) => c.frame);
    expect(frames).not.toContain(20);
    expect(frames).not.toContain(60);
  });
  it("snaps to the nearest within the tolerance and reports the target", () => {
    const candidates = snapCandidates(sample(), 5);
    const near = snapFrame(98.4, candidates, 4);
    expect(near.frame).toBe(100);
    expect(near.target?.frame).toBe(100);
    const far = snapFrame(90.4, candidates, 4);
    expect(far).toEqual({ frame: 90, target: null });
    const edge = snapFrame(100 - SNAP_TOLERANCE_PX / 4, candidates, 4);
    expect(edge.target?.frame).toBe(100);
    expect(snapFrame(100 - SNAP_TOLERANCE_PX / 4 - 0.5, candidates, 4).target).toBeNull();
  });
  it("tolerance is in pixels, so a far zoom reaches further", () => {
    const candidates = snapCandidates(sample(), 5);
    expect(snapFrame(110, candidates, 0.1).target).not.toBeNull();
    expect(snapFrame(110, candidates, 8).target).toBeNull();
    expect(snapFrame(10, [], 4)).toEqual({ frame: 10, target: null });
  });
  it("snaps the end of a moved clip as well as its start", () => {
    const candidates = snapCandidates(sample(), 5, "g-1");
    const byStart = snapMove(98, 50, candidates, 4);
    expect(byStart).toMatchObject({ frame: 100 });
    const byEnd = snapMove(198, 50, candidates, 4);
    expect(byEnd.frame).toBe(200);
    expect(byEnd.target?.frame).toBe(250);
    expect(snapMove(180, 7, candidates, 4)).toEqual({ frame: 180, target: null });
  });
});

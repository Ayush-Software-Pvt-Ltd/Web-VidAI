import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProject } from "../../src/timeline/document.js";
import { toTimeline } from "../../src/timeline/model.js";
import { fixture, generate, toCrlf } from "./helpers.js";

/** @type {import("../../src/timeline/model.js").TimelineExtras} */
const extras = {
  revision: 3,
  notes: [],
  canUndo: false,
  canRedo: true,
  locked: { jobId: "job-1", kind: "edit" },
};

/** @param {import("../../../src/lib/wire/timeline.ts").Timeline} t */
const rows = (t) =>
  t.tracks.map((track) => [
    track.index,
    track.name,
    track.clips.map((c) => [
      c.id,
      c.kind,
      c.start,
      c.duration,
      c.mediaStart,
      c.sourceFrames,
      c.source,
      c.file,
      c.label,
    ]),
  ]);

test("the Long fixture becomes the expected timeline", () => {
  const f = fixture("long");
  const t = toTimeline(parseProject(f.html), f.facts, extras);
  assert.equal(t.revision, 3);
  assert.deepEqual(t.fps, { num: 30, den: 1 });
  assert.equal(t.width, 1920);
  assert.equal(t.height, 1080);
  assert.equal(t.duration, 1350);
  assert.equal(t.canUndo, false);
  assert.equal(t.canRedo, true);
  assert.deepEqual(t.locked, { jobId: "job-1", kind: "edit" });
  assert.deepEqual(t.notes, []);
  assert.deepEqual(
    t.tracks.map((x) => [x.index, x.name]),
    [
      [4, "End fade"],
      [3, "Keyword hits"],
      [2, "Overlays"],
      [1, "B-roll and graphics"],
      [0, "A-roll"],
      [10, "Sound 1"],
      [11, "Sound 2"],
      [12, "Sound 3"],
    ],
  );
  const byTrack = Object.fromEntries(rows(t).map(([i, , clips]) => [i, clips]));
  assert.deepEqual(byTrack[0], [
    ["a-1", "aroll", 0, 150, 60, 6000, "aroll.mp4", null, "Hook"],
    ["a-2", "aroll", 150, 210, 360, 6000, "aroll.mp4", null, "Problem"],
    ["a-3", "aroll", 360, 120, 900, 6000, "aroll.mp4", null, "Turn"],
    ["a-4", "aroll", 480, 180, 1365, 6000, "aroll.mp4", null, "Solution"],
    ["a-5", "aroll", 660, 240, 1800, 6000, "aroll.mp4", null, "Proof"],
    ["a-6", "aroll", 900, 90, 2400, 6000, "aroll.mp4", null, "Detail"],
    ["a-7", "aroll", 990, 200, 3015, 6000, "aroll.mp4", null, "Offer"],
    ["a-8", "aroll", 1190, 160, 3900, 6000, "aroll.mp4", null, "Call to action"],
  ]);
  assert.deepEqual(byTrack[1], [
    ["b-1", "broll", 60, 90, 0, 1800, "broll.mp4", null, "Street"],
    ["b-2", "broll", 400, 120, 105, 1800, "broll.mp4", null, "Workshop"],
    ["g-1", "graphic", 600, 90, null, null, null, "compositions/g-1.html", "Big number"],
    ["b-3", "broll", 800, 60, null, null, "product.png", null, "Product"],
  ]);
  assert.deepEqual(
    byTrack[3]?.map((/** @type {unknown[]} */ c) => c[0]),
    ["h-1", "h-2", "h-3"],
  );
  assert.deepEqual(byTrack[10]?.[0], ["s-1", "sfx", 95, 30, 0, 90, "whoosh.wav", null, "Whoosh"]);
  assert.deepEqual(byTrack[12], [["m-1", "music", 0, 1350, 0, 4500, "bed.mp3", null, "Music bed"]]);
});

test("a source at another frame rate is measured in project frames", () => {
  const f = fixture("long");
  const t = toTimeline(parseProject(f.html), f.facts, extras);
  const b1 = t.tracks.find((x) => x.index === 1)?.clips.find((c) => c.id === "b-1");
  assert.equal(b1?.sourceFrames, 1800, "1500 frames at 25 fps are 1800 frames at 30 fps");
});

test("the Short fixture has every standard track even when empty", () => {
  const f = fixture("short");
  const t = toTimeline(parseProject(f.html), f.facts, extras);
  assert.deepEqual(t.fps, { num: 25, den: 1 });
  assert.equal(t.width, 1080);
  assert.equal(t.height, 1920);
  assert.equal(t.duration, 300);
  assert.deepEqual(
    t.tracks.map((x) => [x.index, x.clips.length]),
    [
      [4, 0],
      [3, 1],
      [2, 0],
      [1, 1],
      [0, 3],
      [10, 1],
    ],
  );
});

test("CRLF and BOM files give the same timeline", () => {
  const f = fixture("long");
  const lf = toTimeline(parseProject(f.html), f.facts, extras);
  assert.deepEqual(toTimeline(parseProject(toCrlf(f.html)), f.facts, extras), lf);
  assert.deepEqual(toTimeline(parseProject(`\ufeff${f.html}`), f.facts, extras), lf);
});

test("a rational frame rate is passed on as numerator and denominator", () => {
  const g = generate("30000/1001", { aroll: [100, 50, 40] });
  const t = toTimeline(parseProject(g.html), g.facts, extras);
  assert.deepEqual(t.fps, { num: 30000, den: 1001 });
  assert.deepEqual(
    t.tracks.find((x) => x.index === 0)?.clips.map((c) => [c.start, c.duration]),
    [
      [0, 100],
      [100, 50],
      [150, 40],
    ],
  );
  assert.equal(t.duration, 190);
});

test("extras are passed through untouched and clips that cannot be read are left out", () => {
  const f = fixture("long");
  const note = { id: "n-1" };
  const t = toTimeline(parseProject(f.html.replace('id="a-2" class', "class")), f.facts, {
    ...extras,
    notes: /** @type {never} */ ([note]),
  });
  assert.equal(t.notes[0], /** @type {never} */ (note));
  assert.ok(!t.tracks.find((x) => x.index === 0)?.clips.some((c) => c.id === "a-2"));
  assert.equal(t.tracks.find((x) => x.index === 0)?.clips.length, 7);
});

test("a B-roll with motion shows its source, in-point and source length like a plain B-roll", () => {
  const f = fixture("motion");
  const clips = toTimeline(parseProject(f.html), f.facts, extras).tracks.flatMap((x) => x.clips);
  const row = (/** @type {string} */ id) => {
    const c = clips.find((x) => x.id === id);
    return c && [c.kind, c.start, c.duration, c.mediaStart, c.sourceFrames, c.source, c.file];
  };
  // broll.mp4 is 1500 frames at 25 fps = 1800 frames at 30 fps; b-1 starts 2 s and b-2 10 s into it.
  assert.deepEqual(row("b-1"), ["broll", 90, 90, 60, 1800, "broll.mp4", "compositions/b-1.html"]);
  assert.deepEqual(row("b-2"), ["broll", 330, 60, 300, 1800, "broll.mp4", "compositions/b-2.html"]);
  // A real graphic has no source.
  assert.deepEqual(row("fade-1"), ["fade", 435, 15, null, null, null, "compositions/fade-1.html"]);
});

test("a B-roll whose file is in another shape stays a graphic for the model", () => {
  const f = fixture("motion");
  const compositions = new Map(f.facts.compositions);
  compositions.set("b-1", "<template><div id='b-1-root'></div></template>");
  const t = toTimeline(parseProject(f.html), { ...f.facts, compositions }, extras);
  const b1 = t.tracks.flatMap((x) => x.clips).find((c) => c.id === "b-1");
  assert.deepEqual([b1?.source, b1?.mediaStart, b1?.sourceFrames], [null, null, null]);
});

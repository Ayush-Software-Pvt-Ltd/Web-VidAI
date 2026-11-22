import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProject } from "../../src/timeline/document.js";
import { applyOp } from "../../src/timeline/edits.js";
import { framesToSeconds } from "../../src/timeline/frames.js";
import { toTimeline } from "../../src/timeline/model.js";
import { checkDocument } from "../../src/timeline/profile.js";
import { fixture, generate, skeleton, toCrlf, withAttr } from "./helpers.js";

const long = fixture("long");
const EXTRAS = { revision: 1, notes: [], canUndo: false, canRedo: false, locked: null };

/** @param {string} html @param {import("../../src/timeline/profileEditJson.js").EditFacts} [facts] */
const timeline = (html, facts = long.facts) => toTimeline(parseProject(html), facts, EXTRAS);

/** The clips of a timeline as [id, track, start, duration] for comparisons. */
const flat = (/** @type {import("../../../src/lib/wire/timeline.ts").Timeline} */ t) =>
  t.tracks.flatMap((track) => track.clips.map((c) => [c.id, c.track, c.start, c.duration]));

/** Like `flat` without ids, with the in-point (used where ids differ by design). */
const shape = (/** @type {import("../../../src/lib/wire/timeline.ts").Timeline} */ t) =>
  t.tracks.flatMap((track) =>
    track.clips.map((c) => [c.track, c.start, c.duration, c.mediaStart, c.source, c.label]),
  );

/** @param {string} html @param {string} id */
const get = (html, id) => {
  const c = timeline(html)
    .tracks.flatMap((t) => t.clips)
    .find((x) => x.id === id);
  assert.ok(c, `clip ${id} is gone`);
  return c;
};

/** @param {string} html @param {string} id */
const has = (html, id) => timeline(html).tracks.some((t) => t.clips.some((c) => c.id === id));

const apply = (
  /** @type {string} */ html,
  /** @type {import("../../../src/lib/wire/timeline.ts").TimelineOp} */ op,
) => applyOp(html, op, long.facts);

/** @param {string} html @param {import("../../../src/lib/wire/timeline.ts").TimelineOp} op @param {RegExp} message */
function refused(html, op, message) {
  const copy = `${html}`;
  assert.throws(
    () => applyOp(html, op, long.facts),
    (/** @type {{ code?: string, message: string }} */ e) => {
      assert.equal(e.code, "invalidInput");
      assert.match(e.message, message);
      return true;
    },
  );
  assert.equal(html, copy, "a refusal leaves the text untouched");
}

const total = (/** @type {string} */ html) => timeline(html).duration;

// The Long fixture, in frames at 30 fps:
// A-roll a-1 0-150, a-2 150-360, a-3 360-480, a-4 480-660, a-5 660-900, a-6 900-990, a-7 990-1190, a-8 1190-1350.
// B-roll b-1 60-150, b-2 400-520 (in 105), graphic g-1 600-690, image b-3 800-860.
// Overlays ov-1 200-290, ov-2 1000-1060. Hits h-1 250-280, h-2 700-730, h-3 1200-1230. Fade 1290-1350.
// Sound s-1 95-125, s-2 405-435 (track 10), s-3 700-730 (track 11), music m-1 0-1350 (track 12).

test("delete an A-roll clip: everything after it shifts earlier, the ripple rule for the other tracks", () => {
  const { html, label } = apply(long.html, { type: "delete", clipId: "a-2" });
  assert.equal(label, "Delete A-roll");
  assert.equal(has(html, "a-2"), false);
  assert.equal(total(html), 1140);
  const aroll = timeline(html)
    .tracks.find((x) => x.index === 0)
    ?.clips.map((c) => [c.id, c.start]);
  assert.deepEqual(aroll, [
    ["a-1", 0],
    ["a-3", 150],
    ["a-4", 270],
    ["a-5", 450],
    ["a-6", 690],
    ["a-7", 780],
    ["a-8", 980],
  ]);
  assert.equal(get(html, "b-1").start, 60, "starts before the removed part: stays");
  assert.equal(
    get(html, "ov-1").start,
    150,
    "starts inside the removed part: now at the cut point",
  );
  assert.equal(get(html, "h-1").start, 150, "starts inside the removed part: now at the cut point");
  assert.equal(get(html, "b-2").start, 190, "starts after: shifts by the removed length");
  assert.equal(get(html, "g-1").start, 390);
  assert.equal(get(html, "ov-2").start, 790);
  assert.equal(get(html, "h-3").start, 990);
  assert.equal(get(html, "s-3").start, 490);
  assert.equal(get(html, "fade-1").start, 1080);
  assert.equal(
    get(html, "m-1").duration,
    1140,
    "would end after the end of the video: shortened to fit",
  );
  assert.equal(get(html, "fade-1").duration, 60);
});

test("delete the first and the last A-roll clip", () => {
  const first = apply(long.html, { type: "delete", clipId: "a-1" }).html;
  assert.deepEqual(
    timeline(first)
      .tracks.find((x) => x.index === 0)
      ?.clips.slice(0, 2)
      .map((c) => [c.id, c.start]),
    [
      ["a-2", 0],
      ["a-3", 210],
    ],
  );
  assert.equal(
    get(first, "b-1").start,
    0,
    "inside the removed part (60 in 0..150): now at the cut",
  );
  assert.equal(get(first, "s-1").start, 0);
  const last = apply(long.html, { type: "delete", clipId: "a-8" }).html;
  assert.equal(total(last), 1190);
  assert.deepEqual(
    [get(last, "fade-1").start, get(last, "fade-1").duration],
    [1130, 60],
    "the end fade keeps its length and stays at the end of the video",
  );
  assert.equal(
    has(last, "h-3"),
    false,
    "h-3 (1200-1230) starts inside the removed part and ends after the end: removed",
  );
  assert.equal(get(last, "m-1").duration, 1190);
  assert.equal(get(last, "ov-2").start, 1000);
});

test("delete the last remaining A-roll clip is refused", () => {
  const g = generate("30", { aroll: [100] });
  assert.throws(
    () => applyOp(g.html, { type: "delete", clipId: "a-1" }, g.facts),
    /last A-roll clip/,
  );
});

test("delete another clip removes only that clip", () => {
  const out = apply(long.html, { type: "delete", clipId: "b-2" });
  assert.equal(out.label, "Delete B-roll");
  assert.deepEqual(
    flat(timeline(out.html)),
    flat(timeline(long.html)).filter((c) => c[0] !== "b-2"),
  );
  assert.equal(apply(long.html, { type: "delete", clipId: "g-1" }).label, "Delete graphic");
  assert.equal(apply(long.html, { type: "delete", clipId: "s-1" }).label, "Delete sound effect");
  assert.equal(apply(long.html, { type: "delete", clipId: "m-1" }).label, "Delete music");
  assert.equal(apply(long.html, { type: "delete", clipId: "h-1" }).label, "Delete hit");
});

test("the ripple rule: a clip with less than 2 frames left is removed, with 2 it stays", () => {
  const spec = (/** @type {number} */ start) => ({
    aroll: [100, 100],
    others: [{ id: "h-a", kind: "hit", track: 3, start, dur: 5, tag: "div" }],
  });
  const g1 = generate("30", spec(99));
  const a = applyOp(g1.html, { type: "delete", clipId: "a-2" }, g1.facts).html;
  assert.equal(
    timeline(a, g1.facts).tracks.find((x) => x.index === 3)?.clips.length,
    0,
    "starts at 99 in a 100 frame video: 1 frame left",
  );
  const g2 = generate("30", spec(98));
  const b = applyOp(g2.html, { type: "delete", clipId: "a-2" }, g2.facts).html;
  const kept = timeline(b, g2.facts).tracks.find((x) => x.index === 3)?.clips[0];
  assert.deepEqual([kept?.start, kept?.duration], [98, 2], "2 frames left: kept and shortened");
  const g3 = generate("30", spec(150));
  const c = applyOp(g3.html, { type: "delete", clipId: "a-2" }, g3.facts).html;
  assert.equal(
    timeline(c, g3.facts).tracks.find((x) => x.index === 3)?.clips.length,
    0,
    "starts inside the removed part, then at the end: nothing left",
  );
});

test("the ripple rule: clips of one track that collide after a delete keep the later one", () => {
  const g = generate("30", {
    aroll: [100, 100, 100],
    others: [
      { id: "h-a", kind: "hit", track: 3, start: 120, dur: 10, tag: "div" },
      { id: "h-b", kind: "hit", track: 3, start: 150, dur: 10, tag: "div" },
    ],
  });
  const out = applyOp(g.html, { type: "delete", clipId: "a-2" }, g.facts).html;
  assert.deepEqual(
    timeline(out, g.facts)
      .tracks.find((x) => x.index === 3)
      ?.clips.map((c) => [c.id, c.start, c.duration]),
    [["h-b", 100, 10]],
  );
});

test("trim the end of an A-roll clip: shorter and longer ripple everything after", () => {
  const shorter = apply(long.html, { type: "trim", clipId: "a-2", edge: "end", frame: 300 });
  assert.equal(shorter.label, "Trim A-roll");
  assert.equal(get(shorter.html, "a-2").duration, 150);
  assert.equal(get(shorter.html, "a-2").mediaStart, 360);
  assert.equal(get(shorter.html, "a-3").start, 300);
  assert.equal(total(shorter.html), 1290);
  assert.equal(get(shorter.html, "b-2").start, 340);
  assert.equal(get(shorter.html, "ov-1").start, 200, "starts before the edit point: stays");
  assert.equal(get(shorter.html, "h-1").start, 250, "starts before the edit point: stays");
  assert.equal(get(shorter.html, "m-1").duration, 1290);
  const longer = apply(long.html, { type: "trim", clipId: "a-2", edge: "end", frame: 400 });
  assert.equal(get(longer.html, "a-2").duration, 250);
  assert.equal(get(longer.html, "a-3").start, 400);
  assert.equal(get(longer.html, "b-2").start, 440);
  assert.equal(total(longer.html), 1390);
  assert.equal(get(longer.html, "m-1").duration, 1350, "other clips are not stretched");
});

test("trim the start of an A-roll clip: the in-point follows and the clip keeps its place", () => {
  const later = apply(long.html, { type: "trim", clipId: "a-2", edge: "start", frame: 180 }).html;
  assert.deepEqual(
    [get(later, "a-2").start, get(later, "a-2").duration, get(later, "a-2").mediaStart],
    [150, 180, 390],
  );
  assert.equal(get(later, "a-3").start, 330);
  assert.equal(get(later, "ov-1").start, 170);
  const earlier = apply(long.html, { type: "trim", clipId: "a-2", edge: "start", frame: 100 }).html;
  assert.deepEqual(
    [get(earlier, "a-2").start, get(earlier, "a-2").duration, get(earlier, "a-2").mediaStart],
    [150, 260, 310],
  );
  assert.equal(get(earlier, "a-3").start, 410);
  assert.equal(get(earlier, "ov-1").start, 250);
});

test("trim of an A-roll clip is limited by the source file and by 2 frames", () => {
  refused(
    long.html,
    { type: "trim", clipId: "a-8", edge: "end", frame: 1350 + 2000 },
    /at most 2100 frames/,
  );
  assert.equal(
    get(
      apply(long.html, { type: "trim", clipId: "a-8", edge: "end", frame: 1190 + 2100 }).html,
      "a-8",
    ).duration,
    2100,
  );
  refused(
    long.html,
    { type: "trim", clipId: "a-2", edge: "end", frame: 151 },
    /shorter than 2 frames/,
  );
  assert.equal(
    get(apply(long.html, { type: "trim", clipId: "a-2", edge: "end", frame: 152 }).html, "a-2")
      .duration,
    2,
  );
  refused(
    long.html,
    { type: "trim", clipId: "a-2", edge: "start", frame: 359 },
    /shorter than 2 frames/,
  );
  refused(long.html, { type: "trim", clipId: "a-2", edge: "end", frame: 360 }, /already there/);
  refused(long.html, { type: "trim", clipId: "a-2", edge: "start", frame: 150 }, /already there/);
  const early = withAttr(long.html, "a-2", { "data-media-start": "1" });
  refused(
    early,
    { type: "trim", clipId: "a-2", edge: "start", frame: 100 },
    /only 30 frames before/,
  );
  assert.equal(
    get(apply(early, { type: "trim", clipId: "a-2", edge: "start", frame: 120 }).html, "a-2")
      .mediaStart,
    0,
  );
});

test("trim of other clips: the edge moves, limited by neighbours, source, end of video and 2 frames", () => {
  const end = apply(long.html, { type: "trim", clipId: "b-2", edge: "end", frame: 450 }).html;
  assert.deepEqual(
    [get(end, "b-2").start, get(end, "b-2").duration, get(end, "b-2").mediaStart],
    [400, 50, 105],
  );
  assert.equal(total(end), 1350);
  assert.equal(get(end, "g-1").start, 600, "nothing else moves");
  const start = apply(long.html, { type: "trim", clipId: "b-2", edge: "start", frame: 420 }).html;
  assert.deepEqual(
    [get(start, "b-2").start, get(start, "b-2").duration, get(start, "b-2").mediaStart],
    [420, 100, 125],
  );
  const extend = apply(long.html, { type: "trim", clipId: "b-2", edge: "start", frame: 300 }).html;
  assert.deepEqual(
    [get(extend, "b-2").start, get(extend, "b-2").duration, get(extend, "b-2").mediaStart],
    [300, 220, 5],
  );
  assert.equal(
    apply(long.html, { type: "trim", clipId: "b-2", edge: "end", frame: 450 }).label,
    "Trim B-roll",
  );
  refused(
    long.html,
    { type: "trim", clipId: "b-2", edge: "start", frame: 280 },
    /only 105 frames before/,
  );
  refused(
    long.html,
    { type: "trim", clipId: "g-1", edge: "start", frame: 500 },
    /cannot start before frame 520, where the previous clip on its track ends/,
  );
  refused(
    long.html,
    { type: "trim", clipId: "b-2", edge: "end", frame: 650 },
    /cannot end after frame 600, where the next clip on its track starts/,
  );
  refused(
    long.html,
    { type: "trim", clipId: "b-3", edge: "end", frame: 1400 },
    /after the end of the video \(frame 1350\)/,
  );
  refused(
    long.html,
    { type: "trim", clipId: "s-1", edge: "end", frame: 95 + 95 },
    /at most 90 frames/,
  );
  refused(
    long.html,
    { type: "trim", clipId: "b-2", edge: "end", frame: 401 },
    /shorter than 2 frames/,
  );
  refused(long.html, { type: "trim", clipId: "b-2", edge: "end", frame: 520 }, /already there/);
  const image = apply(long.html, { type: "trim", clipId: "b-3", edge: "end", frame: 1000 }).html;
  assert.equal(get(image, "b-3").duration, 200, "pictures have no source length");
  assert.equal(get(image, "b-3").mediaStart, null);
  const host = apply(long.html, { type: "trim", clipId: "g-1", edge: "end", frame: 640 }).html;
  assert.equal(get(host, "g-1").duration, 40);
});

test("split an A-roll clip: two clips, the second continuing in the source", () => {
  const { html, label } = apply(long.html, { type: "split", clipId: "a-2", frame: 250 });
  assert.equal(label, "Split A-roll");
  const a = get(html, "a-2");
  const b = get(html, "a-2-2");
  assert.deepEqual([a.start, a.duration, a.mediaStart], [150, 100, 360]);
  assert.deepEqual([b.start, b.duration, b.mediaStart], [250, 110, 460]);
  assert.equal(b.label, a.label);
  assert.equal(total(html), 1350);
  assert.equal(get(html, "a-3").start, 360);
  assert.equal(get(html, "ov-1").start, 200);
  assert.ok(
    html.indexOf('id="a-2-2"') > html.indexOf('id="a-2"') &&
      html.indexOf('id="a-2-2"') < html.indexOf('id="a-3"'),
  );
  const again = apply(html, { type: "split", clipId: "a-2", frame: 200 }).html;
  assert.ok(has(again, "a-2-3"), "ids stay unique");
});

test("split other clips; a graphic cannot be split", () => {
  const out = apply(long.html, { type: "split", clipId: "b-2", frame: 450 });
  assert.equal(out.label, "Split B-roll");
  assert.deepEqual(
    [get(out.html, "b-2").start, get(out.html, "b-2").duration, get(out.html, "b-2").mediaStart],
    [400, 50, 105],
  );
  assert.deepEqual(
    [
      get(out.html, "b-2-2").start,
      get(out.html, "b-2-2").duration,
      get(out.html, "b-2-2").mediaStart,
    ],
    [450, 70, 155],
  );
  const sound = apply(long.html, { type: "split", clipId: "m-1", frame: 600 });
  assert.equal(sound.label, "Split music");
  assert.equal(get(sound.html, "m-1-2").mediaStart, 600);
  const picture = apply(long.html, { type: "split", clipId: "b-3", frame: 830 }).html;
  assert.deepEqual([get(picture, "b-3-2").start, get(picture, "b-3-2").duration], [830, 30]);
  refused(long.html, { type: "split", clipId: "g-1", frame: 640 }, /graphic cannot be split/);
  refused(long.html, { type: "split", clipId: "h-1", frame: 260 }, /graphic cannot be split/);
  refused(long.html, { type: "split", clipId: "a-2", frame: 150 }, /inside it/);
  refused(long.html, { type: "split", clipId: "a-2", frame: 360 }, /inside it/);
  refused(long.html, { type: "split", clipId: "a-2", frame: 151 }, /at least 2 frames/);
  refused(long.html, { type: "split", clipId: "a-2", frame: 359 }, /at least 2 frames/);
  assert.ok(has(apply(long.html, { type: "split", clipId: "a-2", frame: 152 }).html, "a-2-2"));
});

test("split then delete gives an equivalent timeline", () => {
  const split = apply(long.html, { type: "split", clipId: "a-2", frame: 250 }).html;
  const dropSecond = apply(split, { type: "delete", clipId: "a-2-2" }).html;
  const trimmed = apply(long.html, { type: "trim", clipId: "a-2", edge: "end", frame: 250 }).html;
  assert.deepEqual(flat(timeline(dropSecond)), flat(timeline(trimmed)));
  const dropFirst = apply(split, { type: "delete", clipId: "a-2" }).html;
  const trimmedStart = apply(long.html, {
    type: "trim",
    clipId: "a-2",
    edge: "start",
    frame: 250,
  }).html;
  assert.deepEqual(shape(timeline(dropFirst)), shape(timeline(trimmedStart)));
  const splitOther = apply(long.html, { type: "split", clipId: "b-2", frame: 450 }).html;
  const dropped = apply(splitOther, { type: "delete", clipId: "b-2-2" }).html;
  const trimmedOther = apply(long.html, {
    type: "trim",
    clipId: "b-2",
    edge: "end",
    frame: 450,
  }).html;
  assert.deepEqual(flat(timeline(dropped)), flat(timeline(trimmedOther)));
});

test("move an A-roll clip to another cut: the A-roll is reordered, clips that start inside it go with it", () => {
  const { html, label } = apply(long.html, { type: "move", clipId: "a-2", frame: 660 });
  assert.equal(label, "Move A-roll");
  assert.deepEqual(
    timeline(html)
      .tracks.find((x) => x.index === 0)
      ?.clips.map((c) => [c.id, c.start]),
    [
      ["a-1", 0],
      ["a-3", 150],
      ["a-4", 270],
      ["a-2", 450],
      ["a-5", 660],
      ["a-6", 900],
      ["a-7", 990],
      ["a-8", 1190],
    ],
  );
  assert.equal(total(html), 1350);
  assert.equal(get(html, "ov-1").start, 500, "ov-1 started inside a-2 and moves with it");
  assert.equal(get(html, "h-1").start, 550);
  assert.equal(get(html, "b-2").start, 190, "b-2 stays over the A-roll clip it was over");
  assert.equal(get(html, "b-3").start, 800, "after both: unchanged");
  assert.equal(get(html, "m-1").duration, 1350);
});

test("move an A-roll clip to the start, to the end, and refusals", () => {
  const front = apply(long.html, { type: "move", clipId: "a-3", frame: 0 }).html;
  assert.deepEqual(
    timeline(front)
      .tracks.find((x) => x.index === 0)
      ?.clips.slice(0, 3)
      .map((c) => [c.id, c.start]),
    [
      ["a-3", 0],
      ["a-1", 120],
      ["a-2", 270],
    ],
  );
  const back = apply(long.html, { type: "move", clipId: "a-2", frame: 1350 }).html;
  assert.deepEqual(
    timeline(back)
      .tracks.find((x) => x.index === 0)
      ?.clips.slice(-2)
      .map((c) => [c.id, c.start]),
    [
      ["a-8", 980],
      ["a-2", 1140],
    ],
  );
  assert.equal(total(back), 1350);
  const adjacent = apply(long.html, { type: "move", clipId: "a-2", frame: 480 }).html;
  assert.deepEqual(
    timeline(adjacent)
      .tracks.find((x) => x.index === 0)
      ?.clips.slice(1, 4)
      .map((c) => c.id),
    ["a-3", "a-2", "a-4"],
  );
  refused(long.html, { type: "move", clipId: "a-2", frame: 200 }, /only be moved to a cut/);
  refused(long.html, { type: "move", clipId: "a-2", frame: 150 }, /already at that cut/);
  refused(long.html, { type: "move", clipId: "a-2", frame: 360 }, /already at that cut/);
});

test("move another clip in time, limited by neighbours and the ends of the video", () => {
  const out = apply(long.html, { type: "move", clipId: "b-2", frame: 300 });
  assert.equal(out.label, "Move B-roll");
  assert.deepEqual(
    [get(out.html, "b-2").start, get(out.html, "b-2").duration, get(out.html, "b-2").mediaStart],
    [300, 120, 105],
  );
  assert.equal(
    get(apply(long.html, { type: "move", clipId: "ov-1", frame: 0 }).html, "ov-1").start,
    0,
  );
  assert.equal(
    get(apply(long.html, { type: "move", clipId: "b-2", frame: 480 }).html, "b-2").start,
    480,
  );
  assert.equal(
    get(apply(long.html, { type: "move", clipId: "fade-1", frame: 1289 }).html, "fade-1").start,
    1289,
  );
});

test("move of other clips: refusals", () => {
  refused(
    long.html,
    { type: "move", clipId: "b-2", frame: 100 },
    /cannot start before frame 150, where the previous clip on its track ends/,
  );
  refused(
    long.html,
    { type: "move", clipId: "b-2", frame: 500 },
    /cannot end after frame 600.*start at frame 480 at the latest/,
  );
  refused(
    long.html,
    { type: "move", clipId: "b-3", frame: 1300 },
    /after the end of the video \(frame 1350\).*start at frame 1290 at the latest/,
  );
  refused(long.html, { type: "move", clipId: "b-2", frame: 400 }, /already there/);
  refused(long.html, { type: "move", clipId: "m-1", frame: 1 }, /after the end of the video/);
});

test("operations on a project with a rational frame rate", () => {
  const g = generate("30000/1001", {
    aroll: [100, 200, 150, 90],
    others: [{ id: "b-1", kind: "broll", track: 1, start: 50, dur: 80 }],
  });
  const ops = [
    { type: "trim", clipId: "a-2", edge: "end", frame: 250 },
    { type: "trim", clipId: "a-2", edge: "start", frame: 130 },
    { type: "split", clipId: "a-3", frame: 311 },
    { type: "move", clipId: "a-4", frame: 100 },
    { type: "delete", clipId: "a-1" },
    { type: "trim", clipId: "b-1", edge: "start", frame: 77 },
  ];
  let html = g.html;
  for (const op of ops) {
    html = applyOp(html, /** @type {never} */ (op), g.facts).html;
    assert.deepEqual(checkDocument(parseProject(html), g.facts), []);
  }
  const root = parseProject(html).root;
  assert.equal(root?.duration, timeline(html, g.facts).duration);
  // every written value is within 1e-9 s of its frame
  for (const c of parseProject(html).clips) {
    for (const [name, frames] of [
      ["data-start", c.start],
      ["data-duration", c.duration],
    ]) {
      const text = c.element.attrs.find((a) => a.name === name)?.value ?? "";
      assert.ok(/^\d+(\.\d{1,9})?$/.test(text), `${c.id} ${name}=${text}`);
      assert.ok(
        Math.abs(Number(text) - framesToSeconds(/** @type {number} */ (frames), g.facts.fps)) <=
          1e-9,
      );
    }
  }
});

test("only the attributes an edit touches change, byte for byte, on LF, CRLF and BOM files", () => {
  const ops = [
    { type: "trim", clipId: "a-2", edge: "end", frame: 300 },
    { type: "trim", clipId: "a-4", edge: "start", frame: 500 },
    { type: "trim", clipId: "b-3", edge: "end", frame: 830 },
    { type: "delete", clipId: "a-3" },
    { type: "delete", clipId: "b-3" },
    { type: "delete", clipId: "fade-1" },
    { type: "split", clipId: "a-4", frame: 600 },
    { type: "split", clipId: "b-1", frame: 100 },
    { type: "move", clipId: "a-2", frame: 660 },
    { type: "move", clipId: "ov-1", frame: 420 },
  ];
  const variants = [
    ["lf", (/** @type {string} */ h) => h],
    ["crlf", toCrlf],
    ["bom", (/** @type {string} */ h) => `\ufeff${h}`],
  ];
  for (const [name, convert] of variants) {
    const input = /** @type {(h: string) => string} */ (convert)(long.html);
    for (const op of ops) {
      const out = applyOp(input, /** @type {never} */ (op), long.facts).html;
      const before = parseProject(input);
      const after = parseProject(out);
      const gone = new Set(
        before.clips.map((c) => c.id).filter((id) => !after.clips.some((c) => c.id === id)),
      );
      const added = new Set(
        after.clips.map((c) => c.id).filter((id) => !before.clips.some((c) => c.id === id)),
      );
      const volatile = new Set([...gone, ...added].filter((id) => id !== null));
      assert.equal(
        skeleton(out, /** @type {Set<string>} */ (volatile)),
        skeleton(input, /** @type {Set<string>} */ (volatile)),
        `${name} ${JSON.stringify(op)}`,
      );
      assert.equal(out.startsWith("\ufeff"), name === "bom");
      if (name === "crlf") assert.ok(!/(?<!\r)\n/.test(out), "no bare line feed");
      if (name === "lf") assert.ok(!out.includes("\r"));
    }
  }
});

test("an edit that touches nothing else keeps the exact text around it", () => {
  const out = apply(long.html, { type: "trim", clipId: "b-2", edge: "end", frame: 450 }).html;
  const expected = long.html
    .split("\n")
    .map((line) =>
      line.includes("id='b-2'") || line.includes('id="b-2"')
        ? line.replace(/data-duration=(["'])4\1/, 'data-duration="1.666666667"')
        : line,
    )
    .join("\n");
  assert.notEqual(expected, long.html);
  assert.equal(out, expected);
  const comment = long.html.match(/<!--[\s\S]*?-->/)?.[0];
  assert.ok(comment && out.includes(comment));
  assert.ok(
    out.includes("data-start='2'") && out.includes("data-track-index=1"),
    "quote styles survive",
  );
});

test("bad operations are refused with a sentence", () => {
  refused(long.html, /** @type {never} */ (null), /edit is missing/);
  refused(long.html, /** @type {never} */ ({ type: "delete" }), /which clip/);
  refused(long.html, /** @type {never} */ ({ type: "explode", clipId: "a-1" }), /not known/);
  refused(
    long.html,
    /** @type {never} */ ({ type: "trim", clipId: "a-1", edge: "middle", frame: 3 }),
    /which edge/,
  );
  refused(
    long.html,
    /** @type {never} */ ({ type: "trim", clipId: "a-1", edge: "end", frame: 3.5 }),
    /whole number of frames/,
  );
  refused(
    long.html,
    /** @type {never} */ ({ type: "split", clipId: "a-1", frame: -1 }),
    /whole number of frames/,
  );
  refused(
    long.html,
    /** @type {never} */ ({ type: "move", clipId: "a-1", frame: "3" }),
    /whole number of frames/,
  );
  refused(long.html, { type: "delete", clipId: "nope" }, /no clip "nope"/);
});

test("a project that already breaks the rules cannot be edited by hand", () => {
  const broken = long.html.replace(
    'data-vidai-kind="aroll" data-vidai-label="Problem"',
    'data-vidai-kind="wat" data-vidai-label="Problem"',
  );
  refused(broken, { type: "delete", clipId: "b-2" }, /does not follow VidAI's rules yet/);
});

test("a clip with a playback rate other than 1 cannot be trimmed or split", () => {
  const html = long.html.replace(
    'id="b-2" class="clip"',
    'id="b-2" data-playback-rate="2" class="clip"',
  );
  refused(html, { type: "trim", clipId: "b-2", edge: "end", frame: 450 }, /different speed/);
  refused(html, { type: "split", clipId: "b-2", frame: 450 }, /different speed/);
  assert.ok(!has(apply(html, { type: "delete", clipId: "b-2" }).html, "b-2"));
});

test("trimming a source at another rate keeps the in-point on whole project frames", () => {
  const out = apply(long.html, { type: "trim", clipId: "b-1", edge: "start", frame: 70 }).html;
  assert.deepEqual(
    [get(out, "b-1").start, get(out, "b-1").duration, get(out, "b-1").mediaStart],
    [70, 80, 10],
  );
});

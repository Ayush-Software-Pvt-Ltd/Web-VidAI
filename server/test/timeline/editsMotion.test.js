// Hand edits of a B-roll with motion (docs/SPEC.md section 11) and the fades of the A-roll's sound
// (section 10): the `motion` fixture, 30 fps, 15 s. A-roll a-1 0-150, a-2 150-300, a-3 300-450 (frames),
// B-roll b-1 90-180 (push, in-point 60), b-2 330-390 (drift, in-point 300), fade-1 435-450.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProject } from "../../src/timeline/document.js";
import { applyOp } from "../../src/timeline/edits.js";
import { readMotion } from "../../src/timeline/editMotion.js";
import { toTimeline } from "../../src/timeline/model.js";
import { checkDocument } from "../../src/timeline/profile.js";
import { fixture } from "./helpers.js";

const motion = fixture("motion");
const long = fixture("long");
const EXTRAS = { revision: 1, notes: [], canUndo: false, canRedo: false, locked: null };

/** @typedef {import("../../../src/lib/wire/timeline.ts").TimelineOp} Op */
/** @typedef {import("../../src/timeline/profileEditJson.js").EditFacts} Facts */

/** @param {string} html @param {Facts} facts */
const timeline = (html, facts) => toTimeline(parseProject(html), facts, EXTRAS);

/** @param {string} html @param {Facts} facts @param {string} id */
function clip(html, facts, id) {
  const found = timeline(html, facts)
    .tracks.flatMap((t) => t.clips)
    .find((c) => c.id === id);
  assert.ok(found, `clip ${id} is gone`);
  return found;
}

/**
 * Applies an op to the motion fixture (or to `from`), checks the result against the profile as the
 * service does, and returns it.
 * @param {Op} op
 * @param {{ html: string, facts: Facts }} [from]
 */
function run(op, from = motion) {
  const result = applyOp(from.html, op, from.facts);
  assert.deepEqual(
    checkDocument(parseProject(result.html), result.facts),
    [],
    "profile violations",
  );
  return result;
}

/** @param {{ files: { path: string, text: string, before: string | null }[] }} result @param {string} id */
function file(result, id) {
  const found = result.files.find((f) => f.path === `compositions/${id}.html`);
  assert.ok(found, `compositions/${id}.html was not written`);
  return found;
}

/** @param {string} text @param {string} id */
function read(text, id) {
  const m = readMotion(text, id);
  assert.ok(m, `${id} is not a motion file`);
  return m;
}

/** The source frame a B-roll host shows at timeline frame `f`. */
const sourceAt = (/** @type {any} */ c, /** @type {number} */ f) => c.mediaStart + (f - c.start);

/** The fade attributes of an A-roll clip as [in, out] (null for none). */
function fades(/** @type {string} */ html, /** @type {string} */ id) {
  const tag = html.match(new RegExp(`<video id="${id}"[^>]*>`))?.[0] ?? "";
  return [
    tag.match(/data-fade-in="([^"]*)"/)?.[1] ?? null,
    tag.match(/data-fade-out="([^"]*)"/)?.[1] ?? null,
  ];
}

/**
 * The fixture with one composition file changed.
 * @param {string} id
 * @param {(text: string) => string} change
 * @returns {{ html: string, facts: Facts }}
 */
function withFile(id, change) {
  const compositions = new Map(motion.facts.compositions);
  compositions.set(id, change(compositions.get(id) ?? ""));
  return { html: motion.html, facts: { ...motion.facts, compositions } };
}

/** The fixture whose b-2 file reads `media-start` 57 s and `data-duration` 3 s (90 frames of room). */
const nearTheEnd = () =>
  withFile("b-2", (text) =>
    text
      .replace('data-media-start="10"', 'data-media-start="57"')
      .replace('data-duration="50"', 'data-duration="3"'),
  );

// ---- the motion host in the model --------------------------------------------------------------

test("a motion B-roll is a plain B-roll for the model: source, in-point and source length", () => {
  const t = timeline(motion.html, motion.facts);
  const b1 = clip(motion.html, motion.facts, "b-1");
  assert.deepEqual(
    [b1.kind, b1.track, b1.start, b1.duration, b1.mediaStart, b1.source, b1.sourceFrames],
    ["broll", 1, 90, 90, 60, "broll.mp4", 1800],
  );
  assert.equal(t.duration, 450);
  assert.equal(clip(motion.html, motion.facts, "b-2").mediaStart, 300);
});

// ---- trim --------------------------------------------------------------------------------------

test("trim of the head moves the in-point and every remaining frame shows the same source frame", () => {
  const before = clip(motion.html, motion.facts, "b-1");
  const r = run({ type: "trim", clipId: "b-1", edge: "start", frame: 120 });
  const after = clip(r.html, r.facts, "b-1");
  assert.deepEqual([after.start, after.duration, after.mediaStart], [120, 60, 90]);
  for (let f = 120; f < 180; f++)
    assert.equal(sourceAt(after, f), sourceAt(before, f), `frame ${f}`);
  const m = read(file(r, "b-1").text, "b-1");
  assert.equal(m.mediaStartText, "3");
  assert.equal(m.movementSeconds, 2, "the movement runs over the new length");
  assert.deepEqual(m.spec, { scale: [1, 1.1], x: [0, 0] });
  assert.deepEqual(
    r.files.map((f) => f.path),
    ["compositions/b-1.html"],
  );
});

test("trim of the head is limited by the start of the source file", () => {
  const r = run({ type: "trim", clipId: "b-1", edge: "start", frame: 30 });
  assert.equal(clip(r.html, r.facts, "b-1").mediaStart, 0);
  assert.equal(read(file(r, "b-1").text, "b-1").mediaStartText, "0");
  assert.throws(
    () =>
      applyOp(motion.html, { type: "trim", clipId: "b-1", edge: "start", frame: 29 }, motion.facts),
    /cannot start earlier: its source file begins only 60 frames before/,
  );
});

test("trim of the end shorter keeps the in-point and runs the movement over the new length", () => {
  const r = run({ type: "trim", clipId: "b-1", edge: "end", frame: 150 });
  const c = clip(r.html, r.facts, "b-1");
  assert.deepEqual([c.start, c.duration, c.mediaStart], [90, 60, 60]);
  const m = read(file(r, "b-1").text, "b-1");
  assert.equal(m.mediaStartText, "2");
  assert.equal(m.movementSeconds, 2);
  assert.equal(m.durationText, "58", "the inner video still lasts as long as the file allows");
});

test("trim of the end longer goes past the written inner video, up to the source file", () => {
  const r = run({ type: "trim", clipId: "b-1", edge: "end", frame: 300 });
  assert.equal(clip(r.html, r.facts, "b-1").duration, 210);
  assert.equal(read(file(r, "b-1").text, "b-1").movementSeconds, 7);
  // Its source file only has 90 frames from the in-point: 420 is the last frame that works.
  const near = nearTheEnd();
  const ok = run({ type: "trim", clipId: "b-2", edge: "end", frame: 420 }, near);
  assert.equal(clip(ok.html, ok.facts, "b-2").duration, 90);
  assert.throws(
    () => applyOp(near.html, { type: "trim", clipId: "b-2", edge: "end", frame: 421 }, near.facts),
    /cannot be made longer: its source file only has 90 frames from where the clip starts/,
  );
});

test("a host made longer lengthens an inner video that was written short", () => {
  const short = withFile("b-2", (text) => text.replace('data-duration="50"', 'data-duration="2"'));
  const r = run({ type: "trim", clipId: "b-2", edge: "end", frame: 450 }, short);
  const m = read(file(r, "b-2").text, "b-2");
  assert.equal(m.durationText, "50", "as long as the file allows");
  assert.equal(m.movementSeconds, 4);
});

// ---- move and delete ---------------------------------------------------------------------------

test("move changes only index.html; the in-point and the movement stay", () => {
  const r = run({ type: "move", clipId: "b-1", frame: 200 });
  assert.deepEqual(r.files, []);
  const c = clip(r.html, r.facts, "b-1");
  assert.deepEqual([c.start, c.duration, c.mediaStart], [200, 90, 60]);
});

test("delete removes the host and writes no file (the composition file stays)", () => {
  const r = run({ type: "delete", clipId: "b-1" });
  assert.deepEqual(r.files, []);
  assert.equal(
    timeline(r.html, r.facts)
      .tracks.flatMap((t) => t.clips)
      .some((c) => c.id === "b-1"),
    false,
  );
  assert.match(r.html, /id="b-2"/);
});

// ---- split -------------------------------------------------------------------------------------

test("split gives each part its exact piece of the movement and its own file", () => {
  const before = clip(motion.html, motion.facts, "b-1");
  const r = run({ type: "split", clipId: "b-1", frame: 120 });
  const first = clip(r.html, r.facts, "b-1");
  const second = clip(r.html, r.facts, "b-1-2");
  assert.deepEqual([first.start, first.duration, second.start, second.duration], [90, 30, 120, 60]);
  for (let f = 90; f < 180; f++) {
    assert.equal(sourceAt(f < 120 ? first : second, f), sourceAt(before, f), `frame ${f}`);
  }
  const a = read(file(r, "b-1").text, "b-1");
  const b = read(file(r, "b-1-2").text, "b-1-2");
  assert.deepEqual([a.movementSeconds, b.movementSeconds], [1, 2]);
  assert.deepEqual(a.spec.scale, [1, 1.033333]);
  assert.deepEqual(b.spec.scale, [1.033333, 1.1]);
  assert.equal(a.spec.scale[1], b.spec.scale[0], "the pieces meet at the cut");
  assert.deepEqual([a.mediaStartText, b.mediaStartText], ["2", "3"]);
  // The new file has its own ids, so the two never clash, and the same relative source.
  assert.equal(b.src, "assets/media/broll.mp4");
  const text = file(r, "b-1-2").text;
  assert.doesNotMatch(text, /id="b-1-(root|motion|video)"/);
  assert.match(text, /id="b-1-2-(root|motion|video)"/);
  assert.match(text, /data-composition-id="b-1-2"/);
  assert.match(text, /__timelines\["b-1-2"\]/);
  assert.match(r.html, /id="b-1-2"[^>]*data-composition-src="compositions\/b-1-2\.html"/);
  assert.equal(file(r, "b-1-2").before, null, "a new file");
  assert.equal(file(r, "b-1").before, motion.facts.compositions?.get("b-1") ?? null);
});

test("split of a drift moves each part along its half", () => {
  const r = run({ type: "split", clipId: "b-2", frame: 360 });
  const a = read(file(r, "b-2").text, "b-2");
  const b = read(file(r, "b-2-2").text, "b-2-2");
  assert.deepEqual(a.spec.x, [76.8, 0]);
  assert.deepEqual(b.spec.x, [0, -76.8]);
  assert.deepEqual(
    [a.spec.scale, b.spec.scale],
    [
      [1.08, 1.08],
      [1.08, 1.08],
    ],
  );
  assert.deepEqual([a.mediaStartText, b.mediaStartText], ["10", "11"]);
});

test("a split can be trimmed, split and moved again with the facts the first one returned", () => {
  const one = run({ type: "split", clipId: "b-1", frame: 120 });
  const two = run({ type: "trim", clipId: "b-1-2", edge: "start", frame: 150 }, one);
  const c = clip(two.html, two.facts, "b-1-2");
  assert.deepEqual([c.start, c.duration, c.mediaStart], [150, 30, 120]);
  assert.equal(read(file(two, "b-1-2").text, "b-1-2").mediaStartText, "4");
  const three = run({ type: "split", clipId: "b-1-2", frame: 165 }, two);
  assert.ok(three.files.some((f) => f.path === "compositions/b-1-2-2.html"));
  assert.match(three.html, /id="b-1-2-2"/);
});

test("a graphic and a B-roll file in another shape are edited like a graphic and cannot be split", () => {
  assert.throws(
    () => applyOp(motion.html, { type: "split", clipId: "fade-1", frame: 440 }, motion.facts),
    /A motion graphic cannot be split/,
  );
  const old = withFile(
    "b-1",
    () =>
      `<template><div id="b-1-root" data-composition-id="b-1"><video id="b-1-video" src="assets/media/broll.mp4" data-start="0" data-duration="3" data-media-start="2" muted></video></div></template>`,
  ).facts;
  assert.throws(
    () => applyOp(motion.html, { type: "split", clipId: "b-1", frame: 120 }, old),
    /A motion graphic cannot be split/,
  );
  // Trim and move still work, without a rewrite of the file.
  const r = applyOp(motion.html, { type: "trim", clipId: "b-1", edge: "end", frame: 150 }, old);
  assert.deepEqual(r.files, []);
});

// ---- fades under A-roll edits ------------------------------------------------------------------

test("the fixture's fades are what the rule says (an edit that changes nothing writes no fade)", () => {
  const r = run({ type: "move", clipId: "b-1", frame: 200 });
  for (const id of ["a-1", "a-2", "a-3"])
    assert.deepEqual(fades(r.html, id), fades(motion.html, id), id);
});

test("trim of the last A-roll clip shorter or longer: the end fade stays at the end", () => {
  const shorter = run({ type: "trim", clipId: "a-3", edge: "end", frame: 420 });
  assert.deepEqual(fades(shorter.html, "a-3"), [null, "0.5"]);
  const fade = clip(shorter.html, shorter.facts, "fade-1");
  assert.deepEqual(
    [fade.start, fade.duration, timeline(shorter.html, shorter.facts).duration],
    [405, 15, 420],
  );
  const longer = run({ type: "trim", clipId: "a-3", edge: "end", frame: 480 });
  assert.deepEqual(fades(longer.html, "a-3"), [null, "0.5"]);
  const fade2 = clip(longer.html, longer.facts, "fade-1");
  assert.deepEqual([fade2.start, fade2.duration], [465, 15]);
});

test("an end clip shorter than the fade: the sound fades over the clip's length", () => {
  const r = run({ type: "trim", clipId: "a-3", edge: "end", frame: 306 });
  assert.deepEqual(fades(r.html, "a-3"), [null, "0.2"]);
  assert.deepEqual(
    [clip(r.html, r.facts, "fade-1").start, clip(r.html, r.facts, "fade-1").duration],
    [291, 15],
  );
});

test("delete of the last A-roll clip: the previous clip carries the end fade, the picture stays at the end", () => {
  const r = run({ type: "delete", clipId: "a-3" });
  assert.deepEqual(fades(r.html, "a-2"), ["0.008", "0.5"]);
  const fade = clip(r.html, r.facts, "fade-1");
  assert.deepEqual([fade.start, fade.duration, timeline(r.html, r.facts).duration], [285, 15, 300]);
});

test("delete of the end fade picture removes the sound fade too", () => {
  const r = run({ type: "delete", clipId: "fade-1" });
  assert.deepEqual(fades(r.html, "a-3"), [null, "0.008"]);
});

test("split inside one source: no de-click mid-clip, nothing at a cut that continues the source", () => {
  const r = run({ type: "split", clipId: "a-2", frame: 225 });
  assert.deepEqual(fades(r.html, "a-2"), ["0.008", null]);
  assert.deepEqual(fades(r.html, "a-2-2"), [null, null]);
  assert.deepEqual(fades(r.html, "a-3"), [null, "0.5"]);
});

test("split of the first clip: the part that now meets a different source gets the de-click", () => {
  const r = run({ type: "split", clipId: "a-1", frame: 60 });
  assert.deepEqual(fades(r.html, "a-1"), ["0.008", null]);
  assert.deepEqual(fades(r.html, "a-1-2"), [null, "0.008"]);
  assert.deepEqual(fades(r.html, "a-2"), ["0.008", null]);
});

test("a trim that breaks a continued source puts a de-click on both sides of the new cut", () => {
  const r = run({ type: "trim", clipId: "a-2", edge: "end", frame: 270 });
  assert.deepEqual(fades(r.html, "a-2"), ["0.008", "0.008"]);
  assert.deepEqual(fades(r.html, "a-3"), ["0.008", "0.5"]);
});

test("moving an A-roll clip rewrites the fades for the new order", () => {
  const r = run({ type: "move", clipId: "a-1", frame: 300 });
  // order now: a-2, a-1, a-3
  assert.deepEqual(fades(r.html, "a-2"), ["0.008", "0.008"]);
  assert.deepEqual(fades(r.html, "a-1"), ["0.008", "0.008"]);
  assert.deepEqual(fades(r.html, "a-3"), ["0.008", "0.5"]);
});

test("delete of a middle clip joins its neighbours with a de-click", () => {
  const r = run({ type: "delete", clipId: "a-2" });
  assert.deepEqual(fades(r.html, "a-1"), ["0.008", "0.008"]);
  assert.deepEqual(fades(r.html, "a-3"), ["0.008", "0.5"]);
});

test("a toolkit 1.2 volume lane of fades is replaced by the fade attributes on the next edit", () => {
  const lane = JSON.stringify({
    lanes: [
      {
        target: "volume",
        points: [
          { t: 0, v: 0 },
          { t: 0.008, v: 1 },
          { t: 4.992, v: 1 },
          { t: 5, v: 0 },
        ],
      },
    ],
  });
  const html = motion.html.replace(
    / data-fade-in="0.008" data-fade-out="0.008"( style="z-index:0"><\/video>\n\s*<video id="a-2")/,
    ` data-automation='${lane}'$1`,
  );
  assert.match(html, /data-automation=/);
  const r = run({ type: "move", clipId: "b-1", frame: 200 }, { html, facts: motion.facts });
  assert.doesNotMatch(r.html, /data-automation/);
  assert.deepEqual(fades(r.html, "a-1"), ["0.008", "0.008"]);
});

test("a project that carries no fade is left alone: the fades are never added", () => {
  for (const op of /** @type {Op[]} */ ([
    { type: "trim", clipId: "a-3", edge: "end", frame: 800 },
    { type: "split", clipId: "a-2", frame: 220 },
    { type: "delete", clipId: "a-1" },
  ])) {
    const r = applyOp(long.html, op, long.facts);
    assert.doesNotMatch(r.html, /data-fade-|data-automation/, JSON.stringify(op));
  }
});

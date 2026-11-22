// Hand edits of a host whose file holds timed inner media (docs/SPEC.md sections 10 and 11): the synced
// B-roll layout the toolkit writes (`layout_composition` in `hfproject.py`): a background picture, a
// muted screen recording and a muted round host video inside `#<id>-pip`, optionally zoomed by
// `#<id>-zoom` (`data-vidai-layout-motion`). The `motion` fixture plus one such host, b-3, 30 fps:
// A-roll a-2 is frames 150-300 (source from 3 s), b-3 is frames 210-300 (7 s to 10 s), its screen starts
// 2 s into broll.mp4 and its host circle 5 s into aroll.mp4 (the A-roll's own source time at frame 210).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseProject } from "../../src/timeline/document.js";
import { applyOp } from "../../src/timeline/edits.js";
import { arollSources, innerOfHost } from "../../src/timeline/editInner.js";
import { piecesMatch, syncPieces } from "../../src/timeline/editSync.js";
import { checkDocument, loadProject } from "../../src/timeline/profile.js";
import { fixture } from "./helpers.js";

const motion = fixture("motion");

/** @typedef {import("../../../src/lib/wire/timeline.ts").TimelineOp} Op */
/** @typedef {import("../../src/timeline/profileEditJson.js").EditFacts} Facts */

const HOST_LINE =
  '      <div id="b-3" class="clip" data-composition-id="b-3" data-composition-src="compositions/b-3.html" data-start="7" data-duration="3" data-track-index="1" data-vidai-kind="broll" data-vidai-label="Phone" data-width="1920" data-height="1080" style="z-index:1"></div>\n';

/**
 * The composition file as the toolkit writes it (`layout_composition`).
 * @param {{ screenStart?: number, hostStart?: number, zoom?: boolean, extra?: string }} [o]
 */
function layoutFile({ screenStart = 2, hostStart = 5, zoom = true, extra = "" } = {}) {
  const attr = zoom ? ` data-vidai-layout-motion='{"scale":[1,1.2],"x":[0,0],"duration":3}'` : "";
  const tween = zoom
    ? `const m = JSON.parse(document.getElementById("b-3-zoom").getAttribute("data-vidai-layout-motion"));
tl.fromTo("#b-3-zoom", { scale: m.scale[0], x: m.x[0] }, { scale: m.scale[1], x: m.x[1], duration: m.duration, ease: "none" }, 0);
`
    : "";
  return `<!doctype html>
<html lang="en">
<head><meta charset="UTF-8" /></head>
<body>
<template>
<style>
#b-3-root { position: absolute; inset: 0; overflow: hidden; background: #000; }
#b-3-zoom { position: absolute; inset: 0; transform-origin: 50% 50%; }
#b-3-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; z-index: 0; }
#b-3-screen { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: 1; }
#b-3-pip { position: absolute; overflow: hidden; border-radius: 50%; z-index: 2; }
#b-3-host { position: absolute; }
</style>
<div id="b-3-root" data-composition-id="b-3" data-width="1920" data-height="1080">
  <div id="b-3-zoom"${attr}>
    <img id="b-3-bg" src="assets/layout/bg.png" alt="" />
    <video id="b-3-screen" class="clip" src="assets/media/broll.mp4" muted playsinline data-start="0" data-duration="58" data-media-start="${screenStart}" data-track-index="1"></video>
    <div id="b-3-pip" style="left:1300px;top:600px;width:400px;height:400px"><video id="b-3-host" class="clip" src="assets/media/aroll.mp4" muted playsinline data-start="0" data-duration="190" data-media-start="${hostStart}" data-track-index="2"></video></div>${extra}
  </div>
</div>
<script>
(function () {
const tl = gsap.timeline({ paused: true });
${tween}window.__timelines["b-3"] = tl;
})();
</script>
</template>
</body>
</html>
`;
}

/**
 * The fixture with the layout host b-3 added.
 * @param {Parameters<typeof layoutFile>[0]} [options]
 * @returns {{ html: string, facts: Facts }}
 */
function withLayout(options) {
  const anchor = motion.html.indexOf('      <div id="b-2"');
  const html = motion.html.slice(0, anchor) + HOST_LINE + motion.html.slice(anchor);
  const compositions = new Map(motion.facts.compositions);
  compositions.set("b-3", layoutFile(options));
  return { html, facts: { ...motion.facts, compositions } };
}

/** @param {Op} op @param {{ html: string, facts: Facts }} [from] */
function run(op, from = withLayout()) {
  const result = applyOp(from.html, op, from.facts);
  assert.deepEqual(
    checkDocument(parseProject(result.html), result.facts),
    [],
    "profile violations",
  );
  return result;
}

/** @param {{ files: { path: string, text: string }[] }} result @param {string} id */
function fileOf(result, id) {
  const found = result.files.find((f) => f.path === `compositions/${id}.html`);
  assert.ok(found, `compositions/${id}.html was not written`);
  return found.text;
}

/** @param {string} text @param {string} id @param {string} name */
function attrOf(text, id, name) {
  const tag = text.match(new RegExp(`<video id="${id}"[^>]*>`))?.[0] ?? "";
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
}

/** @param {string} html @param {string} id @param {string} name */
function hostAttr(html, id, name) {
  const tag = html.match(new RegExp(`<div id="${id}"[^>]*>`))?.[0] ?? "";
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
}

test("the layout host is read as two inner videos and one movement", () => {
  const from = withLayout();
  const file = innerOfHost(from.facts, "b-3");
  assert.ok(file);
  assert.deepEqual(
    file.media.map((m) => [m.src, m.mediaStart, m.rate]),
    [
      ["assets/media/broll.mp4", 60, 1],
      ["assets/media/aroll.mp4", 150, 1],
    ],
  );
  assert.deepEqual(file.layout?.spec, { scale: [1, 1.2], x: [0, 0] });
});

test("a left trim moves the in-points of the screen and the host circle by the same amount", () => {
  const result = run({ type: "trim", clipId: "b-3", edge: "start", frame: 240 });
  assert.equal(hostAttr(result.html, "b-3", "data-start"), "8");
  assert.equal(hostAttr(result.html, "b-3", "data-duration"), "2");
  const text = fileOf(result, "b-3");
  assert.equal(attrOf(text, "b-3-screen", "data-media-start"), "3");
  assert.equal(attrOf(text, "b-3-host", "data-media-start"), "6");
  assert.match(text, /"duration":2\}/);
});

test("trimming the first edge earlier moves the in-points earlier", () => {
  const result = run({ type: "trim", clipId: "b-3", edge: "start", frame: 190 });
  const text = fileOf(result, "b-3");
  assert.equal(attrOf(text, "b-3-screen", "data-media-start"), "1.333333333");
  assert.equal(attrOf(text, "b-3-host", "data-media-start"), "4.333333333");
});

test("a left trim is refused when a source file cannot start that much earlier", () => {
  const from = withLayout({ screenStart: 0.5, hostStart: 5 });
  assert.throws(
    () =>
      applyOp(from.html, { type: "trim", clipId: "b-3", edge: "start", frame: 190 }, from.facts),
    /cannot start earlier/,
  );
});

test("the inner videos keep lasting at least as long as the host after every trim", () => {
  for (const op of [
    { type: "trim", clipId: "b-3", edge: "start", frame: 190 },
    { type: "trim", clipId: "b-3", edge: "start", frame: 280 },
    { type: "trim", clipId: "b-3", edge: "end", frame: 320 },
    { type: "trim", clipId: "b-3", edge: "end", frame: 250 },
  ]) {
    const result = run(/** @type {Op} */ (op));
    const text = fileOf(result, "b-3");
    const dur = Number(hostAttr(result.html, "b-3", "data-duration"));
    for (const id of ["b-3-screen", "b-3-host"])
      assert.ok(
        Number(attrOf(text, id, "data-duration")) >= dur,
        `${id} after ${JSON.stringify(op)}`,
      );
  }
});

test("a right trim keeps the in-points and makes the movement run over the new length", () => {
  const result = run({ type: "trim", clipId: "b-3", edge: "end", frame: 270 });
  const text = fileOf(result, "b-3");
  assert.equal(attrOf(text, "b-3-screen", "data-media-start"), "2");
  assert.equal(attrOf(text, "b-3-host", "data-media-start"), "5");
  assert.match(text, /"duration":2\}/);
});

test("a split gives the second part its own file with both in-points advanced and its piece of the movement", () => {
  const result = run({ type: "split", clipId: "b-3", frame: 240 });
  const first = fileOf(result, "b-3");
  const second = fileOf(result, "b-3-2");
  assert.equal(hostAttr(result.html, "b-3", "data-duration"), "1");
  assert.equal(hostAttr(result.html, "b-3-2", "data-start"), "8");
  assert.equal(hostAttr(result.html, "b-3-2", "data-duration"), "2");
  assert.equal(attrOf(first, "b-3-screen", "data-media-start"), "2");
  assert.equal(attrOf(first, "b-3-host", "data-media-start"), "5");
  assert.equal(attrOf(second, "b-3-2-screen", "data-media-start"), "3");
  assert.equal(attrOf(second, "b-3-2-host", "data-media-start"), "6");
  assert.match(first, /"scale":\[1,1\.066667\],"x":\[0,0\],"duration":1\}/);
  assert.match(second, /"scale":\[1\.066667,1\.2\],"x":\[0,0\],"duration":2\}/);
  assert.match(second, /data-composition-id="b-3-2"/);
  assert.match(second, /window\.__timelines\["b-3-2"\]/);
  assert.match(second, /getElementById\("b-3-2-zoom"\)/);
  assert.match(second, /"#b-3-2-zoom"/);
  assert.doesNotMatch(second, /b-3-(?!2)/, "no id of the first part is left in the copy");
  assert.match(second, /assets\/media\/aroll\.mp4/);
});

test("at every frame the screen and the host circle show the same source frame as before an edit", () => {
  const before = innerOfHost(withLayout().facts, "b-3");
  assert.ok(before);
  const result = run({ type: "trim", clipId: "b-3", edge: "start", frame: 250 });
  const after = innerOfHost(result.facts, "b-3");
  assert.ok(after);
  assert.equal(after.media.length, before.media.length);
  before.media.forEach((b, i) => {
    // Frame 250 is where the host starts now; before the edit it was 40 frames into the host.
    assert.equal(after.media[i]?.mediaStart, b.mediaStart + (250 - 210));
  });
});

test("a move that keeps the host over the same A-roll clip moves the host circle's in-point with it", () => {
  const result = run({ type: "move", clipId: "b-3", frame: 220 });
  assert.equal(hostAttr(result.html, "b-3", "data-start"), "7.333333333");
  const text = fileOf(result, "b-3");
  assert.equal(attrOf(text, "b-3-host", "data-media-start"), "5.333333333");
  assert.equal(attrOf(text, "b-3-screen", "data-media-start"), "2", "the screen recording stays");
  assertSynced(result, "b-3");
});

/**
 * The oracle for the host circle: at every frame of the host, the inner video that plays shows the
 * source frame (in the source file) that the A-roll plays at that timeline frame, and the ids of the
 * file stay unique.
 * @param {{ html: string, facts: Facts }} result
 * @param {string} hostId
 * @returns {{ id: string | null, start: number, dur: number, mediaStart: number, rate: number }[]}
 *   The pieces of the host circle in time order.
 */
function assertSynced(result, hostId) {
  const parsed = parseProject(result.html);
  const host = parsed.clips.find((c) => c.id === hostId);
  assert.ok(host && host.start !== null && host.duration !== null);
  const aroll = parsed.clips.filter((c) => c.track === 0);
  const file = innerOfHost(result.facts, hostId, arollSources(parsed.clips));
  assert.ok(file);
  const pieces = file.media
    .filter((m) => m.sync)
    .sort((a, b) => a.start - b.start)
    .map((m) => ({
      id: m.element.attrs.find((a) => a.name === "id")?.value ?? null,
      src: m.src,
      start: m.start,
      dur: m.duration,
      mediaStart: m.mediaStart,
      rate: m.rate,
    }));
  const ids = pieces.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "unique ids");
  for (let f = 0; f < host.duration; f++) {
    /** @type {number} */
    const t = host.start + f;
    const clip = aroll.find(
      (c) => c.start !== null && c.duration !== null && c.start <= t && t < c.start + c.duration,
    );
    assert.ok(clip && clip.start !== null && clip.mediaStart !== null && clip.rate !== null);
    const want = clip.mediaStart + (t - clip.start) * clip.rate;
    const playing = pieces.filter((p) => p.start <= f && f < p.start + p.dur);
    assert.equal(playing.length, 1, `one piece plays at host frame ${f}`);
    const p = /** @type {(typeof pieces)[number]} */ (playing[0]);
    assert.equal(p.src, clip.src, `source at host frame ${f}`);
    assert.ok(
      Math.abs(p.mediaStart + (f - p.start) * p.rate - want) < 0.02,
      `host frame ${f} (timeline ${t}) shows source frame ${p.mediaStart + (f - p.start) * p.rate}, the A-roll plays ${want}`,
    );
  }
  return pieces;
}

/** The synced project with a playback rate on A-roll clip a-2. */
function withSpeed(rate = "1.5") {
  const from = withLayout();
  return {
    ...from,
    html: from.html.replace(
      '<video id="a-2" class="clip" src="assets/media/aroll.mp4"',
      `<video id="a-2" class="clip" src="assets/media/aroll.mp4" data-playback-rate="${rate}"`,
    ),
  };
}

/** @param {{ html: string, facts: Facts }} from @param {Op[]} ops */
function chain(from, ops) {
  let state = from;
  for (const op of ops) {
    const result = run(op, state);
    state = { html: result.html, facts: result.facts };
  }
  return state;
}

test("a move of the host over a cut gives one host video piece for each A-roll clip", () => {
  const state = chain(withLayout(), [
    { type: "delete", clipId: "b-1" },
    { type: "move", clipId: "b-3", frame: 135 },
  ]);
  const pieces = assertSynced(state, "b-3");
  assert.deepEqual(
    pieces.map((p) => [p.id, p.start, p.dur, p.mediaStart, p.rate]),
    [
      ["b-3-host", 0, 15, 165, 1],
      ["b-3-host-2", 15, 75, 90, 1],
    ],
  );
  const text = state.facts.compositions?.get("b-3") ?? "";
  assert.equal(attrOf(text, "b-3-host-2", "data-start"), "0.5");
  assert.equal(attrOf(text, "b-3-host-2", "data-media-start"), "3");
  assert.equal(attrOf(text, "b-3-host-2", "data-duration"), "2.5");
  assert.match(text, /#b-3-host \{ position: absolute; \}\n#b-3-host-2 \{ position: absolute; \}/);
  assert.match(
    text,
    /class="clip" src="assets\/media\/aroll\.mp4" muted playsinline data-start="0\.5"/,
  );
  assert.equal(attrOf(text, "b-3-screen", "data-media-start"), "2");
});

test("moving the host back over one A-roll clip makes it one piece again, and the CSS copies are harmless", () => {
  const state = chain(withLayout(), [
    { type: "delete", clipId: "b-1" },
    { type: "move", clipId: "b-3", frame: 135 },
    { type: "move", clipId: "b-3", frame: 215 },
  ]);
  const pieces = assertSynced(state, "b-3");
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0]?.id, "b-3-host");
  assert.equal(pieces[0]?.start, 0);
});

test("a left trim of the A-roll under the host keeps the host circle on the voice", () => {
  // a-2 loses its first 90 frames; the host started inside them, so it now starts at the cut.
  const result = run({ type: "trim", clipId: "a-2", edge: "start", frame: 240 });
  const pieces = assertSynced(result, "b-3");
  assert.equal(pieces.length, 1);
  assert.equal(attrOf(fileOf(result, "b-3"), "b-3-host", "data-media-start"), "6");
});

test("a left trim of the A-roll that moves the host along changes nothing in the file", () => {
  const result = run({ type: "trim", clipId: "a-2", edge: "start", frame: 180 });
  assertSynced(result, "b-3");
  assert.deepEqual(
    result.files.filter((f) => f.path.includes("b-3")),
    [],
  );
});

test("a right trim of the A-roll under the host splits the host circle where the next clip begins", () => {
  const result = run({ type: "trim", clipId: "a-2", edge: "end", frame: 270 });
  const pieces = assertSynced(result, "b-3");
  assert.deepEqual(
    pieces.map((p) => [p.start, p.dur, p.mediaStart]),
    [
      [0, 60, 150],
      [60, 30, 240],
    ],
  );
});

test("a split of the A-roll under the host and a delete of one part keep the host circle on the voice", () => {
  const split = chain(withLayout(), [{ type: "split", clipId: "a-2", frame: 240 }]);
  assert.equal(assertSynced(split, "b-3").length, 1, "a split alone changes nothing the eye sees");
  for (const clipId of ["a-2", "a-2-2"]) {
    const state = chain(split, [{ type: "delete", clipId }]);
    assertSynced(state, "b-3");
  }
  const second = chain(split, [{ type: "delete", clipId: "a-2-2" }]);
  assert.deepEqual(
    assertSynced(second, "b-3").map((p) => [p.start, p.dur, p.mediaStart]),
    [
      [0, 30, 150],
      [30, 30, 240],
    ],
    "b-2 moved up under the end of the host, which is shortened as for any overlap",
  );
});

test("a reorder of the A-roll under the host keeps the host circle on the voice", () => {
  for (const frame of [0, 150, 300, 450]) {
    for (const clipId of ["a-1", "a-2", "a-3"]) {
      const from = withLayout();
      let result;
      try {
        result = applyOp(from.html, { type: "move", clipId, frame }, from.facts);
      } catch {
        continue;
      }
      assertSynced(result, "b-3");
    }
  }
});

test("a delete of the A-roll before the host keeps the host circle on the voice", () => {
  const result = run({ type: "delete", clipId: "a-1" });
  assertSynced(result, "b-3");
});

test("a speed change of the A-roll under the host gives the host circle the same speed", () => {
  const from = withSpeed();
  const result = run({ type: "move", clipId: "b-3", frame: 200 }, from);
  const pieces = assertSynced(result, "b-3");
  assert.deepEqual(
    pieces.map((p) => [p.start, p.dur, p.mediaStart, p.rate]),
    [[0, 90, 165, 1.5]],
  );
  const text = fileOf(result, "b-3");
  assert.equal(attrOf(text, "b-3-host", "data-playback-rate"), "1.5");
  assert.equal(attrOf(text, "b-3-screen", "data-playback-rate"), null);
  const back = chain(from, [{ type: "move", clipId: "b-3", frame: 200 }]);
  const slow = chain({ ...back, html: back.html.replace(' data-playback-rate="1.5"', "") }, [
    { type: "move", clipId: "b-3", frame: 190 },
  ]);
  assert.equal(assertSynced(slow, "b-3")[0]?.rate, 1);
  assert.equal(
    attrOf(slow.facts.compositions?.get("b-3") ?? "", "b-3-host", "data-playback-rate"),
    null,
  );
});

test("a host over clips with different speeds has a piece with its own speed for each", () => {
  const state = chain(withSpeed(), [
    { type: "delete", clipId: "b-2" },
    { type: "move", clipId: "b-3", frame: 285 },
  ]);
  assert.deepEqual(
    assertSynced(state, "b-3").map((p) => [p.start, p.dur, p.mediaStart, p.rate]),
    [
      [0, 15, 90 + (285 - 150) * 1.5, 1.5],
      [15, 75, 240, 1],
    ],
  );
});

test("a split of the host over a cut gives each part the pieces of its own half", () => {
  const moved = chain(withLayout(), [
    { type: "delete", clipId: "b-1" },
    { type: "move", clipId: "b-3", frame: 135 },
  ]);
  const result = run({ type: "split", clipId: "b-3", frame: 160 }, moved);
  const first = assertSynced(result, "b-3");
  const second = assertSynced(result, "b-3-2");
  assert.equal(first.length, 2);
  assert.equal(second.length, 1);
  assert.equal(second[0]?.id, "b-3-2-host", "ids of the copy follow the new id");
  assert.equal(first[1]?.id, "b-3-host-2");
});

test("a trim of the host's edges keeps the host circle on the voice", () => {
  for (const op of /** @type {Op[]} */ ([
    { type: "trim", clipId: "b-3", edge: "start", frame: 190 },
    { type: "trim", clipId: "b-3", edge: "start", frame: 280 },
    { type: "trim", clipId: "b-3", edge: "end", frame: 250 },
  ])) {
    assertSynced(run(op), "b-3");
  }
});

test("random edits of the A-roll and of the hosts: every host circle stays on the voice", () => {
  let accepted = 0;
  let multi = 0;
  for (let seed = 1; seed <= 24; seed++) {
    let a = seed * 7919;
    const random = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (/** @type {number} */ n) => Math.floor(random() * n);
    let state = seed % 2 === 0 ? withLayout() : withSpeed();
    // A third of the runs start without the other B-roll, so that the host has room to move.
    if (seed % 3 === 0)
      state = chain(state, [
        { type: "delete", clipId: "b-1" },
        { type: "delete", clipId: "b-2" },
      ]);
    for (let step = 0; step < 30; step++) {
      const clips = parseProject(state.html).clips;
      const hosts = clips.filter((c) => c.id?.startsWith("b-3"));
      const from = random() < 0.5 && hosts.length > 0 ? hosts : clips;
      const clip = /** @type {NonNullable<(typeof clips)[number]>} */ (from[pick(from.length)]);
      const near = [
        clip.start ?? 0,
        (clip.start ?? 0) + (clip.duration ?? 0),
        ...clips.map((c) => c.start ?? 0),
        pick(500),
      ];
      const frame = Math.max(
        0,
        (near[pick(near.length)] ?? 0) + (random() < 0.3 ? pick(5) - 2 : 0),
      );
      const kind = random();
      const op = /** @type {Op} */ (
        kind < 0.2
          ? { type: "delete", clipId: clip.id ?? "" }
          : kind < 0.5
            ? { type: "trim", clipId: clip.id ?? "", edge: random() < 0.5 ? "start" : "end", frame }
            : kind < 0.75
              ? { type: "split", clipId: clip.id ?? "", frame }
              : { type: "move", clipId: clip.id ?? "", frame }
      );
      let result;
      try {
        result = applyOp(state.html, op, state.facts);
      } catch (error) {
        assert.equal(
          /** @type {{ code?: string }} */ (error).code,
          "invalidInput",
          `seed ${seed} step ${step} ${JSON.stringify(op)}: ${/** @type {Error} */ (error).message}`,
        );
        continue;
      }
      accepted++;
      state = { html: result.html, facts: result.facts };
      const parsed = parseProject(state.html);
      assert.deepEqual(checkDocument(parsed, state.facts), [], `seed ${seed} step ${step}`);
      for (const host of parsed.clips.filter((c) => c.isHost && c.id?.startsWith("b-3"))) {
        if (assertSynced(state, host.id ?? "").length > 1) multi++;
      }
    }
  }
  assert.ok(accepted > 100, `enough accepted operations: ${accepted}`);
  assert.ok(multi >= 5, `hosts with several pieces: ${multi}`);
});

test("the pieces: neighbours that continue each other are one, a stretch over no A-roll gets none", () => {
  const seg = (/** @type {number} */ start, /** @type {number} */ mediaStart, rate = 1) => ({
    src: "x.mp4",
    start,
    dur: 100,
    mediaStart,
    rate,
  });
  assert.equal(syncPieces([seg(0, 0), seg(100, 100)], 50, 100).length, 1);
  assert.equal(syncPieces([seg(0, 0), seg(100, 500)], 50, 100).length, 2);
  assert.equal(syncPieces([seg(0, 0), seg(100, 100, 2)], 50, 100).length, 2);
  assert.deepEqual(syncPieces([seg(0, 0)], 50, 100), [
    { src: "x.mp4", start: 0, dur: 50, mediaStart: 50, rate: 1 },
  ]);
  assert.deepEqual(syncPieces([seg(0, 0), seg(200, 0)], 50, 200), [
    { src: "x.mp4", start: 0, dur: 50, mediaStart: 50, rate: 1 },
    { src: "x.mp4", start: 150, dur: 50, mediaStart: 0, rate: 1 },
  ]);
  const want = syncPieces([seg(0, 0)], 0, 100);
  const have = (/** @type {number} */ duration) => [
    { src: "x.mp4", start: 0, duration, mediaStart: 0, rate: 1 },
  ];
  assert.ok(piecesMatch(have(100), want));
  assert.ok(piecesMatch(have(500), want), "the last piece may last longer");
  assert.ok(!piecesMatch(have(90), want));
});

test("edits that do not change the host leave its file alone, with or without a movement", () => {
  for (const zoom of [true, false]) {
    const from = withLayout({ zoom });
    for (const op of [
      { type: "trim", clipId: "a-3", edge: "end", frame: 420 },
      { type: "delete", clipId: "a-1" },
    ]) {
      const result = run(/** @type {Op} */ (op), from);
      assert.deepEqual(
        result.files.filter((f) => f.path.includes("b-3")),
        [],
        `${JSON.stringify(op)} with zoom ${zoom}`,
      );
    }
  }
});

test("a layout without a movement is edited the same way", () => {
  const from = withLayout({ zoom: false });
  const result = run({ type: "trim", clipId: "b-3", edge: "start", frame: 240 }, from);
  assert.equal(attrOf(fileOf(result, "b-3"), "b-3-host", "data-media-start"), "6");
  const split = run({ type: "split", clipId: "b-3", frame: 240 }, from);
  assert.equal(attrOf(fileOf(split, "b-3-2"), "b-3-2-screen", "data-media-start"), "3");
});

test("inner media that the project does not list as a source are left alone, and a graphic still cannot be split", () => {
  const extra = `\n    <video id="b-3-deco" class="clip" src="assets/deco.mp4" muted data-start="0" data-duration="3" data-media-start="0" data-track-index="3"></video>`;
  const from = withLayout({ extra });
  const result = run({ type: "trim", clipId: "b-3", edge: "start", frame: 240 }, from);
  assert.equal(attrOf(fileOf(result, "b-3"), "b-3-deco", "data-media-start"), "0");
  const plain = {
    html: from.html,
    facts: {
      ...from.facts,
      compositions: new Map([
        ...(from.facts.compositions ?? []),
        ["b-3", layoutFile().replace(/<video[^]*?<\/video>/g, "")],
      ]),
    },
  };
  assert.throws(
    () => applyOp(plain.html, { type: "split", clipId: "b-3", frame: 240 }, plain.facts),
    /cannot be split/,
  );
});

test("the profile checks the media inside a layout host against their sources", () => {
  const ok = withLayout();
  assert.deepEqual(checkDocument(parseProject(ok.html), ok.facts), []);
  const bad = withLayout({ hostStart: 199 });
  const problems = checkDocument(parseProject(bad.html), bad.facts);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.rule, 7);
  assert.match(
    problems[0]?.message ?? "",
    /aroll\.mp4 from 199 seconds to 202 seconds \(see compositions\/b-3\.html\)/,
  );
});

/**
 * Writes the project with the layout host to a folder, applies the edits one after the other, writing
 * each one's files, and reads the folder back through the whole check (rules 1 to 12 with the files on
 * disk).
 * @param {Op[]} ops
 * @param {{ html: string, facts: Facts }} [start]
 * @returns {Promise<import("../../src/timeline/profile.js").ProjectViolation[]>}
 */
async function violationsAfterOnDisk(ops, start = withLayout()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-layout-"));
  try {
    fs.cpSync(motion.dir, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), start.html);
    fs.writeFileSync(
      path.join(dir, "compositions", "b-3.html"),
      start.facts.compositions?.get("b-3") ?? "",
    );
    fs.mkdirSync(path.join(dir, "assets", "layout"), { recursive: true });
    fs.writeFileSync(path.join(dir, "assets", "layout", "bg.png"), "png");
    assert.deepEqual((await loadProject(dir)).violations, [], "the start is clean");
    let state = start;
    for (const op of ops) {
      const result = applyOp(state.html, op, state.facts);
      fs.writeFileSync(path.join(dir, "index.html"), result.html);
      for (const file of result.files) fs.writeFileSync(path.join(dir, file.path), file.text);
      state = { html: result.html, facts: result.facts };
    }
    return (await loadProject(dir)).violations;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the project on disk passes the whole check after a left trim, a split, a right trim and a move", async () => {
  for (const op of /** @type {Op[]} */ ([
    { type: "trim", clipId: "b-3", edge: "start", frame: 240 },
    { type: "trim", clipId: "b-3", edge: "end", frame: 270 },
    { type: "split", clipId: "b-3", frame: 240 },
    { type: "move", clipId: "b-3", frame: 220 },
  ])) {
    assert.deepEqual(await violationsAfterOnDisk([op]), [], JSON.stringify(op));
  }
});

test("the project on disk passes the whole check and stays in sync after edits that make several pieces", async () => {
  const chains = /** @type {Op[][]} */ ([
    [
      { type: "delete", clipId: "b-1" },
      { type: "move", clipId: "b-3", frame: 135 },
      { type: "split", clipId: "b-3", frame: 160 },
      { type: "move", clipId: "b-3-2", frame: 200 },
    ],
    [{ type: "trim", clipId: "a-2", edge: "end", frame: 270 }],
    [
      { type: "split", clipId: "a-2", frame: 240 },
      { type: "delete", clipId: "a-2-2" },
    ],
    [{ type: "trim", clipId: "a-2", edge: "start", frame: 240 }],
  ]);
  for (const ops of chains) {
    assert.deepEqual(await violationsAfterOnDisk(ops), [], JSON.stringify(ops));
  }
  const speed = withSpeed();
  assert.deepEqual(
    await violationsAfterOnDisk(
      [
        { type: "delete", clipId: "b-2" },
        { type: "move", clipId: "b-3", frame: 285 },
      ],
      speed,
    ),
    [],
  );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProject } from "../../src/timeline/document.js";
import { applyOp } from "../../src/timeline/edits.js";
import { checkDocument } from "../../src/timeline/profile.js";
import { toTimeline } from "../../src/timeline/model.js";
import { generate } from "./helpers.js";

/**
 * A small seeded generator (mulberry32), so a failure can be replayed from its seed.
 * @param {number} seed
 * @returns {() => number}
 */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = [
  ["broll", 1, "video"],
  ["graphic", 1, "div"],
  ["overlay", 2, "video"],
  ["hit", 3, "div"],
  ["fade", 4, "div"],
  ["sfx", 10, "audio"],
  ["music", 11, "audio"],
];

/** @param {() => number} random @param {number} lo @param {number} hi */
const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1));

/**
 * A random project in frames with no overlaps on any track.
 * @param {() => number} random
 * @param {string} fpsText
 */
function project(random, fpsText) {
  const aroll = Array.from({ length: between(random, 1, 7) }, () => between(random, 2, 120));
  const total = aroll.reduce((a, b) => a + b, 0);
  /** @type {{ id: string, kind: string, track: number, start: number, dur: number, tag: string }[]} */
  const others = [];
  const cursor = new Map();
  for (let i = 0; i < between(random, 0, 14); i += 1) {
    const [kind, track, tag] = /** @type {[string, number, string]} */ (
      KINDS[between(random, 0, KINDS.length - 1)]
    );
    const start = (cursor.get(track) ?? 0) + between(random, 0, 40);
    const dur = between(random, 2, 90);
    if (start + dur > total) continue;
    cursor.set(track, start + dur);
    others.push({ id: `${kind}-${i}`, kind, track, start, dur, tag });
  }
  return generate(fpsText, { aroll, others });
}

/** @param {() => number} random @param {import("../../../src/lib/wire/timeline.ts").Timeline} t */
function randomOp(random, t) {
  const clips = t.tracks.flatMap((x) => x.clips);
  const clip = clips[between(random, 0, clips.length - 1)];
  const pick = random();
  const frameNear = () => {
    const choices = [
      clip.start,
      clip.start + clip.duration,
      clip.start + 1,
      clip.start + clip.duration - 1,
      clip.start + between(random, 0, clip.duration),
      between(random, 0, t.duration + 20),
      ...clips.map((c) => c.start).slice(0, 6),
    ];
    return (
      choices[between(random, 0, choices.length - 1)] +
      between(random, -2, 2) * (random() < 0.3 ? 1 : 0)
    );
  };
  const frame = Math.max(0, frameNear());
  if (pick < 0.2) return { type: "delete", clipId: clip.id };
  if (pick < 0.5)
    return { type: "trim", clipId: clip.id, edge: random() < 0.5 ? "start" : "end", frame };
  if (pick < 0.75) return { type: "split", clipId: clip.id, frame };
  return { type: "move", clipId: clip.id, frame };
}

test("a few thousand random operations: only invalidInput, the profile holds, ids unique, no A-roll gap", () => {
  // CPU time, not wall-clock time: the suite runs beside other test files and other programs, and a busy
  // machine stretches the wall-clock time of the same work several times over.
  const started = process.cpuUsage();
  const stats = { accepted: 0, refused: 0 };
  /** @type {Record<string, number>} */
  const byType = { delete: 0, trim: 0, split: 0, move: 0 };
  const fpsList = ["30", "25", "24000/1001", "60"];
  for (let seed = 1; seed <= 45; seed += 1) {
    const random = prng(seed);
    const fpsText = /** @type {string} */ (fpsList[seed % fpsList.length]);
    const { html: startHtml, facts } = project(random, fpsText);
    let html = startHtml;
    assert.deepEqual(checkDocument(parseProject(html), facts), [], `seed ${seed} start`);
    for (let step = 0; step < 60; step += 1) {
      const timeline = toTimeline(parseProject(html), facts, {
        revision: 1,
        notes: [],
        canUndo: false,
        canRedo: false,
        locked: null,
      });
      const op = randomOp(random, timeline);
      let result;
      try {
        result = applyOp(html, /** @type {never} */ (op), facts);
      } catch (error) {
        const e = /** @type {{ code?: string, message?: string }} */ (error);
        assert.equal(
          e.code,
          "invalidInput",
          `seed ${seed} step ${step} ${JSON.stringify(op)}: ${e.message}`,
        );
        stats.refused += 1;
        continue;
      }
      stats.accepted += 1;
      byType[op.type] += 1;
      html = result.html;
      const parsed = parseProject(html);
      assert.deepEqual(
        checkDocument(parsed, facts),
        [],
        `seed ${seed} step ${step} ${JSON.stringify(op)}`,
      );
      const ids = parsed.clips.map((c) => c.id);
      assert.equal(new Set(ids).size, ids.length, "unique ids");
      const aroll = parsed.clips
        .filter((c) => c.track === 0)
        .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
      let at = 0;
      for (const c of aroll) {
        assert.equal(c.start, at, `A-roll gap or overlap before ${c.id}`);
        at += c.duration ?? 0;
      }
      assert.equal(parsed.root?.duration, at);
      assert.ok(aroll.length >= 1);
      assert.match(result.label, /^(Delete|Trim|Split|Move) /);
    }
  }
  const used = process.cpuUsage(started);
  const elapsed = (used.user + used.system) / 1000;
  assert.ok(stats.accepted + stats.refused >= 2500, JSON.stringify(stats));
  assert.ok(stats.accepted > 600, `enough accepted operations: ${JSON.stringify(stats)}`);
  for (const [type, n] of Object.entries(byType)) assert.ok(n > 50, `${type} accepted ${n} times`);
  assert.ok(
    elapsed < 4000,
    `used ${Math.round(elapsed)} ms of CPU for ${stats.accepted + stats.refused} operations`,
  );
});

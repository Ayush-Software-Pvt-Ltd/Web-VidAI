import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseProject } from "../../src/timeline/document.js";
import { parseFps } from "../../src/timeline/frames.js";
import {
  carriesFade,
  DECLICK_TEXT,
  fadeChanges,
  fadeOutFrames,
  isPureFadeLane,
  planFades,
} from "../../src/timeline/lanes.js";
import { FIXTURES, fixture } from "./helpers.js";

const table = JSON.parse(fs.readFileSync(path.join(FIXTURES, "..", "fade-rule.json"), "utf8"));

for (const c of table.cases) {
  test(`fade rule: ${c.name}`, () => {
    const fps = parseFps(c.fps);
    assert.ok(fps);
    const got = planFades(c.clips, fps, c.endFrames);
    assert.deepEqual(got, c.expect);
  });
}

test("the de-click is 8 milliseconds", () => {
  assert.equal(DECLICK_TEXT, "0.008");
});

/**
 * The A-roll clips of a project by id.
 * @param {string} html
 */
function arollOf(html) {
  const parsed = parseProject(html);
  return new Map(parsed.clips.filter((c) => c.kind === "aroll").map((c) => [c.id, c.element]));
}

test("a fade lane of nothing but 0 and 1 is the toolkit 1.2 shape; any other lane is not", () => {
  /** @param {unknown[]} points */
  const lane = (points) => JSON.stringify({ lanes: [{ target: "volume", points }] });
  assert.equal(
    isPureFadeLane(
      lane([
        { t: 0, v: 0 },
        { t: 0.008, v: 1 },
      ]),
    ),
    true,
  );
  assert.equal(isPureFadeLane(lane([{ t: 0, v: 0.5 }])), false);
  assert.equal(isPureFadeLane(lane([])), false);
  assert.equal(
    isPureFadeLane(JSON.stringify({ lanes: [{ target: "rate", points: [{ t: 0, v: 1 }] }] })),
    false,
  );
  assert.equal(
    isPureFadeLane(
      JSON.stringify({
        lanes: [
          { target: "volume", points: [{ t: 0, v: 1 }] },
          { target: "volume", points: [{ t: 1, v: 0 }] },
        ],
      }),
    ),
    false,
  );
  assert.equal(isPureFadeLane("not json"), false);
  assert.equal(isPureFadeLane("[1]"), false);
  assert.equal(isPureFadeLane(null), false);
});

test("the motion fixture manages fades, the long and short fixtures do not", () => {
  /** @type {["motion" | "long" | "short", boolean][]} */
  const expected = [
    ["motion", true],
    ["long", false],
    ["short", false],
  ];
  for (const [name, manages] of expected) {
    const { html } = fixture(name);
    assert.equal([...arollOf(html).values()].some(carriesFade), manages, name);
  }
});

test("fadeOutFrames reads the fade out in frames", () => {
  const { html, facts } = fixture("motion");
  const clips = arollOf(html);
  assert.equal(fadeOutFrames(/** @type {any} */ (clips.get("a-3")), facts.fps), 15);
  assert.equal(fadeOutFrames(/** @type {any} */ (clips.get("a-2")), facts.fps), 0);
});

test("fadeChanges sets what differs, removes what is not wanted and leaves what is right", () => {
  const { html } = fixture("motion");
  const clips = arollOf(html);
  const a1 = /** @type {any} */ (clips.get("a-1"));
  const a2 = /** @type {any} */ (clips.get("a-2"));
  // Already right: nothing to do (text "0.0080" is the same number).
  assert.deepEqual(fadeChanges(a1, { fadeIn: "0.008", fadeOut: "0.008" }), { set: {}, remove: [] });
  assert.deepEqual(fadeChanges(a1, { fadeIn: "0.0080", fadeOut: "0.008" }), {
    set: {},
    remove: [],
  });
  // Different length is set, an unwanted fade is removed, a missing one is added.
  assert.deepEqual(fadeChanges(a1, { fadeIn: null, fadeOut: "0.5" }), {
    set: { "data-fade-out": "0.5" },
    remove: ["data-fade-in"],
  });
  assert.deepEqual(fadeChanges(a2, { fadeIn: "0.008", fadeOut: "0.008" }), {
    set: { "data-fade-out": "0.008" },
    remove: [],
  });
});

test("fadeChanges replaces a toolkit 1.2 volume lane and keeps a real automation", () => {
  /** @param {unknown[]} points */
  const lane = (points) =>
    `<video id="a-1" class="clip" src="assets/media/aroll.mp4" data-start="0" data-duration="5" data-vidai-kind="aroll" data-automation='${JSON.stringify({ lanes: [{ target: "volume", points }] })}'></video>`;
  /** @param {string} clip */
  const wrap = (clip) =>
    `<div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="30" data-duration="5">${clip}</div>`;
  const pure = arollOf(
    wrap(
      lane([
        { t: 0, v: 0 },
        { t: 0.008, v: 1 },
      ]),
    ),
  ).get("a-1");
  assert.ok(pure);
  assert.equal(carriesFade(pure), true);
  assert.deepEqual(fadeChanges(pure, { fadeIn: "0.008", fadeOut: "0.008" }), {
    set: { "data-fade-in": "0.008", "data-fade-out": "0.008" },
    remove: ["data-automation"],
  });
  const ducked = arollOf(
    wrap(
      lane([
        { t: 0, v: 1 },
        { t: 2, v: 0.4 },
      ]),
    ),
  ).get("a-1");
  assert.ok(ducked);
  assert.equal(carriesFade(ducked), false);
  assert.deepEqual(fadeChanges(ducked, { fadeIn: null, fadeOut: null }), { set: {}, remove: [] });
});

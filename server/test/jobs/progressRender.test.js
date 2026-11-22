// The render progress: the pure reducer and the tolerant line parser.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RENDER_START_STAGE,
  RENDER_STAGES,
  createRenderProgress,
  parseRenderLine,
  renderProgress,
  renderView,
} from "../../src/jobs/progressRender.js";

/** @param {string} code @param {number} pct */
const line = (code, pct) => `@hf-progress ${JSON.stringify({ code, done: pct, total: 100, pct })}`;

/**
 * Feeds lines and returns the state after each.
 * @param {string[]} lines
 */
function feed(lines) {
  let state = createRenderProgress();
  return lines.map((l) => {
    const parsed = parseRenderLine(l);
    if (parsed !== null && parsed.type === "progress") state = renderProgress(state, parsed);
    return state;
  });
}

test("a render starts at zero and says it is preparing", () => {
  const state = createRenderProgress();
  assert.deepEqual(renderView(state), { percent: 0, stage: RENDER_START_STAGE, secondsLeft: null });
});

test("the stages map to 0-80, 80-95 and 95-99 in order", () => {
  assert.deepEqual(
    RENDER_STAGES.map((s) => [s.code, s.from, s.to, s.stage]),
    [
      ["capture", 0, 80, "Rendering frames"],
      ["encode", 80, 95, "Encoding"],
      ["assemble", 95, 99, "Finishing"],
    ],
  );
  const states = feed([
    line("capture", 0),
    line("capture", 13.3),
    line("capture", 50),
    line("capture", 100),
    line("encode", 0),
    line("encode", 50),
    line("encode", 100),
    line("assemble", 0),
    line("assemble", 50),
    line("assemble", 100),
  ]);
  assert.deepEqual(
    states.map((s) => [s.percent, s.stage]),
    [
      [0, "Rendering frames"],
      [10, "Rendering frames"],
      [40, "Rendering frames"],
      [80, "Rendering frames"],
      [80, "Encoding"],
      [87, "Encoding"],
      [95, "Encoding"],
      [95, "Finishing"],
      [97, "Finishing"],
      [99, "Finishing"],
    ],
  );
});

test("the bar never goes backwards: repeated, smaller and out-of-order lines change nothing", () => {
  const states = feed([
    line("capture", 50),
    line("capture", 20),
    line("capture", 50),
    line("encode", 40),
    line("capture", 99),
    line("encode", 10),
    line("assemble", 10),
    line("encode", 90),
  ]);
  const percents = states.map((s) => s.percent);
  assert.deepEqual(percents, [40, 40, 40, 86, 86, 86, 95, 95]);
  assert.equal(states[4].stage, "Encoding", "an earlier stage is ignored");
  assert.equal(states[7].stage, "Finishing");
});

test("garbage lines change nothing", () => {
  const states = feed([
    "",
    "plain output",
    "@hf-progress",
    "@hf-progress {broken",
    '@hf-progress {"code":"unknown","pct":50}',
    '@hf-progress {"code":"capture"}',
    '@hf-progress {"code":"capture","pct":"x"}',
    '@hf-progress ["capture"]',
    "@hf-progress null",
  ]);
  for (const s of states) assert.deepEqual(s, createRenderProgress());
});

test("100 only when told the render completed, then nothing changes", () => {
  let state = createRenderProgress();
  state = renderProgress(state, {
    type: "progress",
    code: "assemble",
    pct: 100,
    done: 1,
    total: 1,
  });
  assert.equal(state.percent, 99, "never 100 from a line");
  state = renderProgress(state, { type: "completed" });
  assert.deepEqual(renderView(state), { percent: 100, stage: "Done", secondsLeft: null });
  const after = renderProgress(state, {
    type: "progress",
    code: "capture",
    pct: 1,
    done: 1,
    total: 100,
  });
  assert.equal(after, state);
  // Completing without any line is fine too.
  assert.equal(renderProgress(createRenderProgress(), { type: "completed" }).percent, 100);
});

test("a percent out of range is clamped", () => {
  const [over, under] = feed([line("capture", 250), line("encode", -40)]);
  assert.equal(over.percent, 80);
  assert.equal(under.percent, 80);
  const direct = renderProgress(createRenderProgress(), {
    type: "progress",
    code: "capture",
    pct: 1e9,
    done: null,
    total: null,
  });
  assert.equal(direct.percent, 80);
});

test("parseRenderLine reads realistic lines with prefixes and ANSI codes", () => {
  const body = '{"code":"capture","done":120,"total":900,"pct":13.3}';
  const want = { type: "progress", code: "capture", pct: 13.3, done: 120, total: 900 };
  assert.deepEqual(parseRenderLine(`@hf-progress ${body}`), want);
  assert.deepEqual(parseRenderLine(`@hf-progress${body}`), want);
  assert.deepEqual(parseRenderLine(`[12:00:01] INFO @hf-progress ${body}`), want);
  assert.deepEqual(
    parseRenderLine(`\u001b[2m12:00:01\u001b[0m \u001b[36m@hf-progress\u001b[0m ${body}\u001b[0m`),
    want,
  );
  assert.deepEqual(parseRenderLine(`@hf-progress ${body} trailing {text}`), want);
  assert.deepEqual(parseRenderLine(`@hf-progress ${body}\r`), want);
  // Braces inside strings do not end the object early.
  assert.deepEqual(parseRenderLine('@hf-progress {"code":"encode","pct":5,"note":"}{"}'), {
    type: "progress",
    code: "encode",
    pct: 5,
    done: null,
    total: null,
  });
  // The percent comes from done and total when it is missing.
  assert.deepEqual(parseRenderLine('@hf-progress {"code":"encode","done":1,"total":4}'), {
    type: "progress",
    code: "encode",
    pct: 25,
    done: 1,
    total: 4,
  });
  assert.deepEqual(parseRenderLine('\u001b[32m@hf-result {"ok":true,"path":"out.mp4"}\u001b[0m'), {
    type: "result",
    result: { ok: true, path: "out.mp4" },
  });
});

test("parseRenderLine never throws", () => {
  for (const bad of [
    undefined,
    null,
    42,
    {},
    "@hf-",
    "@hf-progress {",
    '@hf-progress {"code":"capture",',
    '@hf-result {"a":',
    "@hf-result []",
    "\u001b[",
    "@hf-progress " + "{".repeat(10_000),
    '@hf-progress {"code":"capture","pct":NaN}',
  ]) {
    assert.doesNotThrow(() => parseRenderLine(/** @type {never} */ (bad)));
    assert.equal(parseRenderLine(/** @type {never} */ (bad)), null);
  }
});

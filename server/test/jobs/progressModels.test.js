// The models, markers and pacing of the progress engine (ports of the model, marker and history
// unit tests of src-tauri/src/jobs/progress.rs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDescriber } from "../../src/jobs/log.js";
import {
  MILESTONES,
  MILESTONE_NAMES,
  MODELS,
  isAgentKind,
  milestoneOf,
  modelOf,
} from "../../src/jobs/progressModels.js";
import {
  MARKER_TAG,
  markerInstructions,
  markerLines,
  markerLogLine,
  markerRules,
  splitMarkers,
} from "../../src/jobs/progressMarkers.js";
import {
  HISTORY_RUNS,
  MIN_HISTORY_RUNS,
  defaultPacing,
  median,
  pacingFromHistory,
} from "../../src/jobs/progressPacing.js";
import { event, memoryHistory, nestedText, text } from "./progressSupport.js";

const KINDS = /** @type {const} */ (["edit", "reEdit", "timelineEdit"]);

/** @param {import("../../src/jobs/progressModels.js").AgentKind} kind */
const weights = (kind) => modelOf(kind).steps.reduce((sum, s) => sum + s.weight, 0);

test("the edit weights add up to 99 and the cumulative values are the owner's anchors", () => {
  assert.equal(weights("edit"), 99);
  let sum = 0;
  const cumulative = modelOf("edit").steps.map((s) => (sum += s.weight));
  assert.deepEqual(cumulative, [3, 15, 30, 64, 74, 83, 91, 96, 99]);
});

test("the re-edit and timeline edit weights stay as in the desktop app: 95, never above 99", () => {
  // The brief assumed these add up to 99; the Rust model has no mechanism for it. A finished
  // re-edit shows 95 "Finishing up" until it completes.
  assert.deepEqual(
    modelOf("reEdit").steps.map((s) => s.weight),
    [65, 30],
  );
  assert.deepEqual(
    modelOf("timelineEdit").steps.map((s) => s.weight),
    [70, 25],
  );
  for (const kind of KINDS) {
    assert.ok(weights(kind) <= 99, kind);
    if (kind !== "edit") assert.equal(weights(kind), 95, kind);
  }
});

test("every model is consistent with the milestones", () => {
  for (const kind of KINDS) {
    const model = modelOf(kind);
    assert.equal(model.kind, kind);
    const names = model.steps.map((s) => s.milestone);
    assert.equal(new Set(names).size, names.length, "no repeats");
    for (const [i, s] of model.steps.entries()) {
      assert.ok(milestoneOf(s.milestone) !== null);
      assert.ok(s.weight > 0);
      // What a stretch follows is listed before it, so the estimate can read its window.
      if (s.after !== null) assert.ok(names.indexOf(s.after) < i && names.includes(s.after));
      assert.ok(s.typicalMin[0] > 0 && s.typicalMin[0] <= s.typicalMin[1]);
    }
    const total = model.totalMin;
    const last = model.steps.at(-1)?.typicalMin;
    assert.ok(last !== undefined && total[0] >= last[0] && total[1] >= last[1]);
    // The pacing is in minutes, in step order and never decreasing along the chain of `after`.
    const pacing = defaultPacing(kind, "long");
    assert.equal(pacing.atMs.length, model.steps.length);
    assert.ok(pacing.totalMs >= Math.max(...pacing.atMs));
  }
  for (const [name, m] of Object.entries(MILESTONES)) {
    assert.equal(m.name, name);
    for (const implied of m.implies) assert.ok(milestoneOf(implied) !== null);
    assert.ok(m.doneText !== "" && m.hint !== "");
  }
  assert.deepEqual([...MILESTONE_NAMES], Object.keys(MILESTONES));
  assert.ok(!("review_saved" in MILESTONES), "renamed to project_saved");
  assert.equal(MILESTONES.project_saved.doneText, "Project saved");
});

test("kinds and lookups", () => {
  for (const kind of KINDS) assert.ok(isAgentKind(kind));
  assert.ok(!isAgentKind("render") && !isAgentKind("toString"));
  assert.throws(() => modelOf(/** @type {never} */ ("render")), TypeError);
  assert.equal(milestoneOf("planned")?.name, "planned");
  assert.equal(milestoneOf("mystery"), null);
  assert.equal(milestoneOf("constructor"), null);
  assert.deepEqual(Object.keys(MODELS), [...KINDS]);
});

test("marker instructions list the markers of the kind's model with what counts as finished", () => {
  const lines = markerLines("edit").split("\n");
  assert.equal(lines.length, 9);
  assert.equal(lines[0], `[${MARKER_TAG} inspected] - ${MILESTONES.inspected.hint}`);
  assert.ok(lines[7].startsWith("[VIDAI_PROGRESS project_saved] - the project is saved"));
  assert.ok(markerLines("reEdit").includes("changes_applied"));
  assert.ok(!markerLines("reEdit").includes("transcribed"));
  assert.ok(markerLines("timelineEdit").includes("project_saved"));
  const text = markerInstructions("edit");
  assert.ok(text.startsWith("Progress markers: VidAI shows a progress bar for this job."));
  assert.ok(text.includes("never in sub-agents"));
  assert.ok(text.endsWith(markerLines("edit")));
});

test("splitMarkers keeps prose and removes marker lines", () => {
  assert.deepEqual(splitMarkers("[VIDAI_PROGRESS inspected]"), {
    text: "",
    markers: ["inspected"],
  });
  assert.deepEqual(splitMarkers("Plan done.\n\n[VIDAI_PROGRESS planned]\nNext up."), {
    text: "Plan done.\n\n\nNext up.".replace(/\n\n\n/u, "\n\n"),
    markers: ["planned"],
  });
  // Markdown filler, case, dashes, several markers on a line.
  assert.deepEqual(splitMarkers("**`[vidai_progress graphics-built]`**").markers, [
    "graphics_built",
  ]);
  assert.deepEqual(
    splitMarkers("> - [VIDAI_PROGRESS planned] [VIDAI_PROGRESS broll_ready]").markers,
    ["planned", "broll_ready"],
  );
  // Prose, broken markers and other tags stay text.
  for (const prose of [
    "I will write [VIDAI_PROGRESS planned] after the plan.",
    "[VIDAI_PROGRESS planned",
    "[VIDAI_PROGRESS]",
    "[VIDAI_PROGRESS not a name]",
    "[OTHER planned]",
    "[VIDAI_PROGRESS planned] and more",
  ]) {
    assert.deepEqual(splitMarkers(prose), { text: prose, markers: [] }, prose);
  }
});

test("markerLogLine says what finished", () => {
  assert.equal(markerLogLine("transcribed"), "Transcription done");
  assert.equal(markerLogLine("project_saved"), "Project saved");
  assert.equal(markerLogLine("mystery"), "Progress: mystery");
});

test("the marker rules fit the log describer", () => {
  const d = createDescriber({ markers: markerRules });
  const out = d.describe(
    event({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "The plan is written.\n\n[VIDAI_PROGRESS planned]\n[VIDAI_PROGRESS mystery]",
          },
        ],
      },
    }),
  );
  assert.deepEqual(
    out.entries.map((e) => [e.kind, e.text]),
    [
      ["assistant", "The plan is written."],
      ["status", "Edit plan written"],
      ["status", "Progress: mystery"],
    ],
  );
  // Sub-agents' markers are dropped.
  const nested = d.describe(nestedText("[VIDAI_PROGRESS planned]"));
  assert.deepEqual(nested.entries, []);
  // The same text through the engine's own parser agrees on the main session.
  assert.deepEqual(
    d.describe(text("[VIDAI_PROGRESS checked]")).entries.map((e) => e.text),
    ["Quality checks done"],
  );
});

test("the median of the last runs", () => {
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([1, 2, 3, 10]), 2);
});

test("history: fewer than three rows use the defaults, three or more scale them by the median", () => {
  const defaults = defaultPacing("edit", "short");
  /** @param {number} seconds @param {number} finishedAt */
  const row = (seconds, finishedAt) => ({
    kind: /** @type {const} */ ("edit"),
    videoType: /** @type {const} */ ("short"),
    seconds,
    finishedAt,
  });
  assert.equal(MIN_HISTORY_RUNS, 3);
  assert.deepEqual(pacingFromHistory("edit", "short", []), defaults);
  assert.deepEqual(pacingFromHistory("edit", "short", [row(3000, 2), row(3000, 1)]), defaults);
  // 30 minutes against the default 25: every default time grows by 1.2.
  const learned = pacingFromHistory("edit", "short", [row(1800, 3), row(1800, 2), row(2400, 1)]);
  assert.equal(learned.totalMs, 1_800_000);
  assert.deepEqual(
    learned.atMs,
    defaults.atMs.map((at) => Math.round(at * 1.2)),
  );
  // Nonsense rows do not count toward the three.
  assert.deepEqual(
    pacingFromHistory("edit", "short", [row(0, 3), row(Number.NaN, 2), row(1800, 1)]),
    defaults,
  );
  // Only the newest ten are looked at, and the history is looked up by kind and type.
  assert.equal(HISTORY_RUNS, 10);
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => row(600, 100 - i)),
    ...Array.from({ length: 20 }, (_, i) => row(9000, i)),
  ];
  assert.equal(pacingFromHistory("edit", "short", rows).totalMs, 600_000);
  const history = memoryHistory([...rows, { ...row(100, 999), videoType: "long" }]);
  assert.equal(history.recent("edit", "short", 10).length, 10);
  assert.equal(history.recent("edit", "long", 10).length, 1);
  assert.equal(history.recent("reEdit", "short", 10).length, 0);
});

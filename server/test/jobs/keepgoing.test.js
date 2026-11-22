// The decision of a keeper (docs/SPEC.md section 8, "Keeping a job going").

import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLETION_MARKER,
  DEFAULT_LIMITS,
  createKeeper,
  hasCompletionMarker,
  statusLine,
} from "../../src/jobs/keepgoing.js";

/** @typedef {import("../../src/jobs/keepgoing.js").Evidence} Evidence */
/** @typedef {import("../../src/jobs/keepgoing.js").Decision} Decision */

/**
 * @param {number} toolCalls
 * @returns {import("../../src/jobs/keepgoing.js").Turn}
 */
const work = (toolCalls) => ({ toolCalls, marker: false });

/**
 * @param {number} milestones
 * @returns {Evidence}
 */
const nothing = (milestones) => ({
  deliverable: null,
  extrasMissing: [],
  milestones,
  workersBusy: false,
});

/**
 * @param {string[]} extrasMissing
 * @returns {Evidence}
 */
const delivered = (extrasMissing) => ({
  deliverable: "v1.hf",
  extrasMissing,
  milestones: 8,
  workersBusy: false,
});

/**
 * @param {number} number
 * @returns {Decision}
 */
const keepWorking = (number) => ({ kind: "continue", nudge: { kind: "keepWorking" }, number });

test("the marker is the documented line", () => {
  assert.equal(COMPLETION_MARKER, "[OUTPUT COMPLETED]");
  assert.deepEqual(DEFAULT_LIMITS, {
    idleTurns: 3,
    withoutProgress: 8,
    ceiling: 40,
    saveRequests: 2,
  });
});

test("the marker finds its line in any case", () => {
  assert.ok(hasCompletionMarker("All done.\n\n[OUTPUT COMPLETED]"));
  assert.ok(hasCompletionMarker("**[Output Completed]**"));
  assert.ok(!hasCompletionMarker("OUTPUT COMPLETED"));
  assert.ok(!hasCompletionMarker("[VIDAI_PROGRESS project_saved]"));
});

test("a deliverable with the marker is done at once", () => {
  const keeper = createKeeper(DEFAULT_LIMITS, 0);
  assert.deepEqual(keeper.turnEnded({ toolCalls: 4, marker: true }, delivered([])), {
    kind: "complete",
    deliverable: "v1.hf",
  });
  assert.equal(keeper.continuations(), 0);
});

test("a marker from an earlier turn still counts", () => {
  const keeper = createKeeper(DEFAULT_LIMITS, 0);
  assert.deepEqual(keeper.turnEnded({ toolCalls: 0, marker: true }, nothing(3)), {
    kind: "continue",
    nudge: { kind: "saveOutput" },
    number: 1,
  });
  assert.equal(keeper.turnEnded(work(2), delivered([])).kind, "complete");
});

test("a deliverable without the marker gets one finishing request and no more", () => {
  const keeper = createKeeper(DEFAULT_LIMITS, 0);
  assert.deepEqual(keeper.turnEnded(work(5), delivered(["thumbnails", "meta.txt"])), {
    kind: "continue",
    nudge: { kind: "finish", deliverable: "v1.hf", extrasMissing: ["thumbnails", "meta.txt"] },
    number: 1,
  });
  // Whatever the model does next, even nothing, the deliverable is there: done.
  assert.deepEqual(keeper.turnEnded(work(0), delivered(["thumbnails"])), {
    kind: "complete",
    deliverable: "v1.hf",
  });
});

test("the marker without a deliverable is asked to save, then fails", () => {
  const keeper = createKeeper(DEFAULT_LIMITS, 0);
  const marked = { toolCalls: 1, marker: true };
  for (const number of [1, 2]) {
    assert.deepEqual(keeper.turnEnded(marked, nothing(5)), {
      kind: "continue",
      nudge: { kind: "saveOutput" },
      number,
    });
  }
  assert.deepEqual(keeper.turnEnded(marked, nothing(5)), { kind: "missingOutput" });
});

test("early turn ends with work go on as often as a real edit needs", () => {
  // The real OpenCode edits: every early end came after at least one tool call, and a new
  // milestone arrived at least every third early end.
  const keeper = createKeeper(DEFAULT_LIMITS, 0);
  let milestones = 0;
  for (let number = 1; number <= 20; number += 1) {
    if (number % 2 === 0) milestones += 1;
    assert.deepEqual(keeper.turnEnded(work(1), nothing(milestones)), keepWorking(number));
  }
  assert.equal(keeper.turnEnded({ toolCalls: 3, marker: true }, delivered([])).kind, "complete");
});

test("idle turns in a row are stuck and any tool call resets them", () => {
  const keeper = createKeeper(DEFAULT_LIMITS, 0);
  assert.deepEqual(keeper.turnEnded(work(0), nothing(0)), keepWorking(1));
  assert.deepEqual(keeper.turnEnded(work(0), nothing(0)), keepWorking(2));
  assert.deepEqual(keeper.turnEnded(work(1), nothing(1)), keepWorking(3));
  assert.deepEqual(keeper.turnEnded(work(0), nothing(1)), keepWorking(4));
  assert.deepEqual(keeper.turnEnded(work(0), nothing(1)), keepWorking(5));
  assert.deepEqual(keeper.turnEnded(work(0), nothing(1)), {
    kind: "stuck",
    reason: { kind: "idleTurns", count: 3 },
  });
});

test("busy turns without progress are stuck after the limit", () => {
  let keeper = createKeeper(DEFAULT_LIMITS, 4);
  for (let number = 1; number <= 8; number += 1) {
    assert.deepEqual(keeper.turnEnded(work(2), nothing(4)), keepWorking(number));
  }
  assert.deepEqual(keeper.turnEnded(work(2), nothing(4)), {
    kind: "stuck",
    reason: { kind: "noProgress", count: 8 },
  });
  // A new milestone at the last moment resets the count instead.
  keeper = createKeeper(DEFAULT_LIMITS, 4);
  for (let number = 1; number <= 8; number += 1) {
    assert.deepEqual(keeper.turnEnded(work(2), nothing(4)), keepWorking(number));
  }
  assert.deepEqual(keeper.turnEnded(work(2), nothing(5)), keepWorking(9));
});

test("a model waiting for its busy commands is asked to wait and is never stuck", () => {
  // A slow computer: the transcription runs for an hour in the background of a shell and the
  // model ends its turn every minute or two to check on it.
  /** @type {Evidence} */
  const busy = { ...nothing(4), workersBusy: true };
  let keeper = createKeeper(DEFAULT_LIMITS, 4);
  for (let number = 1; number <= 30; number += 1) {
    assert.deepEqual(
      keeper.turnEnded(work(0), busy),
      { kind: "continue", nudge: { kind: "waitForWork" }, number },
      String(number),
    );
  }
  // The same turns on an idle computer are what they were: stuck after three without work.
  keeper = createKeeper(DEFAULT_LIMITS, 4);
  keeper.turnEnded(work(0), nothing(4));
  keeper.turnEnded(work(0), nothing(4));
  assert.deepEqual(keeper.turnEnded(work(0), nothing(4)), {
    kind: "stuck",
    reason: { kind: "idleTurns", count: 3 },
  });
  // Waiting does not use up the room for real continuations (only the ceiling counts it), and a
  // deliverable or the marker is decided as ever, busy or not.
  keeper = createKeeper(DEFAULT_LIMITS, 4);
  for (let i = 0; i < 7; i += 1) keeper.turnEnded(work(1), busy);
  assert.deepEqual(keeper.turnEnded(work(2), nothing(4)), keepWorking(8));
  keeper = createKeeper(DEFAULT_LIMITS, 4);
  assert.equal(
    keeper.turnEnded({ toolCalls: 1, marker: true }, { ...delivered([]), workersBusy: true }).kind,
    "complete",
  );
  // The ceiling still ends a run that waits forever.
  keeper = createKeeper(DEFAULT_LIMITS, 4);
  for (let i = 0; i < 40; i += 1) keeper.turnEnded(work(0), busy);
  assert.deepEqual(keeper.turnEnded(work(0), busy), {
    kind: "stuck",
    reason: { kind: "ceiling", count: 40 },
  });
});

test("the ceiling ends any run that never finishes", () => {
  const keeper = createKeeper({ ...DEFAULT_LIMITS, withoutProgress: Infinity }, 0);
  for (let number = 1; number <= 40; number += 1) {
    assert.deepEqual(keeper.turnEnded(work(1), nothing(number)), keepWorking(number));
  }
  assert.deepEqual(keeper.turnEnded(work(1), nothing(99)), {
    kind: "stuck",
    reason: { kind: "ceiling", count: 40 },
  });
  // A deliverable that shows up at the ceiling still completes the job.
  assert.equal(keeper.turnEnded(work(1), delivered(["thumbnails"])).kind, "complete");
});

test("a marker on a busy computer without a deliverable is still asked to save", () => {
  const keeper = createKeeper(DEFAULT_LIMITS, 0);
  assert.deepEqual(
    keeper.turnEnded({ toolCalls: 0, marker: true }, { ...nothing(1), workersBusy: true }),
    { kind: "continue", nudge: { kind: "saveOutput" }, number: 1 },
  );
});

test("status lines are numbered and name the work", () => {
  assert.equal(
    statusLine("edit", { kind: "keepWorking" }, 2),
    "Asked to keep going (2): the turn ended before the edit was finished",
  );
  assert.equal(
    statusLine("render", { kind: "keepWorking" }, 1),
    "Asked to keep going (1): the turn ended before the final render was finished",
  );
  assert.equal(
    statusLine("timelineEdit", { kind: "keepWorking" }, 1),
    "Asked to keep going (1): the turn ended before the timeline edit was finished",
  );
  assert.equal(
    statusLine("reEdit", { kind: "finish", deliverable: "v2.hf", extrasMissing: [] }, 3),
    "Asked to finish the last steps (3): the new project version is saved, [OUTPUT COMPLETED] is not written yet",
  );
  assert.equal(
    statusLine("edit", { kind: "finish", deliverable: "v1.hf", extrasMissing: [] }, 3),
    "Asked to finish the last steps (3): the project is saved, [OUTPUT COMPLETED] is not written yet",
  );
  assert.equal(
    statusLine("edit", { kind: "saveOutput" }, 4),
    "Asked to save the project (4): [OUTPUT COMPLETED] was written, but it is not in the output folder",
  );
  assert.equal(
    statusLine("edit", { kind: "waitForWork" }, 5),
    "Asked to wait for the running commands (5): the computer is busy with your background work",
  );
});

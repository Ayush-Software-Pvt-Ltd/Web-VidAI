// The tracker and the publisher: ports of the progress assertions of
// src-tauri/tests/jobs_progress.rs, feeding the engine the same stream events and file evidence
// directly (no process, no store), with an injected clock, probe, scan and history.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTracker } from "../../src/jobs/progressTracker.js";
import { completedProgress, createPublisher } from "../../src/jobs/progressView.js";
import { emptyProbe } from "../../src/jobs/progressEvidence.js";
import { FINISHING_STAGE } from "../../src/jobs/progressModels.js";
import {
  MIN,
  kinds,
  memoryHistory,
  nestedText,
  text,
  tool,
  taskDone,
  taskStarted,
} from "./progressSupport.js";

const T0 = 50_000_000;

/** A clock the test moves. */
function makeClock() {
  let t = T0;
  return {
    now: () => t,
    /** @param {number} ms */
    advance(ms) {
      t += ms;
    },
  };
}

/**
 * A tracker over fakes: `files` is what the output folder holds, `work` what the working folder
 * shows.
 * @param {Partial<Parameters<typeof createTracker>[0]> & { clock?: ReturnType<typeof makeClock> }} [options]
 */
function setup(options = {}) {
  const clock = options.clock ?? makeClock();
  const history = options.history ?? memoryHistory();
  /** @type {import("../../src/jobs/progressEvidence.js").OutputProbe} */
  const files = emptyProbe();
  /** @type {import("../../src/jobs/workFiles.js").WorkEvidence} */
  const work = { ...kinds({}), files: 0 };
  const tracker = createTracker({
    kind: "edit",
    videoType: "short",
    jobId: "job-1",
    clock,
    history,
    since: T0,
    probeOutput: () => ({ ...files }),
    scanWork: () => ({ ...work }),
    ...options,
  });
  return { clock, history, files, work, tracker };
}

/**
 * Lets `ms` pass in one-second steps, polling each second like the manager does, and returns
 * what was published.
 * @param {ReturnType<typeof setup>} env
 * @param {number} ms
 */
function run(env, ms) {
  /** @type {import("../../src/jobs/progressTracker.js").ProgressUpdate[]} */
  const updates = [];
  for (let spent = 0; spent < ms; spent += 1000) {
    env.clock.advance(1000);
    const update = env.tracker.poll();
    if (update !== null) updates.push(update);
  }
  return updates;
}

/** @param {import("../../src/jobs/progressTracker.js").ProgressUpdate[]} updates */
const percents = (updates) => updates.map((u) => u.view.percent);

test("progress rises through the milestones, stays at 99 until completed and is 100 when done", () => {
  const env = setup();
  const first = env.tracker.poll();
  assert.deepEqual(first?.view, { percent: 0, stage: "Inspecting the footage", secondsLeft: 1500 });
  assert.equal(first?.persist, true, "a first stage is persisted at once");
  /** @type {import("../../src/jobs/progressTracker.js").ProgressUpdate[]} */
  const all = first === null ? [] : [first];
  // The milestone's value and the next one's: the time creep fills the gap but never passes it.
  /** @type {[string, number, number, string][]} */
  const steps = [
    ["inspected", 3, 15, "Transcribing"],
    ["transcribed", 15, 30, "Planning the edit"],
    ["planned", 30, 64, "Building graphics"],
    ["graphics_built", 64, 74, "Preparing b-roll"],
    ["broll_ready", 74, 83, "Assembling the timeline"],
    ["assembled", 83, 91, "Checking the edit"],
    ["checked", 91, 96, "Saving the project"],
  ];
  for (const [name, want, next, stage] of steps) {
    env.tracker.observe(text(`Step done.\n[VIDAI_PROGRESS ${name}]`));
    const [update] = run(env, 3000);
    const got = update?.view.percent ?? -1;
    assert.ok(got >= want && got < next, `${name}: ${got}`);
    assert.equal(update?.view.stage, stage, name);
    assert.equal(update?.persist, true, `${name}: a new stage is persisted`);
    all.push(...run(env, 20_000));
  }
  // The project and the thumbnails are files, not markers' business.
  env.files.projectExists = true;
  env.files.projectModifiedAt = T0 + 5000;
  const afterProject = run(env, 10_000);
  assert.equal(percents(afterProject).at(-1), 96);
  env.files.thumbnailsModifiedAt = T0 + 6000;
  env.files.metaModifiedAt = T0 + 6000;
  all.push(...afterProject, ...run(env, 10_000));
  const final = all.at(-1);
  assert.deepEqual([final?.view.percent, final?.view.stage], [99, FINISHING_STAGE]);
  // Never backwards, never above 99 before completion.
  const sequence = percents(all);
  assert.ok(
    sequence.every((p, i) => i === 0 || p >= sequence[i - 1]),
    `${sequence}`,
  );
  assert.ok(sequence.every((p) => p <= 99));
  // Throttled: far fewer events than polls.
  assert.ok(all.length < 150, `${all.length} updates`);
  // The finished job is 100 "Done" and paces the next ones.
  assert.deepEqual(completedProgress(), { percent: 100, stage: "Done", secondsLeft: null });
  env.tracker.recordCompletion();
  const [recorded] = env.history.recent("edit", "short", 10);
  assert.equal(recorded.videoType, "short");
  assert.equal(recorded.finishedAt, env.clock.now());
  assert.ok(Math.abs(recorded.seconds - (env.clock.now() - T0) / 1000) < 0.001);
  assert.equal(Object.keys(env.tracker.seen()).length, 9 - 0, "every milestone was seen");
});

test("the publisher: a change within a second waits, a new stage does not", () => {
  const clock = makeClock();
  const publisher = createPublisher({ clock, published: null });
  const view = (/** @type {number} */ percent, /** @type {string} */ stage) => ({
    percent,
    stage,
    secondsLeft: null,
  });
  assert.deepEqual(publisher.consider(view(0, "A")), { publish: true, persist: true });
  assert.deepEqual(publisher.consider(view(0, "A")), { publish: false, persist: false }, "same");
  clock.advance(300);
  assert.equal(publisher.consider(view(1, "A")).publish, false, "too soon");
  assert.equal(publisher.consider(view(2, "B")).publish, true, "a new stage at once");
  clock.advance(1000);
  assert.deepEqual(publisher.consider(view(3, "B")), { publish: true, persist: false });
  clock.advance(100);
  assert.equal(publisher.consider(view(4, "B"), true).publish, true, "forced");
  // A creep-only change is persisted at most every ten intervals.
  clock.advance(10_000);
  assert.equal(publisher.consider(view(5, "B")).persist, true);
  clock.advance(1000);
  assert.equal(publisher.consider(view(6, "B")).persist, false);
});

test("a continued job shows its last progress while queued and goes on from it", () => {
  const first = setup();
  first.tracker.observe(text("[VIDAI_PROGRESS planned]"));
  const [atPlan] = run(first, 3000);
  const paused = run(first, 120_000).at(-1);
  assert.ok(paused !== undefined && paused.view.percent >= 30 && paused.view.percent < 64);
  assert.equal(paused.view.stage, "Building graphics");
  const memory = JSON.parse(JSON.stringify(paused.memory));
  assert.equal(memory.jobId, "job-1");
  assert.ok("planned" in memory.done);
  assert.equal(atPlan.view.percent, 30);

  // Continue: a new run of the same job, with the active time before it, a new clock.
  const clock = makeClock();
  clock.advance(7 * 24 * 60 * MIN); // a week later
  const activeBeforeMs = 123_000;
  const resumed = setup({
    clock,
    activeBeforeMs,
    memory,
    progress: paused.view,
    since: T0,
    history: first.history,
  });
  // Nothing changed yet: nothing to publish, so the queue keeps showing the frozen value.
  assert.equal(resumed.tracker.poll(), null);
  assert.ok(resumed.tracker.isDone("planned"));
  const [next] = run(resumed, 3000);
  assert.ok(next === undefined || next.view.percent >= paused.view.percent);
  resumed.tracker.observe(text("[VIDAI_PROGRESS graphics_built]"));
  const [moved] = run(resumed, 3000);
  assert.equal(moved.view.percent, 64);
  // The job's pace carries on: the same active time gives the same value as without the pause.
  assert.ok(resumed.tracker.workShown() >= 2);
});

test("progress survives a restart: the memory is plain JSON, another job's memory is ignored", () => {
  const first = setup();
  first.tracker.observe(text("[VIDAI_PROGRESS planned]"));
  const before = run(first, 120_000).at(-1);
  assert.ok(before !== undefined);
  const stored = JSON.stringify(before.memory);
  assert.ok(before.view.percent >= 30);

  const restarted = setup({
    memory: JSON.parse(stored),
    progress: before.view,
    activeBeforeMs: 120_000,
    clock: makeClock(),
  });
  // Nothing changed yet: the frozen value stays, and what follows never goes below it.
  const kept = restarted.tracker.poll(true);
  assert.ok(kept === null || kept.view.percent >= before.view.percent, JSON.stringify(kept));
  const after = run(restarted, 3000).at(-1) ?? kept;
  assert.ok(
    after === null ||
      (after.view.percent >= before.view.percent && after.view.stage === "Building graphics"),
  );
  assert.ok(restarted.tracker.isDone("planned"));
  // A memory of another job (a new job for the same video) does not carry over.
  const other = setup({ memory: JSON.parse(stored), jobId: "job-2" });
  assert.equal(other.tracker.isDone("planned"), false);
  assert.equal(other.tracker.poll()?.view.percent, 0);
  // A damaged memory is just no memory.
  const damaged = setup({ memory: { done: 7 } });
  assert.equal(damaged.tracker.poll()?.view.percent, 0);
  // The progress the job already showed is the floor.
  const floor = setup({
    memory: null,
    progress: { percent: 42, stage: "Planning the edit", secondsLeft: null },
  });
  assert.ok((floor.tracker.poll(true)?.view.percent ?? 0) >= 42);
});

test("progress is inferred when the agent writes no markers", () => {
  const env = setup();
  // Step 1: the footage is inspected, Whisper runs, the transcript is read.
  env.tracker.observe(tool("Bash", { command: "whisper-cli a.wav", description: "Transcribe" }));
  env.tracker.observe(tool("Read", { file_path: "/v/CLAUDE_VE/transcript_full.json" }));
  assert.equal(run(env, 3000).at(-1)?.view.percent, 15);
  assert.equal(run(env, 1000).at(-1) ?? null, null, "nothing changes within the same second");
  // The plan is done when a graphics sub-agent starts; it finishes: graphics built.
  env.tracker.observe(tool("Agent", { description: "Build graphics" }, "g1"));
  env.tracker.observe(taskStarted("g1", "Build graphics", "local_agent"));
  assert.equal(run(env, 3000).at(-1)?.view.stage !== undefined, true);
  env.tracker.observe(taskDone("g1", "completed"));
  const graphics = run(env, 3000).at(-1);
  assert.deepEqual([graphics?.view.percent, graphics?.view.stage], [64, "Preparing b-roll"]);
  // The project on disk implies the whole step after the plan.
  env.files.projectExists = true;
  env.files.projectModifiedAt = T0 + 20_000;
  const project = run(env, 6000).at(-1);
  assert.deepEqual([project?.view.percent, project?.view.stage], [96, "Thumbnails and details"]);
  // Thumbnails and meta.txt on disk.
  env.files.thumbnailsModifiedAt = T0 + 25_000;
  env.files.metaModifiedAt = T0 + 25_000;
  const finishing = run(env, 6000).at(-1);
  assert.deepEqual([finishing?.view.percent, finishing?.view.stage], [99, "Finishing up"]);
  // Nothing of it was a marker: sub-agent markers still count for nothing.
  env.tracker.observe(nestedText("[VIDAI_PROGRESS planned]"));
});

test("the output folder is only looked at every five intervals and never without a start time", () => {
  let looks = 0;
  const clock = makeClock();
  const env = setup({
    clock,
    probeOutput: () => {
      looks += 1;
      return emptyProbe();
    },
  });
  assert.equal(looks, 1, "once, when the run starts");
  run(env, 4000);
  assert.equal(looks, 2, "the first poll looks");
  run(env, 10_000);
  assert.equal(looks, 4);
  env.tracker.probeNow();
  env.tracker.poll();
  assert.equal(looks, 5, "probeNow looks at the next poll");
  // Without `since` the files of the video are not looked at at all.
  let blind = 0;
  const unknown = setup({
    since: null,
    probeOutput: () => {
      blind += 1;
      return emptyProbe();
    },
  });
  run(unknown, 20_000);
  assert.equal(blind, 1);
});

test("a project that was there, unchanged, when the run started is not this job's work", () => {
  const clock = makeClock();
  const old = { ...emptyProbe(), projectExists: true, projectModifiedAt: T0 - 60_000 };
  const env = setup({ clock, probeOutput: () => ({ ...old }) });
  run(env, 20_000);
  assert.equal(env.tracker.isDone("project_saved"), false);
  // The run rewrote it.
  old.projectModifiedAt = T0 + 10_000;
  run(env, 6000);
  assert.equal(env.tracker.isDone("project_saved"), true);
});

test("a new re-edit or timeline edit for the same video starts again from zero", () => {
  const history = memoryHistory();
  const edit = setup({ history });
  edit.tracker.observe(text("[VIDAI_PROGRESS planned]"));
  run(edit, 3000);
  edit.tracker.recordCompletion();
  for (const kind of /** @type {const} */ (["reEdit", "timelineEdit"])) {
    const memoryOfTheEdit = {
      jobId: "job-1",
      done: { planned: { atMs: 0, implied: false } },
      percent: 30,
    };
    const next = setup({ kind, jobId: `${kind}-1`, history, memory: memoryOfTheEdit });
    const first = next.tracker.poll();
    assert.deepEqual(first?.view.percent, 0, kind);
    assert.equal(first?.view.stage, "Applying the changes", kind);
    next.tracker.observe(text("[VIDAI_PROGRESS changes_applied]"));
    const applied = run(next, 3000)[0]?.view.percent ?? -1;
    assert.ok(applied >= (kind === "reEdit" ? 65 : 70) && applied < 95, `${kind}: ${applied}`);
    next.files.projectExists = true;
    next.files.projectModifiedAt = T0 + 30_000;
    const done = run(next, 6000).at(-1);
    assert.deepEqual([done?.view.percent, done?.view.stage], [95, FINISHING_STAGE]);
    next.tracker.recordCompletion();
    assert.equal(history.recent(kind, "short", 10).length, 1, "history is per kind");
  }
  assert.equal(history.recent("edit", "short", 10).length, 1);
});

test("a model that writes its markers at the end still moves the bar with its files", () => {
  const env = setup();
  /** @type {number[]} */
  const seen = [];
  /** @param {Partial<import("../../src/jobs/workFiles.js").Kinds>} k @param {number} files */
  const step = (k, files) => {
    Object.assign(env.work, k, { files });
    const view = run(env, 6000).at(-1)?.view;
    seen.push(view?.percent ?? seen.at(-1) ?? 0);
    return view;
  };
  const inspected = step({ audio: true }, 1);
  assert.deepEqual([inspected?.percent, inspected?.stage], [3, "Transcribing"]);
  assert.equal(step({ transcript: true }, 2)?.percent, 15);
  assert.equal(step({ plan: true }, 3)?.percent, 30);
  assert.equal(env.tracker.workShown() >= 3, true, "files count as work shown");
  assert.equal(step({ graphics: true }, 9)?.stage, "Building graphics");
  assert.equal(step({ qualityCheck: true }, 12)?.stage, "Checking the edit");
  env.files.projectExists = true;
  env.files.projectModifiedAt = T0 + 40_000;
  assert.equal(step({}, 13)?.percent, 96);
  assert.ok(
    seen.every((p, i) => i === 0 || p >= seen[i - 1]),
    `${seen}`,
  );
  // Only what the files showed was seen; the rest was implied and stays out of the history.
  assert.deepEqual(Object.keys(env.tracker.seen()).sort(), [
    "assembled",
    "inspected",
    "planned",
    "project_saved",
    "transcribed",
  ]);
  // The markers arrive at the end and change nothing that was already settled.
  env.tracker.observe(text("[VIDAI_PROGRESS inspected]\n[VIDAI_PROGRESS transcribed]"));
  assert.ok((run(env, 3000).at(-1)?.view.percent ?? 96) >= 96);
});

test("a re-edit does not read the working folder, only the output folder", () => {
  const env = setup({ kind: "reEdit" });
  Object.assign(env.work, { audio: true, transcript: true, plan: true, files: 3 });
  run(env, 10_000);
  assert.equal(env.tracker.isDone("changes_applied"), false);
  assert.ok(env.tracker.workShown() >= 3, "but the files still show the job is working");
});

test("recording a completion feeds the pace of the next job", () => {
  const history = memoryHistory();
  for (let i = 0; i < 3; i += 1) {
    const env = setup({ history });
    env.clock.advance(30 * MIN);
    env.tracker.recordCompletion();
  }
  const next = setup({ history });
  // The typical total is now 30 minutes instead of 25: the time left at the start says so.
  assert.equal(next.tracker.poll()?.view.secondsLeft, 30 * 60);
});

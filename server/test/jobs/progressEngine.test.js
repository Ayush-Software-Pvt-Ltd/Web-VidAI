// The progress engine (ports of the unit tests of src-tauri/src/jobs/progress.rs, adapted to the
// new milestone names and the project folder). The engine is pure and clock-free, so every test
// states the job's active time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createProgress, parseMemory } from "../../src/jobs/progressEngine.js";
import { FINISHING_STAGE, SETUP_STAGE } from "../../src/jobs/progressModels.js";
import { completedProgress } from "../../src/jobs/progressView.js";
import { defaultPacing } from "../../src/jobs/progressPacing.js";
import {
  MIN,
  engine,
  event,
  evidence,
  kinds,
  nestedText,
  percent,
  shown,
  stage,
  taskDone,
  taskStarted,
  text,
  tool,
  toolResult,
} from "./progressSupport.js";

test("a new job starts at zero and markers move it to the milestone values", () => {
  const p = engine();
  assert.deepEqual(shown(p, 0), { percent: 0, stage: "Inspecting the footage" });
  p.observe(text("[VIDAI_PROGRESS inspected]"), MIN);
  assert.deepEqual(shown(p, MIN), { percent: 3, stage: "Transcribing" });
  p.observe(text("Done.\n[VIDAI_PROGRESS transcribed]"), 4 * MIN);
  assert.deepEqual(shown(p, 4 * MIN), { percent: 15, stage: "Planning the edit" });
  p.observe(text("[VIDAI_PROGRESS planned]"), 9 * MIN);
  assert.deepEqual(shown(p, 9 * MIN), { percent: 30, stage: "Building graphics" });
  for (const [marker, at, want, next] of /** @type {[string, number, number, string][]} */ ([
    ["graphics_built", 20, 64, "Preparing b-roll"],
    ["broll_ready", 20, 74, "Assembling the timeline"],
    ["assembled", 21, 83, "Checking the edit"],
    ["checked", 23, 91, "Saving the project"],
    ["project_saved", 24, 96, "Thumbnails and details"],
    ["extras_written", 25, 99, FINISHING_STAGE],
  ])) {
    p.observe(text(`[VIDAI_PROGRESS ${marker}]`), at * MIN);
    assert.deepEqual(shown(p, at * MIN), { percent: want, stage: next }, marker);
  }
  // Capped at 99 however long it takes; only completion makes 100.
  assert.equal(percent(p, 600 * MIN), 99);
  assert.deepEqual(completedProgress(), { percent: 100, stage: "Done", secondsLeft: null });
});

test("milestones out of order add up the same and imply what came before", () => {
  const a = engine();
  a.mark("broll_ready", 10 * MIN);
  // B-roll implies the plan (and everything before it).
  assert.ok(a.isDone("planned") && a.isDone("inspected"));
  // The b-roll runs beside the graphics: it finishing says nothing about how far they are.
  assert.equal(percent(a, 10 * MIN), 40);
  // The stage is the first unfinished milestone: graphics, not the finished b-roll.
  assert.equal(stage(a, 10 * MIN), "Building graphics");
  a.mark("graphics_built", 20 * MIN);
  const b = engine();
  b.mark("graphics_built", 20 * MIN);
  assert.equal(stage(b, 20 * MIN), "Preparing b-roll");
  b.mark("broll_ready", 20 * MIN);
  assert.equal(percent(a, 20 * MIN), 74);
  assert.equal(percent(b, 20 * MIN), 74);
  // The project implies the whole step after the plan, but not the thumbnails.
  const c = engine();
  c.mark("project_saved", 24 * MIN);
  assert.deepEqual(shown(c, 24 * MIN), { percent: 96, stage: "Thumbnails and details" });
  // Marking again changes nothing; a milestone of another kind's model is ignored.
  assert.equal(c.mark("project_saved", 25 * MIN), false);
  assert.equal(c.mark("changes_applied", 25 * MIN), false);
});

test("the bar keeps moving without evidence and never passes the files", () => {
  // The edit that was stuck at 29 %: the transcript is done, nothing else is ever seen.
  const p = engine();
  p.mark("transcribed", 210_000);
  assert.deepEqual(shown(p, 210_000), { percent: 15, stage: "Planning the edit" });
  // Inside the stage it moves at the typical speed (7 points by the middle of it) and stays a
  // point below the next milestone at its end.
  assert.equal(percent(p, 315_000), 15 + 7);
  assert.equal(percent(p, 420_000), 15 + 14);
  let last = 0;
  let at29 = 0;
  for (let minute = 4; minute <= 720; minute += 1) {
    const now = percent(p, minute * MIN);
    assert.ok(now >= last, "never backwards");
    assert.ok(now < 96, "never the project's value without its file");
    if (now === 29) at29 += 1;
    last = now;
  }
  // It passed 29 after a few minutes; twelve hours later it is still above and below 96.
  assert.ok(at29 <= 8, `${at29} minutes at 29`);
  assert.ok(last > 35, `${last}`);
  // It goes on slowing down, never stopping: higher after two, three and five hours.
  const q = engine();
  q.mark("transcribed", 210_000);
  const curve = Array.from({ length: 12 }, (_, step) => percent(q, (4 + step * 30) * MIN));
  assert.ok(
    curve.every((v, i) => i === 0 || v >= curve[i - 1]),
    `${curve}`,
  );
  assert.ok(curve[0] < curve[2] && curve[2] < curve[6] && curve[6] < curve[11], `${curve}`);
  // Evidence lands it on the milestone value, and the estimate goes on from there.
  const before = percent(q, 400 * MIN);
  q.mark("planned", 400 * MIN);
  assert.ok(percent(q, 400 * MIN) >= Math.max(before, 30));
});

test("the stage label names only what the evidence supports", () => {
  const p = engine();
  p.mark("transcribed", 4 * MIN);
  // Inside the stage: its name, a point short of the milestone.
  assert.deepEqual(shown(p, 5 * MIN), { percent: 18, stage: "Planning the edit" });
  assert.equal(stage(p, 6 * MIN), "Planning the edit");
  // Ahead of the evidence (an hour later): no step is named.
  const late = p.current(60 * MIN);
  assert.equal(late.stage, "Working on the edit");
  assert.ok(late.percent > 30);
  // Evidence for the plan brings the stage back, and the bar never goes down.
  p.mark("planned", 61 * MIN);
  const back = p.current(61 * MIN);
  assert.equal(back.stage, "Building graphics");
  assert.ok(back.percent >= late.percent);
  // Re-edit and timeline edit say what they work on in their own words.
  for (const kind of /** @type {const} */ (["reEdit", "timelineEdit"])) {
    assert.equal(engine(kind).current(3 * 60 * MIN).stage, "Working on the changes");
  }
});

test("no file, no value of the milestones that only files confirm", () => {
  for (const [kind, limit] of /** @type {const} */ ([
    ["edit", 95],
    ["reEdit", 94],
    ["timelineEdit", 94],
  ])) {
    const p = engine(kind, "long");
    for (let hour = 0; hour < 100; hour += 1) {
      assert.ok(percent(p, hour * 60 * MIN) <= limit, `${kind} at hour ${hour}`);
    }
  }
  // The thumbnails written early do not lift the ceiling of the project.
  const p = engine();
  p.observeOutput(evidence({ thumbnails: true, meta: true }), 5 * MIN);
  assert.ok(p.isDone("extras_written"));
  assert.ok(percent(p, 1000 * MIN) <= 98);
  // Nor do they say where the job is: the plan stage is still the next one.
  const q = engine();
  q.mark("transcribed", 4 * MIN);
  q.observeOutput(evidence({ thumbnails: true, meta: true }), 5 * MIN);
  assert.equal(stage(q, 5 * MIN), "Planning the edit");
});

test("a milestone expected earlier than the evidence starts its stretch at the evidence", () => {
  // The graphics are confirmed first; the typical timeline had the b-roll done before them.
  const p = engine();
  p.mark("graphics_built", 21 * MIN);
  assert.deepEqual(shown(p, 21 * MIN), { percent: 64, stage: "Preparing b-roll" });
  // The b-roll creeps, a point below its value, and the timeline waits for it.
  const creep = percent(p, 24 * MIN);
  assert.ok(creep >= 65 && creep < 74, `${creep}`);
  // Long after, the estimate goes on into the assembly with a slow-down.
  const late = percent(p, 60 * MIN);
  assert.ok(late > creep && late <= 95, `${late}`);
});

test("progress never goes backwards when a parallel milestone arrives", () => {
  const p = engine();
  p.mark("planned", 9 * MIN);
  const before = percent(p, 30 * MIN); // far into the graphics stretch
  assert.ok(before >= 55, `${before}`);
  // B-roll finishes: the base rises by 10 but the estimate does not start over.
  p.mark("broll_ready", 30 * MIN);
  assert.ok(percent(p, 30 * MIN) >= before);
  let last = before;
  for (let minute = 30; minute < 600; minute += 1) {
    const now = percent(p, minute * MIN);
    assert.ok(now >= last && now <= 95);
    last = now;
  }
});

test("a slow computer is given its own pace", () => {
  // An Intel Mac: the transcript takes four times as long as the Apple Silicon default.
  const fast = engine();
  const slow = engine();
  fast.mark("transcribed", 3 * MIN + 30_000);
  slow.mark("transcribed", 14 * MIN);
  const f = percent(fast, 5 * MIN);
  const s = percent(slow, 14 * MIN + 90_000);
  assert.ok(s < f, `${s} < ${f}`);
});

test("a slow job paces its creep slower", () => {
  const typical = engine();
  const slow = engine();
  typical.mark("transcribed", 4 * MIN);
  slow.mark("transcribed", 8 * MIN); // twice the typical time
  const t = percent(typical, 4 * MIN + 150_000);
  const s = percent(slow, 8 * MIN + 150_000);
  assert.ok(s < t, `${s} < ${t}`);
});

test("setup is not the work", () => {
  // A fresh Intel Mac: half an hour of installing, venvs and smoke tests that name Whisper.
  const p = engine();
  /** @param {string} id @param {string} command @param {string} description @param {boolean} background */
  const bash = (id, command, description, background) =>
    tool("Bash", { command, description, run_in_background: background }, id);
  p.observe(bash("b1", "brew install ffmpeg", "Install ffmpeg via Homebrew", false), 20_000);
  assert.equal(stage(p, 30_000), SETUP_STAGE);
  p.observe(toolResult("b1"), 2 * MIN);
  p.observe(bash("b2", "pip install faster-whisper", "Install faster-whisper", true), MIN);
  const venv = "Create py3.9 venv with faster-whisper for Intel";
  p.observe(taskStarted("t1", venv, "local_bash"), MIN);
  p.observe(taskDone("t1", "completed"), 6 * MIN);
  const smoke = "Smoke-test Hindi transcription on 30s slice";
  p.observe(bash("b3", "python smoke.py", smoke, true), 7 * MIN);
  p.observe(taskStarted("t2", smoke, "local_bash"), 7 * MIN);
  p.observe(taskDone("t2", "completed"), 8 * MIN);
  // Reading the script that transcribes is not reading a transcript.
  p.observe(tool("Read", { file_path: "/Edit/CLAUDE_VE_ALL/transcribe.py" }), 9 * MIN);
  assert.ok(!p.isDone("inspected") && !p.isDone("transcribed"));
  // Half an hour later the bar has not moved and says what is going on.
  const atHalfHour = p.current(30 * MIN);
  assert.ok(atHalfHour.percent <= 2, JSON.stringify(atHalfHour));
  assert.equal(atHalfHour.stage, SETUP_STAGE);
  assert.equal(atHalfHour.secondsLeft, null);
  // The real transcription starts: the stage is the work again.
  const launch = "Launch both Whisper passes";
  p.observe(bash("b4", "python transcribe.py a.wav &", launch, true), 31 * MIN);
  assert.ok(p.isDone("inspected"));
  assert.equal(stage(p, 31 * MIN), "Transcribing");
  // A command that only starts the transcription in the background ends when it has started it:
  // that is not a transcript.
  p.observe(taskStarted("t3", launch, "local_bash"), 31 * MIN);
  p.observe(taskDone("t3", "completed"), 32 * MIN);
  assert.ok(!p.isDone("transcribed"));
  // A setup command that is running now says so, and its time does not move the bar.
  const before = percent(p, 33 * MIN);
  p.observe(bash("b5", "pip install x", "Install a package", false), 33 * MIN);
  assert.equal(stage(p, 34 * MIN), SETUP_STAGE);
  p.observe(toolResult("b5"), 43 * MIN);
  assert.equal(percent(p, 43 * MIN), before);
  assert.notEqual(stage(p, 43 * MIN), SETUP_STAGE);
});

test("setup seen in a re-edit never holds the bar in a first stage that has no footage", () => {
  // The desktop app waited for "inspected", which a re-edit does not have; here only an edit does.
  const p = engine("reEdit");
  p.observe(tool("Bash", { command: "pip install x", description: "Install x" }, "s1"), MIN);
  p.observe(toolResult("s1"), 2 * MIN);
  assert.equal(stage(p, 3 * MIN), "Applying the changes");
  assert.ok(percent(p, 10 * MIN) > 2);
});

test("files in the video folder confirm the steps whatever program wrote them", () => {
  const p = engine();
  // A plan file before any transcript is not planning from one.
  p.observeWork(kinds({ plan: true }), MIN);
  assert.ok(!p.isDone("planned"));
  p.observeWork(kinds({ audio: true }), 90_000);
  assert.ok(p.isDone("inspected") && !p.isDone("transcribed"));
  p.observeWork(kinds({ transcript: true }), 3 * MIN);
  assert.deepEqual(shown(p, 3 * MIN), { percent: 15, stage: "Planning the edit" });
  // The plan, then graphics sources and renders: the plan is done and graphics are the stage.
  p.observeWork(kinds({ plan: true }), 8 * MIN);
  assert.deepEqual(shown(p, 8 * MIN), { percent: 30, stage: "Building graphics" });
  const q = engine();
  q.observeWork(kinds({ audio: true }), MIN);
  q.observeWork(kinds({ graphics: true }), 10 * MIN);
  assert.ok(q.isDone("planned") && q.isDone("transcribed"));
  // Quality-check output needs the picture with its graphics and b-roll: only the timeline and
  // the checks are left, and only what was seen is learned from.
  p.observeWork(kinds({ qualityCheck: true }), 28 * MIN);
  assert.ok(p.isDone("graphics_built") && p.isDone("broll_ready"));
  assert.ok(p.isDone("assembled") && !p.isDone("checked"));
  assert.equal(stage(p, 28 * MIN), "Checking the edit");
  const seen = p.seen();
  assert.ok("assembled" in seen);
  assert.ok(!("graphics_built" in seen));
  // The project still needs its file.
  assert.ok(percent(p, 60 * MIN) <= 95);
  // Re-edits look at the output folder only.
  const r = engine("reEdit");
  r.observeWork(kinds({ audio: true }), MIN);
  assert.equal(r.finished(), 0);
  // A graphics file the stream shows being written counts at once, a plan only from the main
  // session.
  const s = engine();
  s.mark("transcribed", MIN);
  s.observe(tool("Write", { file_path: "/v/CLAUDE_VE/gfx_src/hook/index.html" }), 2 * MIN);
  assert.ok(s.isDone("planned"));
  const n = engine();
  n.mark("transcribed", MIN);
  n.observe(
    event({
      type: "assistant",
      parent_tool_use_id: "agent1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "w",
            name: "Write",
            input: { file_path: "/v/CLAUDE_VE/spec.json" },
          },
        ],
      },
    }),
    2 * MIN,
  );
  assert.ok(!n.isDone("planned"));
});

test("pause and restart resume from the same value", () => {
  const pacing = () => defaultPacing("edit", "long");
  const p = createProgress({ kind: "edit", pacing: pacing() });
  p.mark("transcribed", 6 * MIN);
  const atPause = p.current(8 * MIN);
  const memory = p.memory("job-1");
  assert.equal(memory.jobId, "job-1");
  assert.equal(memory.percent, atPause.percent);
  // Active time does not grow while the job is paused; after Continue (or a restart) the engine
  // goes on from the persisted memory at the same active time.
  const resumed = createProgress({
    kind: "edit",
    pacing: pacing(),
    memory,
    shown: atPause.percent,
  });
  assert.deepEqual(resumed.current(8 * MIN), atPause);
  assert.ok(resumed.isDone("transcribed") && !resumed.isDone("planned"));
  assert.equal(
    resumed.current(10 * MIN).percent,
    p.current(10 * MIN).percent,
    "the creep goes on exactly as without the pause",
  );
  resumed.mark("planned", 12 * MIN);
  assert.equal(resumed.current(12 * MIN).percent, 30);
  // A memory that never got written (crash right after a start): the persisted percent is the
  // floor, the milestones start over.
  const floor = createProgress({ kind: "edit", pacing: pacing(), shown: 42 });
  assert.deepEqual(shown(floor, 0), { percent: 42, stage: "Inspecting the footage" });
  // Milestones of another kind in the memory are dropped.
  const other = {
    ...memory,
    done: { ...memory.done, changes_applied: { atMs: 0, implied: false } },
  };
  const restored = createProgress({ kind: "edit", pacing: pacing(), memory: other });
  assert.deepEqual(restored.memory("job-1").done, memory.done);
  // What was persisted is plain JSON that survives the database column.
  assert.deepEqual(parseMemory(JSON.parse(JSON.stringify(memory))), memory);
});

test("a stored memory that is damaged is read leniently", () => {
  assert.equal(parseMemory(null), null);
  assert.equal(parseMemory("x"), null);
  assert.equal(parseMemory({ done: {}, percent: 3 }), null, "no job id");
  assert.deepEqual(
    parseMemory({ jobId: "j", done: { planned: { atMs: -5 }, junk: 3, odd: null }, percent: 250 }),
    { jobId: "j", done: { planned: { atMs: 0, implied: false } }, percent: 100 },
  );
  const restored = createProgress({
    kind: "edit",
    pacing: defaultPacing("edit", "short"),
    memory: parseMemory({ jobId: "j", done: {}, percent: 250 }),
  });
  assert.equal(percent(restored, 0), 99, "never above 99 before completion");
});

test("missing markers are inferred from tools, tasks and files", () => {
  const p = engine();
  // A product helper starts early; it does not move the plan.
  const product = { description: "Find product images", run_in_background: "true" };
  p.observe(tool("Agent", product), 30_000);
  p.observe(taskStarted("prod", "Find product images", "local_agent"), 30_000);
  assert.equal(p.finished(), 0);
  const transcribe = {
    command: "python3 tools/transcribe.py a.wav",
    description: "Transcribe the A-roll",
    run_in_background: true,
  };
  p.observe(tool("Bash", transcribe), MIN);
  assert.ok(p.isDone("inspected"));
  // Shell commands that run Whisper end when the command ends, which says nothing about the
  // transcript; a transcription sub-agent that completes does.
  p.observe(taskStarted("w1", "Whisper chunk pass", "local_bash"), MIN);
  p.observe(taskDone("w1", "completed"), 3 * MIN);
  assert.ok(!p.isDone("transcribed"));
  p.observe(taskStarted("w2", "Transcribe the A-roll", "local_agent"), MIN);
  p.observe(taskDone("w2", "completed"), 4 * MIN);
  assert.ok(p.isDone("transcribed"));
  assert.equal(stage(p, 4 * MIN), "Planning the edit");
  p.observe(taskDone("prod", "completed"), 6 * MIN);
  assert.ok(!p.isDone("broll_ready"), "started before the plan");
  // The graphics fan-out starts from the finished plan.
  for (const [id, d] of [
    ["g1", "Build graphics A"],
    ["g2", "Build graphics B"],
  ]) {
    p.observe(tool("Agent", { description: d, run_in_background: true }), 9 * MIN);
    p.observe(taskStarted(id, d, "local_agent"), 9 * MIN);
  }
  assert.ok(p.isDone("planned"));
  assert.equal(percent(p, 9 * MIN), 30);
  p.observe(taskStarted("b1", "Conform b-roll clips", "local_agent"), 9 * MIN);
  p.observe(taskDone("g1", "completed"), 15 * MIN);
  p.observe(taskDone("g2", "killed"), 16 * MIN);
  assert.ok(!p.isDone("graphics_built"), "a killed agent is not done");
  p.observe(taskStarted("g3", "Rebuild graphics B", "local_agent"), 16 * MIN);
  p.observe(taskDone("b1", "completed"), 17 * MIN);
  assert.ok(p.isDone("broll_ready"));
  p.observe(taskDone("g3", "completed"), 20 * MIN);
  assert.ok(!p.isDone("graphics_built"), "g2 never completed");
  // The project in the output folder settles everything before it.
  p.observeOutput(evidence({ project: true }), 24 * MIN);
  assert.equal(percent(p, 24 * MIN), 96);
  p.observeOutput(evidence({ project: true, thumbnails: true }), 25 * MIN);
  assert.ok(!p.isDone("extras_written"), "thumbnails without meta.txt");
  p.observeOutput(evidence({ project: true, thumbnails: true, meta: true }), 25 * MIN);
  assert.equal(percent(p, 25 * MIN), 99);
  // Only what was seen goes into the history, implied milestones do not.
  const seen = p.seen();
  assert.deepEqual(Object.keys(seen).sort(), [
    "broll_ready",
    "extras_written",
    "inspected",
    "planned",
    "project_saved",
    "transcribed",
  ]);
  assert.equal(seen.planned, 9 * MIN);
});

test("plan files, transcripts and foreground agents count too", () => {
  // Writing a plan before any transcription started is not planning from a transcript.
  const p = engine();
  p.observe(tool("Write", { file_path: "/v/CLAUDE_VE/plan.md" }), 10_000);
  assert.ok(!p.isDone("transcribed"));
  p.observe(tool("Bash", { command: "mlx_whisper a.wav" }), MIN);
  p.observe(tool("Read", { file_path: "/v/CLAUDE_VE/transcript_full.json" }), 3 * MIN);
  assert.ok(p.isDone("transcribed"));
  const q = engine();
  q.observe(tool("Bash", { command: "whisper-cli a.wav" }), MIN);
  q.observe(tool("Write", { file_path: "/v/CLAUDE_VE/timeline.py" }), 4 * MIN);
  assert.ok(q.isDone("transcribed"));
  // info.txt is not a plan.
  const r = engine();
  r.observe(tool("Bash", { command: "whisper a.wav" }), MIN);
  r.observe(tool("Write", { file_path: "/v/info.txt" }), 2 * MIN);
  assert.ok(!r.isDone("transcribed"));
  // A foreground sub-agent is finished when its tool result arrives.
  const f = engine();
  f.observe(tool("Agent", { description: "Build the title graphics" }), 9 * MIN);
  assert.ok(f.isDone("planned"));
  f.observe(toolResult("tu-Agent"), 18 * MIN);
  assert.ok(f.isDone("graphics_built"));
  // Markers of sub-agents never count.
  const n = engine();
  n.observe(nestedText("[VIDAI_PROGRESS planned]"), MIN);
  assert.ok(!n.isDone("planned"));
});

test("re-edit and timeline edit models", () => {
  for (const [kind, first, apply] of /** @type {const} */ ([
    ["reEdit", 65, 65],
    ["timelineEdit", 70, 70],
  ])) {
    const r = engine(kind);
    assert.equal(stage(r, 0), "Applying the changes");
    // Edit markers mean nothing to them.
    r.observe(text("[VIDAI_PROGRESS transcribed]"), MIN);
    assert.equal(r.finished(), 0, kind);
    // The changes marker lands on its weight.
    r.observe(text("[VIDAI_PROGRESS changes_applied]"), 5 * MIN);
    assert.deepEqual(shown(r, 5 * MIN), { percent: apply, stage: "Saving the project" }, kind);
    assert.equal(first, apply);
    // The project file implies the changes and ends the job's evidence: 95, finishing.
    const s = engine(kind);
    s.observeOutput(evidence({ project: true }), 6 * MIN);
    assert.ok(s.isDone("changes_applied"));
    assert.deepEqual(shown(s, 6 * MIN), { percent: 95, stage: FINISHING_STAGE }, kind);
  }
});

test("a timeline edit's weights are its own", () => {
  const p = engine("timelineEdit");
  p.mark("project_saved", 4 * MIN);
  assert.equal(percent(p, 4 * MIN), 95);
  const q = engine("timelineEdit");
  q.mark("changes_applied", 3 * MIN);
  assert.equal(percent(q, 3 * MIN), 70);
  // Never the project's value without its file.
  assert.ok(percent(q, 600 * MIN) <= 94);
});

test("a render has no progress model of the agent engine", () => {
  assert.throws(
    () =>
      createProgress({
        kind: /** @type {never} */ ("render"),
        pacing: { atMs: [], totalMs: 0 },
      }),
    TypeError,
  );
});

test("the time left follows the typical timeline at the job's pace", () => {
  const p = engine();
  assert.equal(p.current(0).secondsLeft, 25 * 60);
  assert.equal(p.current(30_000).secondsLeft, 25 * 60 - 30);
  // With the transcript done on time, the rest of the typical timeline is left.
  p.mark("transcribed", 3.5 * MIN);
  assert.equal(p.current(3.5 * MIN).secondsLeft, 21.5 * 60);
  assert.equal(p.current(5.5 * MIN).secondsLeft, 19.5 * 60);
  // A job that is twice as slow as typical has twice the typical time left.
  const slow = engine();
  slow.mark("transcribed", 7 * MIN); // typical 3.5
  assert.equal(slow.current(7 * MIN).secondsLeft, 2 * (25 - 3.5) * 60);
  // Later than typical, nobody knows; with every milestone done there is nothing to estimate.
  assert.equal(percent(p, 500 * MIN) > 0, true);
  assert.equal(p.current(500 * MIN).secondsLeft, null);
  const done = engine();
  for (const name of /** @type {const} */ (["project_saved", "extras_written"]))
    done.mark(name, MIN);
  assert.equal(done.current(2 * MIN).secondsLeft, null);
});

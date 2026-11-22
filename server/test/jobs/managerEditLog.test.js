// The words of the edit log lines a job writes, per kind and outcome (docs/SPEC.md section 16).
// An agent program is named only where one takes part: a render has none, so none of its lines
// names a program ("Render started", "Render finished").
import assert from "node:assert/strict";
import { test } from "node:test";
import { createManagerWorld, until } from "./managerSupport.js";

/**
 * The lines of the log so far, once `count` of them exist (a job's last line is written just
 * after its state changes).
 * @param {ReturnType<typeof createManagerWorld>} w
 * @param {number} count
 */
async function lines(w, count) {
  await until(() => w.knobs.editLog.length >= count);
  return w.knobs.editLog.map((entry) => `${entry.event}: ${entry.message}`);
}

/**
 * Makes every edit log line show up in `w.emitted` too (as `{ event: "edit-log-line" }`), so a test
 * can say what came first: the line or the news that the job changed.
 * @param {ReturnType<typeof createManagerWorld>} w
 */
function interleaveLogWithEvents(w) {
  const push = w.knobs.editLog.push.bind(w.knobs.editLog);
  w.knobs.editLog.push = (...entries) => {
    for (const entry of entries) {
      w.emitted.push({ event: "edit-log-line", payload: entry, userId: null, admins: false });
    }
    return push(...entries);
  };
}

/**
 * Where in `w.emitted` the line `logEvent` and the first `job-updated` with `state` are.
 * @param {ReturnType<typeof createManagerWorld>} w
 * @param {string} logEvent
 * @param {string} state
 */
function order(w, logEvent, state) {
  return {
    line: w.emitted.findIndex((e) => e.event === "edit-log-line" && e.payload.event === logEvent),
    news: w.emitted.findIndex((e) => e.event === "job-updated" && e.payload.state === state),
  };
}

/** A render that ends the way the test says when it is stopped or finished. */
function runnerEnding(/** @type {"completed" | "stopped"} */ onStop) {
  /** @type {(state: "completed" | "stopped") => void} */
  let end = () => {};
  let called = false;
  return {
    /** The state is "running" a moment before the runner is asked: wait for this one. */
    called: () => called,
    run() {
      called = true;
      const done = new Promise((resolve) => {
        end = (state) =>
          resolve({
            state,
            error: null,
            sessionId: null,
            costUsd: null,
            activeMs: 5,
            deliverable: state === "completed" ? "final.mp4" : null,
          });
      });
      return { done, stop: () => end(onStop) };
    },
    finish: () => end("completed"),
  };
}

test("an edit: Started and Finished name the program", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice);
  w.writesProject(v.projectDir);
  const view = await w.call(w.alice, "startEdit", { videoId: v.videoId });
  await w.waitFor(view.id, "completed");
  assert.deepEqual(await lines(w, 2), [
    "started: Started (Claude Code)",
    "completed: Finished (Claude Code)",
  ]);
});

test("a Re-Edit: its own start line, the same finish line", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice, { project: true });
  w.writesProject(v.projectDir);
  const view = await w.call(w.alice, "reEdit", { videoId: v.videoId, text: "Make it faster" });
  await w.waitFor(view.id, "completed");
  assert.deepEqual(await lines(w, 2), [
    "started: Re-Edit started (Claude Code)",
    "completed: Finished (Claude Code)",
  ]);
});

test("a change request: an agent does it, so the program is named", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice, { project: true });
  w.writesProject(v.projectDir);
  await w.timeline.rpc
    .find((f) => f.name === "addTimelineNote")
    ?.handler(
      { videoId: v.videoId, frame: 5, shape: null, elementId: null, prompt: "Make it bigger" },
      /** @type {never} */ (w.ctxOf(w.alice)),
    );
  await until(() => w.db.get("SELECT id FROM jobs WHERE kind = 'timelineEdit'") !== undefined);
  const id = String(w.db.get("SELECT id FROM jobs WHERE kind = 'timelineEdit'")?.["id"]);
  await w.waitFor(id, "completed");
  assert.deepEqual(await lines(w, 2), [
    "started: Change request started (Claude Code)",
    "completed: Finished (Claude Code)",
  ]);
});

test("a stopped edit and a paused one: no program in the line", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice);
  w.writesProject(v.projectDir);
  w.scenario("slow");
  const view = await w.call(w.alice, "startEdit", { videoId: v.videoId });
  await until(() => w.sessionOf(v.key) !== null);
  await w.call(w.alice, "pauseJob", { jobId: view.id });
  await w.waitFor(view.id, "paused");
  await w.call(w.alice, "continueJob", { jobId: view.id });
  await until(() => w.stateOf(view.id) === "running");
  await w.call(w.alice, "stopJob", { jobId: view.id });
  await w.waitFor(view.id, "stopped");
  assert.deepEqual(await lines(w, 4), [
    "started: Started (Claude Code)",
    "paused: Paused",
    "continued: Continued",
    "stopped: Stopped",
  ]);
});

test("the line of an end is written before the page is told that the job ended", async (t) => {
  const w = createManagerWorld(t);
  interleaveLogWithEvents(w);
  const v = await w.videoOf(w.alice);
  w.writesProject(v.projectDir);
  w.scenario("slow");
  const view = await w.call(w.alice, "startEdit", { videoId: v.videoId });
  await until(() => w.sessionOf(v.key) !== null);
  await w.call(w.alice, "pauseJob", { jobId: view.id });
  await w.waitFor(view.id, "paused");
  // A page that reloads the log on `job-updated` must already find the line, and an end that is
  // logged late would let the next Continue write "Continued" ahead of "Paused".
  const paused = order(w, "paused", "paused");
  assert.ok(paused.line >= 0, "the Paused line was written when the job was paused");
  assert.ok(paused.news === -1 || paused.line < paused.news, "Paused is written before the news");
  await w.call(w.alice, "continueJob", { jobId: view.id });
  await w.call(w.alice, "stopJob", { jobId: view.id });
  await w.waitFor(view.id, "stopped");
  const stopped = order(w, "stopped", "stopped");
  assert.ok(stopped.line >= 0);
  assert.ok(stopped.news === -1 || stopped.line < stopped.news, "Stopped is written first");
  assert.deepEqual(
    w.knobs.editLog.map((e) => e.event),
    ["started", "paused", "continued", "stopped"],
  );
});

test("a finished edit: the Finished line comes before the job-updated that says completed", async (t) => {
  const w = createManagerWorld(t);
  interleaveLogWithEvents(w);
  const v = await w.videoOf(w.alice);
  w.writesProject(v.projectDir);
  const view = await w.call(w.alice, "startEdit", { videoId: v.videoId });
  await w.waitFor(view.id, "completed");
  // No waiting for the line: it exists in the same moment the state does.
  assert.deepEqual(
    w.knobs.editLog.map((e) => e.event),
    ["started", "completed"],
  );
  await until(() => order(w, "completed", "completed").news >= 0);
  const done = order(w, "completed", "completed");
  assert.ok(done.line < done.news, "the line is written before the page is told");
});

test("a waiting edit that is stopped: Stopped is logged at once", async (t) => {
  const w = createManagerWorld(t);
  w.settings.update({ maxEdits: 1 });
  const a = await w.videoOf(w.alice, { folder: "001 A" });
  const b = await w.videoOf(w.alice, { folder: "002 B", channelName: "Two" });
  w.scenario("slow");
  const first = await w.call(w.alice, "startEdit", { videoId: a.videoId });
  const second = await w.call(w.alice, "startEdit", { videoId: b.videoId });
  await until(() => w.stateOf(first.id) === "running");
  assert.equal(w.stateOf(second.id), "queued");
  await w.call(w.alice, "stopJob", { jobId: second.id });
  // Nothing awaited: the line is there when the call returns.
  assert.deepEqual(
    w.knobs.editLog.map((e) => e.event),
    ["started", "stopped"],
  );
  await w.call(w.alice, "stopJob", { jobId: first.id });
  await w.waitFor(first.id, "stopped");
});

test("a render: Render started, Render finished, never a program", async (t) => {
  const runner = runnerEnding("completed");
  const w = createManagerWorld(t, { renderRunner: runner });
  const v = await w.videoOf(w.alice, { project: true });
  const view = w.jobs.api.enqueue({
    videoKey: v.key,
    userId: w.alice.id,
    kind: "render",
    videoType: "long",
    request: { resolution: 1080 },
  });
  await until(() => runner.called());
  runner.finish();
  await w.waitFor(view.id, "completed");
  assert.deepEqual(await lines(w, 2), ["started: Render started", "completed: Render finished"]);
});

test("a stopped render says Stopped and a failed one Needs attention, without a program", async (t) => {
  const runner = runnerEnding("stopped");
  const w = createManagerWorld(t, { renderRunner: runner });
  const v = await w.videoOf(w.alice, { project: true });
  const view = w.jobs.api.enqueue({
    videoKey: v.key,
    userId: w.alice.id,
    kind: "render",
    videoType: "long",
    request: { resolution: 1080 },
  });
  await until(() => runner.called());
  await w.call(w.alice, "stopJob", { jobId: view.id });
  await w.waitFor(view.id, "stopped");
  assert.deepEqual(await lines(w, 2), ["started: Render started", "stopped: Stopped"]);

  // The same render without any runner fails with a sentence.
  const w2 = createManagerWorld(t);
  const v2 = await w2.videoOf(w2.alice, { project: true });
  const failed = w2.jobs.api.enqueue({
    videoKey: v2.key,
    userId: w2.alice.id,
    kind: "render",
    videoType: "long",
    request: { resolution: 1080 },
  });
  await w2.waitFor(failed.id, "failed");
  const got = await lines(w2, 2);
  assert.equal(got[0], "started: Render started");
  assert.match(got[1] ?? "", /^failed: Needs attention: .+/);
  assert.ok(!/Claude|OpenCode/.test(got.join("\n")), "no program is named");
});

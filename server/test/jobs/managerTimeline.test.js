import assert from "node:assert/strict";
import { test } from "node:test";
import { rejectsCode } from "../library/support.js";
import { NOTE_STOPPED } from "../../src/jobs/managerOutcome.js";
import { createManagerWorld, until } from "./managerSupport.js";

test("a change request starts a timeline edit that takes the pending notes", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice, { project: true });
  w.writesProject(v.projectDir);
  await w.timeline.rpc
    .find((f) => f.name === "addTimelineNote")
    ?.handler(
      {
        videoId: v.videoId,
        frame: 5,
        shape: null,
        elementId: null,
        prompt: "Make the title bigger",
      },
      /** @type {never} */ (w.ctxOf(w.alice)),
    );
  await until(() => w.db.get("SELECT id FROM jobs WHERE kind = 'timelineEdit'") !== undefined);
  const row = w.db.get("SELECT id FROM jobs WHERE kind = 'timelineEdit'");
  const id = String(row?.["id"]);
  await w.waitFor(id, "completed");
  assert.equal((await w.timeline.api.latestRevision(v.key))?.label, "Change request");
  assert.equal((await w.timeline.api.pendingNotes(v.key)).length, 0);
  const notes = w.db.all("SELECT state FROM notes");
  assert.deepEqual(
    notes.map((n) => n["state"]),
    ["done"],
  );
});

test("a request for a video with an active job waits", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice, { project: true });
  w.scenario("slow");
  const first = await w.call(w.alice, "reEdit", { videoId: v.videoId, text: "Change it" });
  await until(() => w.stateOf(first.id) === "running");
  assert.equal(await w.jobs.api.requestTimelineEdit({ videoKey: v.key, userId: w.alice.id }), null);
  assert.equal(w.jobs.api.activeJob(v.key)?.id, first.id);
  await w.call(w.alice, "stopJob", { jobId: first.id });
  await w.waitFor(first.id, "stopped");
  assert.equal(w.jobs.api.activeJob(v.key), null);
  const view = await w.jobs.api.requestTimelineEdit({ videoKey: v.key, userId: w.alice.id });
  assert.equal(view?.kind, "timelineEdit");
  await w.call(w.alice, "stopJob", { jobId: String(view?.id) });
});

test("a render goes through the injected runner and cannot be paused", async (t) => {
  /** @type {any[]} */
  const seen = [];
  /** @type {() => void} */
  let finish = () => {};
  const renderRunner = {
    run(/** @type {any} */ job, /** @type {any} */ facts) {
      seen.push({ job, facts });
      const done = new Promise((resolve) => {
        finish = () =>
          resolve({
            state: "completed",
            error: null,
            sessionId: null,
            costUsd: null,
            activeMs: 5,
            deliverable: "final.mp4",
          });
      });
      return { done, stop: () => finish() };
    },
  };
  const w = createManagerWorld(t, { renderRunner });
  const v = await w.videoOf(w.alice, { project: true });
  const view = w.jobs.api.enqueue({
    videoKey: v.key,
    userId: w.alice.id,
    kind: "render",
    videoType: "long",
    request: { resolution: 2160 },
  });
  await until(() => seen.length === 1);
  assert.equal(seen[0].facts.resolution, 2160);
  assert.equal(seen[0].facts.folderName, "001 A");
  await rejectsCode(w.call(w.alice, "pauseJob", { jobId: view.id }), "conflict");
  finish();
  await w.waitFor(view.id, "completed");
});

test("a render without a runner fails with a sentence", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice, { project: true });
  const view = w.jobs.api.enqueue({
    videoKey: v.key,
    userId: w.alice.id,
    kind: "render",
    videoType: "long",
    request: { resolution: 1080 },
  });
  await w.waitFor(view.id, "failed");
  assert.match(
    String(w.db.get("SELECT error FROM jobs WHERE id = ?", view.id)?.["error"]),
    /not available/,
  );
});

test("the server's project check is what the driver sends back to the agent", async (t) => {
  // The driver's own tests pin down "twice, then failed" (the fake does not answer a fix request).
  const w = createManagerWorld(t, {
    runLint: async () => ({ errors: ["A clip has no track."], problem: null }),
  });
  const v = await w.videoOf(w.alice);
  w.writesProject(v.projectDir);
  const view = await w.call(w.alice, "startEdit", { videoId: v.videoId });
  const asked = () =>
    w.jobs.api.logStore
      .read(view.id)
      .some((e) => /asked to fix it \(1 of 2\)/.test(String(e.text)));
  await until(asked);
  await w.call(w.alice, "stopJob", { jobId: view.id });
  await w.waitFor(view.id, "stopped");
});

test("a job recovered without a session is stopped, one with a session paused", async (t) => {
  const w = createManagerWorld(t);
  const a = await w.videoOf(w.alice, { folder: "001 A", channelName: "N1" });
  const b = await w.videoOf(w.alice, { folder: "002 B", channelName: "N2" });
  w.db.run(
    `INSERT INTO jobs (id, video_id, user_id, kind, queue, state, joined_at, video_type, harness, setup)
     VALUES ('j-a', ?, ?, 'edit', 'edits', 'running', 1, 'long', 'claudeCode', 'claudeSubscription'),
            ('j-b', ?, ?, 'edit', 'edits', 'running', 2, 'long', 'claudeCode', 'claudeSubscription')`,
    a.key,
    w.alice.id,
    b.key,
    w.alice.id,
  );
  w.library.api.videos.setSession(b.key, "sess-b", "claudeCode");
  await w.jobs.start();
  assert.equal(w.stateOf("j-a"), "stopped");
  assert.equal(w.stateOf("j-b"), "paused");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(w.stateOf("j-b"), "paused");
});

/**
 * Adds a change request and returns the id of the timeline edit it started.
 * @param {ReturnType<typeof createManagerWorld>} w
 * @param {Awaited<ReturnType<ReturnType<typeof createManagerWorld>["videoOf"]>>} v
 */
async function requestChange(w, v) {
  await w.timeline.rpc
    .find((f) => f.name === "addTimelineNote")
    ?.handler(
      { videoId: v.videoId, frame: 5, shape: null, elementId: null, prompt: "Make it bigger" },
      /** @type {never} */ (w.ctxOf(w.alice)),
    );
  await until(() => w.db.get("SELECT id FROM jobs WHERE kind = 'timelineEdit'") !== undefined);
  return String(w.db.get("SELECT id FROM jobs WHERE kind = 'timelineEdit'")?.["id"]);
}

test("a change request of a failed job keeps the sentence of the job", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice, { project: true });
  w.writesProject(v.projectDir);
  w.scenario("crash");
  const id = await requestChange(w, v);
  await w.waitFor(id, "failed");
  // The job stores its error as JSON `{ "message": ... }`; the note holds the sentence itself.
  const stored = String(w.db.get("SELECT error FROM jobs WHERE id = ?", id)?.["error"]);
  const jobError = JSON.parse(stored).message;
  assert.match(jobError, /stopped unexpectedly/);
  const note = w.db.get("SELECT state, error FROM notes");
  assert.deepEqual([note?.["state"], note?.["error"]], ["failed", jobError]);
});

test("a change request of a stopped job says the edit was stopped", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice, { project: true });
  w.writesProject(v.projectDir);
  w.scenario("slow");
  const id = await requestChange(w, v);
  await until(() => w.stateOf(id) === "running");
  await w.call(w.alice, "stopJob", { jobId: id });
  await w.waitFor(id, "stopped");
  const note = w.db.get("SELECT state, error FROM notes");
  assert.deepEqual([note?.["state"], note?.["error"]], ["failed", NOTE_STOPPED]);
});

test("a change request of a completed job has no error", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice, { project: true });
  w.writesProject(v.projectDir);
  const id = await requestChange(w, v);
  await w.waitFor(id, "completed");
  const note = w.db.get("SELECT state, error FROM notes");
  assert.deepEqual([note?.["state"], note?.["error"]], ["done", null]);
});

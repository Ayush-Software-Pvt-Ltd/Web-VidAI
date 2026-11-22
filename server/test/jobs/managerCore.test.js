import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { rejectsCode } from "../library/support.js";
import { createManagerWorld, until } from "./managerSupport.js";

const FIXTURE_INDEX = fs.readFileSync(
  path.join(import.meta.dirname, "../support/fixtures/projects/long/index.html"),
  "utf8",
);

test("a new edit runs to the end, saves a revision and remembers the session", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice);
  w.writesProject(v.projectDir);
  const view = await w.call(w.alice, "startEdit", { videoId: v.videoId, urgent: false });
  assert.equal(view.kind, "edit");
  await w.waitFor(view.id, "completed");
  assert.equal(fs.existsSync(path.join(v.projectDir, "index.html")), true);
  assert.equal((await w.timeline.api.latestRevision(v.key))?.label, "Edit");
  assert.notEqual(w.sessionOf(v.key), null);
  assert.ok(w.knobs.ended.includes(view.id));
  assert.deepEqual(
    w.knobs.editLog.map((e) => e.event),
    ["started", "completed"],
  );
});

test("refusals are plain sentences", async (t) => {
  const w = createManagerWorld(t);
  const noAroll = await w.videoOf(w.alice, { folder: "002 B", aroll: false, channelName: "N1" });
  await rejectsCode(w.call(w.alice, "startEdit", { videoId: noAroll.videoId }), "invalidInput");
  const done = await w.videoOf(w.alice, { folder: "003 C", project: true, channelName: "N2" });
  await rejectsCode(w.call(w.alice, "startEdit", { videoId: done.videoId }), "conflict");
  const fresh = await w.videoOf(w.alice, { folder: "004 D", channelName: "N3" });
  await rejectsCode(
    w.call(w.alice, "reEdit", { videoId: fresh.videoId, text: "Change it" }),
    "conflict",
  );
  await rejectsCode(
    w.call(w.alice, "reEdit", { videoId: done.videoId, text: "   " }),
    "invalidInput",
  );
  w.knobs.notReady.add("claudeSubscription");
  await rejectsCode(w.call(w.alice, "startEdit", { videoId: fresh.videoId }), "notReady");
});

test("a video with an active job refuses a second edit", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice);
  w.scenario("slow");
  const view = await w.call(w.alice, "startEdit", { videoId: v.videoId, urgent: false });
  await rejectsCode(w.call(w.alice, "startEdit", { videoId: v.videoId }), "conflict");
  await w.call(w.alice, "stopJob", { jobId: view.id });
  await w.waitFor(view.id, "stopped");
});

test("a failed Re-Edit puts the project back", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice, { project: true });
  w.writesProject(v.projectDir);
  w.scenario("crash");
  const view = await w.call(w.alice, "reEdit", { videoId: v.videoId, text: "Make it faster" });
  await w.waitFor(view.id, "failed");
  assert.equal(fs.readFileSync(path.join(v.projectDir, "index.html"), "utf8"), FIXTURE_INDEX);
  assert.match(String((await w.timeline.api.latestRevision(v.key))?.label), /^Restored/);
});

test("a Re-Edit saves a revision first and one after", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice, { project: true });
  w.writesProject(v.projectDir);
  const view = await w.call(w.alice, "reEdit", { videoId: v.videoId, text: "Make it faster" });
  await w.waitFor(view.id, "completed");
  assert.equal((await w.timeline.api.latestRevision(v.key))?.label, "Re-Edit");
});

test("pause keeps the session and Continue resumes it", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice);
  w.writesProject(v.projectDir);
  w.scenario("slow");
  const view = await w.call(w.alice, "startEdit", { videoId: v.videoId, urgent: false });
  await until(() => w.sessionOf(v.key) !== null);
  const session = w.sessionOf(v.key);
  await w.call(w.alice, "pauseJob", { jobId: view.id });
  await w.waitFor(view.id, "paused");
  assert.equal(w.sessionOf(v.key), session);
  w.scenario("complete");
  await w.call(w.alice, "continueJob", { jobId: view.id });
  await w.waitFor(view.id, "completed");
  assert.equal(w.sessionOf(v.key), session);
});

test("a queued job stops at once and an admin may stop another user's job", async (t) => {
  const w = createManagerWorld(t);
  w.settings.update({ maxEdits: 1 });
  const a = await w.videoOf(w.alice, { folder: "001 A" });
  const b = await w.videoOf(w.alice, { folder: "002 B", channelName: "Two" });
  w.scenario("slow");
  const first = await w.call(w.alice, "startEdit", { videoId: a.videoId });
  const second = await w.call(w.alice, "startEdit", { videoId: b.videoId });
  await until(() => w.stateOf(first.id) === "running");
  assert.equal(w.stateOf(second.id), "queued");
  await rejectsCode(w.call(w.bob, "stopJob", { jobId: second.id }), "notFound");
  await w.call(w.admin, "stopJob", { jobId: second.id });
  assert.equal(w.stateOf(second.id), "stopped");
  await w.call(w.admin, "stopJob", { jobId: first.id });
  await w.waitFor(first.id, "stopped");
});

test("quit pauses a running job and the next start never goes on by itself", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice);
  w.scenario("slow");
  const view = await w.call(w.alice, "startEdit", { videoId: v.videoId });
  await until(() => w.sessionOf(v.key) !== null);
  await w.jobs.stop();
  assert.equal(w.stateOf(view.id), "paused");
  await w.jobs.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(w.stateOf(view.id), "paused");
});

test("a disabled user's jobs are stopped", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice);
  w.scenario("slow");
  const view = await w.call(w.alice, "startEdit", { videoId: v.videoId });
  await until(() => w.stateOf(view.id) === "running");
  assert.equal(w.jobs.hooks.activeJobCount(w.alice.id), 1);
  await w.jobs.hooks.onUserDisabled(w.alice.id);
  assert.equal(w.stateOf(view.id), "stopped");
  assert.equal(w.jobs.hooks.activeJobCount(w.alice.id), 0);
});

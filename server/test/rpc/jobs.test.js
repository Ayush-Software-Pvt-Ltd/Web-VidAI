import assert from "node:assert/strict";
import { test } from "node:test";
import { rejectsCode } from "../library/support.js";
import { createManagerWorld, until } from "../jobs/managerSupport.js";

test("input is checked before anything happens", async (t) => {
  const w = createManagerWorld(t);
  await rejectsCode(w.call(w.alice, "startEdit", {}), "invalidInput");
  await rejectsCode(w.call(w.alice, "startEdit", { videoId: "a/b", extra: 1 }), "invalidInput");
  await rejectsCode(w.call(w.alice, "reEdit", { videoId: "a/b", text: "" }), "invalidInput");
  await rejectsCode(
    w.call(w.alice, "reEdit", { videoId: "a/b", text: "x".repeat(8001) }),
    "invalidInput",
  );
  await rejectsCode(w.call(w.alice, "pauseJob", { jobId: 5 }), "invalidInput");
  await rejectsCode(w.call(w.alice, "getJobLog", { jobId: "j", after: -1 }), "invalidInput");
});

test("a video or job of someone else answers not found", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice);
  await rejectsCode(w.call(w.bob, "startEdit", { videoId: v.videoId }), "notFound");
  await rejectsCode(w.call(w.alice, "pauseJob", { jobId: "missing" }), "notFound");
  await rejectsCode(w.call(w.alice, "continueJob", { jobId: "missing" }), "notFound");
  await rejectsCode(w.call(w.alice, "stopJob", { jobId: "missing" }), "notFound");
  await rejectsCode(w.call(w.alice, "getJobLog", { jobId: "missing" }), "notFound");
});

test("every function works for the owner and the log can be read from a point", async (t) => {
  const w = createManagerWorld(t);
  const v = await w.videoOf(w.alice);
  w.writesProject(v.projectDir);
  w.scenario("slow");
  const view = await w.call(w.alice, "startEdit", { videoId: v.videoId, urgent: true });
  assert.equal(view.urgent, true);
  await until(() => w.sessionOf(v.key) !== null);
  await rejectsCode(w.call(w.alice, "continueJob", { jobId: view.id }), "conflict");
  const paused = await w.call(w.alice, "pauseJob", { jobId: view.id });
  assert.equal(paused.state, "pausing");
  await rejectsCode(w.call(w.alice, "pauseJob", { jobId: view.id }), "conflict");
  await w.waitFor(view.id, "paused");
  const log = await w.call(w.alice, "getJobLog", { jobId: view.id });
  assert.equal(log.jobId, view.id);
  assert.ok(log.entries.length > 0);
  const last = log.entries[log.entries.length - 1].seq;
  const later = await w.call(w.alice, "getJobLog", { jobId: view.id, after: last });
  assert.equal(later.entries.length, 0);
  const stopped = await w.call(w.admin, "stopJob", { jobId: view.id });
  assert.equal(stopped.state, "stopped");
  await rejectsCode(w.call(w.alice, "stopJob", { jobId: view.id }), "conflict");
});

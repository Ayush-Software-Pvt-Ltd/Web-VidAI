import assert from "node:assert/strict";
import { test } from "node:test";
import { computeActions, isActiveState } from "../../src/library/actions.js";

/**
 * @param {Partial<Parameters<typeof computeActions>[0]> & { state?: import("../../../src/lib/wire/jobs.ts").JobState | null, startsAt?: number | null }} [options]
 */
function actions({ state = null, startsAt = null, ...facts } = {}) {
  return computeActions({
    job: state === null ? null : { state, startsAt },
    edited: false,
    uploading: false,
    workingFiles: false,
    admin: false,
    ...facts,
  });
}

test("a video with no job: startEdit, or reEdit and renderFinal when edited", () => {
  assert.deepEqual(actions(), ["startEdit", "upload"]);
  assert.deepEqual(actions({ edited: true }), [
    "reEdit",
    "renderFinal",
    "review",
    "upload",
    "archive",
  ]);
  for (const state of /** @type {const} */ (["stopped", "completed"])) {
    assert.deepEqual(actions({ state }), ["startEdit", "upload"]);
    assert.deepEqual(actions({ state, edited: true }), [
      "reEdit",
      "renderFinal",
      "review",
      "upload",
      "archive",
    ]);
  }
});

test("queued: stop, and startNow only for an admin and only while held by the start delay", () => {
  assert.deepEqual(actions({ state: "queued" }), ["stop", "upload"]);
  assert.deepEqual(actions({ state: "queued", startsAt: 5 }), ["stop", "upload"]);
  assert.deepEqual(actions({ state: "queued", admin: true }), ["stop", "upload"]);
  assert.deepEqual(actions({ state: "queued", startsAt: 5, admin: true }), [
    "startNow",
    "stop",
    "upload",
  ]);
});

test("running, pausing, paused and stopping follow the job", () => {
  assert.deepEqual(actions({ state: "running" }), ["pause", "stop", "upload"]);
  assert.deepEqual(actions({ state: "pausing" }), ["upload"]);
  assert.deepEqual(actions({ state: "stopping" }), ["upload"]);
  assert.deepEqual(actions({ state: "paused" }), ["continue", "stop", "upload"]);
});

test("review is offered also while a job is active, when a project exists", () => {
  assert.deepEqual(actions({ state: "running", edited: true }), [
    "pause",
    "stop",
    "review",
    "upload",
  ]);
  assert.deepEqual(actions({ state: "paused", edited: true }), [
    "continue",
    "stop",
    "review",
    "upload",
  ]);
});

test("a failed job: continue plus start or re-edit, and archive", () => {
  assert.deepEqual(actions({ state: "failed" }), ["continue", "startEdit", "upload", "archive"]);
  assert.deepEqual(actions({ state: "failed", edited: true }), [
    "continue",
    "reEdit",
    "renderFinal",
    "review",
    "upload",
    "archive",
  ]);
});

test("diskCleanup needs working files and no active job", () => {
  assert.deepEqual(actions({ workingFiles: true }), ["startEdit", "upload", "diskCleanup"]);
  assert.deepEqual(actions({ state: "running", workingFiles: true }), ["pause", "stop", "upload"]);
  assert.deepEqual(actions({ state: "completed", workingFiles: true, edited: true }), [
    "reEdit",
    "renderFinal",
    "review",
    "upload",
    "diskCleanup",
    "archive",
  ]);
});

test("archive needs no active job and an edited video or a failed job", () => {
  assert.ok(!actions().includes("archive"));
  assert.ok(!actions({ state: "completed" }).includes("archive"));
  assert.ok(actions({ state: "failed" }).includes("archive"));
  assert.ok(actions({ edited: true }).includes("archive"));
  for (const state of /** @type {const} */ ([
    "queued",
    "running",
    "pausing",
    "paused",
    "stopping",
  ])) {
    assert.ok(!actions({ state, edited: true }).includes("archive"), state);
  }
});

test("an upload in progress removes startEdit and nothing else", () => {
  assert.deepEqual(actions({ uploading: true }), ["upload"]);
  assert.deepEqual(actions({ state: "failed", uploading: true }), [
    "continue",
    "upload",
    "archive",
  ]);
  assert.deepEqual(actions({ edited: true, uploading: true }), [
    "reEdit",
    "renderFinal",
    "review",
    "upload",
    "archive",
  ]);
});

test("an archived video offers only unarchive", () => {
  assert.deepEqual(actions({ archived: true, edited: true, workingFiles: true }), ["unarchive"]);
});

test("isActiveState", () => {
  for (const state of /** @type {const} */ ([
    "queued",
    "running",
    "pausing",
    "paused",
    "stopping",
  ])) {
    assert.equal(isActiveState(state), true, state);
  }
  for (const state of /** @type {const} */ (["completed", "failed", "stopped"])) {
    assert.equal(isActiveState(state), false, state);
  }
  assert.equal(isActiveState(null), false);
  assert.equal(isActiveState(undefined), false);
});

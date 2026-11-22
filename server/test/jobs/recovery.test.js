// Recovery after a restart (docs/SPEC.md section 8, "Recovery").

import test from "node:test";
import assert from "node:assert/strict";
import { createQueueHarness, MIN } from "./queueSupport.js";

/**
 * Makes a job straight in a state, as a crashed server would have left it.
 * @param {ReturnType<typeof createQueueHarness>} h
 * @param {number} n Video vN.
 * @param {import("../../../src/lib/wire/jobs.ts").JobState} state
 * @param {import("../../../src/lib/wire/jobs.ts").JobKind} [kind]
 */
function leftBehind(h, n, state, kind = "edit") {
  const job = h.jobs.create({
    videoKey: `v${n}`,
    userId: "u1",
    kind,
    videoType: "long",
    state: state === "running" ? "running" : "queued",
    joinedAt: n,
  });
  if (state !== "running" && state !== "queued") {
    assert.ok(h.jobs.transition(job.id, ["queued"], state));
  }
  return job;
}

/** @param {string[]} withSession video keys that have a session */
function harness(withSession = []) {
  return createQueueHarness({
    settings: { maxEdits: 2 },
    sessionOf: (key) => (withSession.includes(key) ? `session-${key}` : null),
  });
}

test("running, pausing and stopping agent jobs with a session become paused", () => {
  const h = harness(["v1", "v2", "v3"]);
  const running = leftBehind(h, 1, "running");
  const pausing = leftBehind(h, 2, "pausing");
  const stopping = leftBehind(h, 3, "stopping");
  const changed = h.service.start();
  assert.deepEqual(
    changed.map((c) => [c.job.id, c.previousState, c.job.state]),
    [
      [running.id, "running", "paused"],
      [pausing.id, "pausing", "paused"],
      [stopping.id, "stopping", "paused"],
    ],
  );
  for (const job of [running, pausing, stopping]) assert.equal(h.jobs.get(job.id)?.state, "paused");
});

test("agent jobs without a session become stopped", () => {
  const h = harness();
  const jobs = [
    leftBehind(h, 1, "running"),
    leftBehind(h, 2, "pausing", "reEdit"),
    leftBehind(h, 3, "stopping", "timelineEdit"),
  ];
  h.service.start();
  for (const job of jobs) {
    const row = h.jobs.get(job.id);
    assert.equal(row?.state, "stopped");
    assert.ok(row?.endedAt !== null);
  }
});

test("every render becomes stopped, even when the video has a session", () => {
  const h = harness(["v1", "v2", "v3"]);
  const renders = [
    leftBehind(h, 1, "running", "render"),
    leftBehind(h, 2, "pausing", "render"),
    leftBehind(h, 3, "stopping", "render"),
  ];
  h.service.start();
  for (const job of renders) assert.equal(h.jobs.get(job.id)?.state, "stopped");
});

test("a timeline change with a session is paused too", () => {
  const h = harness(["v1"]);
  const job = leftBehind(h, 1, "running", "timelineEdit");
  h.service.start();
  assert.equal(h.jobs.get(job.id)?.state, "paused");
});

test("paused, ended and queued jobs are not changed by recovery itself", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1 }, sessionOf: () => "s" });
  const paused = leftBehind(h, 1, "paused");
  const done = leftBehind(h, 2, "completed");
  const failed = leftBehind(h, 3, "failed");
  const stopped = leftBehind(h, 4, "stopped");
  const queued = leftBehind(h, 5, "queued");
  const before = [paused, done, failed, stopped].map((j) => h.jobs.get(j.id));
  const changed = h.service.start();
  assert.deepEqual(changed, []);
  assert.deepEqual(
    [paused, done, failed, stopped].map((j) => h.jobs.get(j.id)),
    before,
  );
  // The queued job starts at once, since recovery freed every slot.
  assert.equal(h.jobs.get(queued.id)?.state, "running");
});

test("queued jobs keep their place and start in order, after recovery freed the slots", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1 }, sessionOf: () => null });
  const runner = leftBehind(h, 1, "running");
  const a = leftBehind(h, 2, "queued");
  const b = leftBehind(h, 3, "queued");
  const urgent = h.jobs.create({
    videoKey: "v4",
    userId: "u1",
    kind: "edit",
    videoType: "long",
    urgent: true,
    joinedAt: 99,
  });
  h.service.start();
  assert.equal(h.jobs.get(runner.id)?.state, "stopped");
  assert.deepEqual(
    h.launched.map((j) => j.id),
    [urgent.id],
    "Urgent first, as before the restart",
  );
  assert.deepEqual(
    [a, b].map((j) => h.service.view(/** @type {never} */ (h.jobs.get(j.id))).position),
    [1, 2],
  );
});

test("the time since the job last started running is not counted; earlier time is kept", () => {
  const h = harness(["v1", "v2"]);
  const job = leftBehind(h, 1, "running");
  h.clock.advance(5 * MIN);
  assert.ok(h.jobs.transition(job.id, ["running"], "paused"));
  h.clock.advance(MIN);
  assert.ok(h.jobs.transition(job.id, ["paused"], "queued"));
  assert.ok(h.jobs.transition(job.id, ["queued"], "running"));
  const second = leftBehind(h, 2, "running");
  const worked = h.jobs.get(job.id)?.activeMs;
  assert.equal(worked, 5 * MIN);

  h.clock.advance(10 * 60 * MIN); // the server was down for ten hours
  h.service.start();
  const row = h.jobs.get(job.id);
  assert.equal(row?.state, "paused");
  assert.equal(row?.activeMs, 5 * MIN);
  assert.equal(row?.runningSince, null);
  assert.equal(h.jobs.get(second.id)?.activeMs, 0);
});

test("recovered jobs are announced, and a recovered paused job can be continued", () => {
  const h = harness(["v1"]);
  const job = leftBehind(h, 1, "running");
  h.service.start();
  assert.equal(h.events("job-updated", job.id).at(-1)?.payload.state, "paused");
  const view = h.service.requeue(job.id);
  assert.equal(view.state, "running");
  assert.equal(h.launched.at(-1)?.resume, true);
});

test("the start delay survives a restart through the launches table", () => {
  const h = createQueueHarness({ settings: { maxEdits: 3, startDelayMinutes: 10 } });
  h.launches.record("edits", h.clock.now());
  h.clock.advance(MIN);
  const running = leftBehind(h, 1, "running");
  const queued = leftBehind(h, 2, "queued");
  h.service.start();
  // The runner is gone (stopped), nothing holds a slot: the delay is open at once.
  assert.equal(h.jobs.get(running.id)?.state, "stopped");
  assert.equal(h.jobs.get(queued.id)?.state, "running");
});

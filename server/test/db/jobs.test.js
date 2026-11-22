// The `jobs` table repository (docs/SPEC.md sections 8 and 15).

import test from "node:test";
import assert from "node:assert/strict";
import { createJobsRepo, KEEP_ENDED_PER_VIDEO } from "../../src/db/jobs.js";
import { createClock, createJobsDb } from "./jobsSupport.js";

/** @param {{ videos?: number }} [options] */
function setup(options) {
  const clock = createClock();
  const { db } = createJobsDb({ clock, ...options });
  return { db, clock, jobs: createJobsRepo(db, { clock }) };
}

/** @param {Partial<import("../../src/db/jobs.js").NewJob>} [fields] @returns {import("../../src/db/jobs.js").NewJob} */
function fresh(fields = {}) {
  return { videoKey: "v1", userId: "u1", kind: "edit", videoType: "long", ...fields };
}

test("create makes a queued job in the queue its kind belongs to, with every fact set", () => {
  const { jobs, clock } = setup();
  const job = jobs.create(
    fresh({
      kind: "timelineEdit",
      urgent: true,
      setup: "opencodeGo",
      harness: "opencode2",
      model: "m",
      effort: "high",
      request: { changes: [1] },
      videoType: "short",
    }),
  );
  assert.equal(job.queue, "timeline");
  assert.equal(job.state, "queued");
  assert.equal(job.urgent, false, "Urgent exists only in the edit queue");
  assert.equal(job.joinedAt, clock.now());
  assert.deepEqual(
    { s: job.startedAt, e: job.endedAt, a: job.activeMs, r: job.runningSince, c: job.costUsd },
    { s: null, e: null, a: 0, r: null, c: null },
  );
  assert.deepEqual(job.request, { changes: [1] });
  assert.deepEqual(
    [job.setup, job.harness, job.model, job.effort, job.videoType],
    ["opencodeGo", "opencode2", "m", "high", "short"],
  );
  assert.deepEqual(
    [job.startNow, job.resume, job.retries, job.progress, job.error],
    [false, false, 0, null, null],
  );
  assert.deepEqual(jobs.get(job.id), job);
  assert.equal(jobs.get("nope"), undefined);
});

test("an edit keeps Urgent and the kinds map to their queues", () => {
  const { jobs } = setup();
  assert.equal(jobs.create(fresh({ urgent: true })).urgent, true);
  assert.equal(jobs.create(fresh({ videoKey: "v2", userId: "u2", kind: "reEdit" })).queue, "edits");
  assert.equal(
    jobs.create(fresh({ videoKey: "v3", userId: "u3", kind: "render" })).queue,
    "renders",
  );
});

test("a video has one active job: the second is refused with a sentence, a finished one does not count", () => {
  const { jobs } = setup();
  const first = jobs.create(fresh());
  assert.throws(
    () => jobs.create(fresh({ userId: "u2" })),
    (error) =>
      /** @type {{ code: string, message: string }} */ (error).code === "conflict" &&
      /** @type {Error} */ (error).message === "This video already has an edit in progress.",
  );
  assert.ok(jobs.transition(first.id, ["queued"], "stopped"));
  assert.equal(jobs.create(fresh()).state, "queued");
});

test("create refuses a video type that is neither long nor short", () => {
  const { jobs } = setup();
  assert.throws(
    () => jobs.create(fresh({ videoType: /** @type {never} */ ("wide") })),
    /long or short/,
  );
});

test("transition is guarded by the current state: of two requests only one wins", () => {
  const { jobs } = setup();
  const job = jobs.create(fresh({ state: "running" }));
  // Pause and Stop both looked at a running job; whoever writes first wins, the other is told.
  assert.equal(jobs.transition(job.id, ["running"], "pausing"), true);
  assert.equal(jobs.transition(job.id, ["running"], "stopping"), false);
  assert.equal(jobs.get(job.id)?.state, "pausing");
  assert.equal(jobs.transition(job.id, [], "paused"), false, "no allowed state: never");
  assert.equal(jobs.transition("missing", ["running"], "paused"), false);
  assert.equal(jobs.transition(job.id, ["running", "pausing"], "paused"), true);
});

test("a state that is not in the schema is refused by the database", () => {
  const { jobs } = setup();
  const job = jobs.create(fresh());
  assert.throws(
    () => jobs.transition(job.id, ["queued"], /** @type {never} */ ("dancing")),
    /CHECK/,
  );
});

test("running time: counted across pause and continue, the open stretch excluded", () => {
  const { jobs, clock } = setup();
  const job = jobs.create(fresh());
  clock.advance(5_000); // waiting time never counts
  assert.ok(jobs.transition(job.id, ["queued"], "running"));
  let row = jobs.get(job.id);
  assert.equal(row?.startedAt, clock.now());
  assert.equal(row?.runningSince, clock.now());
  assert.equal(row?.activeMs, 0);
  const firstStart = clock.now();

  clock.advance(3_000);
  assert.ok(jobs.transition(job.id, ["running"], "pausing"));
  row = jobs.get(job.id);
  assert.equal(row?.activeMs, 3_000);
  assert.equal(row?.runningSince, null);
  clock.advance(1_000); // pausing time is not work
  assert.ok(jobs.transition(job.id, ["pausing"], "paused"));
  clock.advance(60_000); // paused time is not work
  assert.ok(jobs.transition(job.id, ["paused"], "queued", { resume: true }));
  clock.advance(10_000);
  assert.ok(jobs.transition(job.id, ["queued"], "running"));
  row = jobs.get(job.id);
  assert.equal(row?.startedAt, firstStart, "a continue does not change when the job first ran");
  assert.equal(row?.activeMs, 3_000);
  assert.equal(row?.runningSince, clock.now());

  clock.advance(2_000);
  assert.ok(jobs.transition(job.id, ["running"], "completed"));
  row = jobs.get(job.id);
  assert.equal(row?.activeMs, 5_000);
  assert.equal(row?.runningSince, null);
  assert.equal(row?.endedAt, clock.now());
});

test("a patch on a job that stays running does not restart or lose its stretch", () => {
  const { jobs, clock } = setup();
  const job = jobs.create(fresh({ state: "running" }));
  clock.advance(4_000);
  assert.ok(jobs.transition(job.id, ["running"], "running", { costUsd: 0.5 }));
  const row = jobs.get(job.id);
  assert.equal(row?.runningSince, job.runningSince);
  assert.equal(row?.activeMs, 0);
  assert.equal(row?.costUsd, 0.5);
});

test("countTime false closes the stretch without adding it (recovery after a restart)", () => {
  const { jobs, clock } = setup();
  const job = jobs.create(fresh({ state: "running" }));
  clock.advance(8 * 3_600_000);
  assert.ok(jobs.transition(job.id, ["running"], "paused", {}, { countTime: false }));
  const row = jobs.get(job.id);
  assert.equal(row?.activeMs, 0);
  assert.equal(row?.runningSince, null);
});

test("a clock that moved backwards never subtracts time", () => {
  const { jobs, clock } = setup();
  const job = jobs.create(fresh({ state: "running" }));
  clock.advance(-10_000);
  assert.ok(jobs.transition(job.id, ["running"], "paused"));
  assert.equal(jobs.get(job.id)?.activeMs, 0);
});

test("ending a job sets endedAt, a patch can override it, and continuing a failed job clears it", () => {
  const { jobs, clock } = setup();
  const job = jobs.create(fresh({ state: "running" }));
  clock.advance(1_000);
  assert.ok(
    jobs.transition(job.id, ["running"], "failed", { error: "Claude usage limit reached." }),
  );
  let row = jobs.get(job.id);
  assert.equal(row?.endedAt, clock.now());
  assert.equal(row?.error, "Claude usage limit reached.");
  clock.advance(1_000);
  assert.ok(
    jobs.transition(job.id, ["failed"], "queued", { resume: true, endedAt: null, error: null }),
  );
  row = jobs.get(job.id);
  assert.deepEqual([row?.endedAt, row?.error, row?.resume], [null, null, true]);
  assert.ok(jobs.transition(job.id, ["queued"], "stopped", { endedAt: 42 }));
  assert.equal(jobs.get(job.id)?.endedAt, 42);
});

test("moving a job back to active while its video has another active job is a conflict, not a crash", () => {
  const { jobs } = setup();
  const old = jobs.create(fresh({ state: "running" }));
  assert.ok(jobs.transition(old.id, ["running"], "failed"));
  jobs.create(fresh());
  assert.throws(
    () => jobs.transition(old.id, ["failed"], "queued"),
    (error) => /** @type {{ code: string }} */ (error).code === "conflict",
  );
  assert.equal(jobs.get(old.id)?.state, "failed");
});

test("setUrgent and setStartNow only touch waiting edits", () => {
  const { jobs } = setup();
  const edit = jobs.create(fresh());
  const render = jobs.create(fresh({ videoKey: "v2", userId: "u2", kind: "render" }));
  assert.equal(jobs.setUrgent(edit.id, true), true);
  assert.equal(jobs.get(edit.id)?.urgent, true);
  assert.equal(jobs.setStartNow(edit.id, true), true);
  assert.equal(jobs.get(edit.id)?.startNow, true);
  assert.equal(jobs.setUrgent(render.id, true), false);
  assert.equal(jobs.setStartNow(render.id, true), false);
  assert.ok(jobs.transition(edit.id, ["queued"], "running"));
  assert.equal(jobs.setUrgent(edit.id, false), false);
  assert.equal(jobs.setStartNow(edit.id, false), false);
  assert.equal(jobs.get(edit.id)?.urgent, true);
});

test("progress, error, cost and retries are stored and read back", () => {
  const { jobs } = setup();
  const job = jobs.create(fresh({ state: "running" }));
  const progress = { percent: 40, stage: "Transcribing", secondsLeft: 120 };
  assert.equal(jobs.setProgress(job.id, progress), true);
  assert.equal(jobs.setError(job.id, "A sentence."), true);
  assert.equal(jobs.setCost(job.id, 1.25), true);
  assert.equal(jobs.addRetry(job.id), 1);
  assert.equal(jobs.addRetry(job.id), 2);
  const row = jobs.get(job.id);
  assert.deepEqual(
    [row?.progress, row?.error, row?.costUsd, row?.retries],
    [progress, "A sentence.", 1.25, 2],
  );
  assert.equal(jobs.setError(job.id, null), true);
  assert.equal(jobs.get(job.id)?.error, null);
  assert.equal(jobs.setProgress("missing", null), false);
  assert.equal(jobs.addRetry("missing"), null);
});

test("waiting, running and per-user counts are per queue, and running means holding a slot", () => {
  const { jobs, clock } = setup({ videos: 8 });
  const a = jobs.create(fresh({ videoKey: "v1", userId: "u1" }));
  clock.advance(10);
  const b = jobs.create(fresh({ videoKey: "v2", userId: "u2", state: "running" }));
  clock.advance(10);
  const c = jobs.create(fresh({ videoKey: "v3", userId: "u3", kind: "reEdit" }));
  const d = jobs.create(fresh({ videoKey: "v4", userId: "u1", state: "running" }));
  const e = jobs.create(fresh({ videoKey: "v5", userId: "u2" }));
  assert.ok(jobs.transition(e.id, ["queued"], "stopping"));
  const f = jobs.create(fresh({ videoKey: "v6", userId: "u3", state: "running" }));
  assert.ok(jobs.transition(f.id, ["running"], "paused"));
  const render = jobs.create(fresh({ videoKey: "v7", userId: "u3", kind: "render" }));

  assert.deepEqual(
    jobs.waiting("edits").map((j) => j.id),
    [a.id, c.id],
  );
  assert.deepEqual(
    jobs
      .running("edits")
      .map((j) => j.id)
      .sort(),
    [b.id, d.id, e.id].sort(),
  );
  assert.deepEqual(
    jobs.waiting("renders").map((j) => j.id),
    [render.id],
  );
  assert.deepEqual(jobs.running("renders"), []);
  assert.deepEqual([...jobs.countRunningByUser("edits")].sort(), [
    ["u1", 1],
    ["u2", 2],
  ]);
  assert.equal(jobs.active().length, 7);
  assert.deepEqual(
    jobs
      .forUser("u3")
      .map((j) => j.id)
      .sort(),
    [c.id, f.id, render.id].sort(),
  );
});

test("latestForVideos gives the newest job of each video as a Map", () => {
  const { jobs } = setup();
  const old = jobs.create(fresh({ videoKey: "v1" }));
  assert.ok(jobs.transition(old.id, ["queued"], "stopped"));
  const newer = jobs.create(fresh({ videoKey: "v1" }));
  const other = jobs.create(fresh({ videoKey: "v2", userId: "u2" }));
  const latest = jobs.latestForVideos(["v1", "v2", "v3"]);
  assert.equal(latest.size, 2);
  assert.equal(latest.get("v1")?.id, newer.id);
  assert.equal(latest.get("v2")?.id, other.id);
  assert.equal(jobs.latestForVideos([]).size, 0);
});

test("latestForVideos copes with many keys", () => {
  const { jobs } = setup();
  const keys = Array.from({ length: 1200 }, (_, n) => `missing${n}`);
  keys.push("v1");
  jobs.create(fresh());
  assert.equal(jobs.latestForVideos(keys).size, 1);
});

test("history lists a video's jobs newest first, with a limit", () => {
  const { jobs } = setup();
  const ids = [];
  for (let n = 0; n < 4; n += 1) {
    const job = jobs.create(fresh());
    ids.push(job.id);
    jobs.transition(job.id, ["queued"], "stopped");
  }
  assert.deepEqual(
    jobs.history("v1", 3).map((j) => j.id),
    ids.slice().reverse().slice(0, 3),
  );
  assert.equal(jobs.history("v1").length, 4);
  assert.equal(jobs.history("v2").length, 0);
});

test("pruning keeps the newest 50 ended jobs of a video and never touches active or other videos' jobs", () => {
  const { jobs } = setup();
  const ids = [];
  for (let n = 0; n < KEEP_ENDED_PER_VIDEO + 5; n += 1) {
    ids.push(jobs.create(fresh({ state: "completed" })).id);
  }
  const active = jobs.create(fresh());
  const elsewhere = jobs.create(fresh({ videoKey: "v2", userId: "u2", state: "completed" }));
  const removed = jobs.pruneEnded("v1");
  assert.deepEqual(removed, ids.slice(0, 5).reverse());
  assert.equal(jobs.history("v1", 1000).length, KEEP_ENDED_PER_VIDEO + 1);
  assert.ok(jobs.get(active.id));
  assert.ok(jobs.get(elsewhere.id));
  assert.deepEqual(jobs.pruneEnded("v1"), []);
  assert.deepEqual(jobs.pruneEnded("v1", 10).length, KEEP_ENDED_PER_VIDEO - 10);
});

test("activeForVideo finds the one active job", () => {
  const { jobs } = setup();
  assert.equal(jobs.activeForVideo("v1"), undefined);
  const job = jobs.create(fresh());
  assert.equal(jobs.activeForVideo("v1")?.id, job.id);
  jobs.transition(job.id, ["queued"], "stopped");
  assert.equal(jobs.activeForVideo("v1"), undefined);
});

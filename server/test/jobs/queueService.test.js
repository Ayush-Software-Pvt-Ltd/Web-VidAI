// The queue service: which waiting job starts next, the launch hand-over, the start delay timer,
// settings changes and the events (docs/SPEC.md sections 8 and 14).

import test from "node:test";
import assert from "node:assert/strict";
import { eventsKickingOnSettings } from "../../src/jobs/queueService.js";
import { createQueueHarness, MIN } from "./queueSupport.js";

/** @param {Promise<unknown> | (() => unknown)} run @param {string} code */
function throwsCode(run, code) {
  assert.throws(
    /** @type {() => unknown} */ (run),
    (error) => /** @type {{ code?: string }} */ (error).code === code,
  );
}

test("an edit starts at once when a slot is free and launch gets it already running", () => {
  const h = createQueueHarness({ settings: { maxEdits: 2 } });
  const view = h.enqueue(1);
  assert.equal(h.launched.length, 1);
  assert.equal(h.launched[0].id, view.id);
  assert.equal(h.launched[0].state, "running");
  assert.equal(h.launched[0].resume, false);
  assert.equal(view.state, "running");
  assert.equal(view.position, null);
  assert.equal(view.runningSince, h.launches.last("edits"));
  assert.equal(h.launches.last("edits"), h.launched[0].startedAt, "a new session is a launch");
});

test("it waits when no slot is free, with a position, and starts on released", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1 } });
  const first = h.enqueue(1);
  const second = h.enqueue(2);
  const third = h.enqueue(3);
  assert.deepEqual([second.state, second.position, third.position], ["queued", 1, 2]);
  assert.equal(second.lastActivity, "Waiting for a free slot");
  assert.equal(h.launched.length, 1);

  h.end(first.id);
  assert.deepEqual(
    h.launched.map((j) => j.id),
    [first.id, second.id],
  );
  assert.equal(h.jobs.get(third.id)?.state, "queued");
  h.end(second.id, "failed");
  assert.equal(h.launched.length, 3);
});

test("a job stopped while it waited is never launched", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1 } });
  const first = h.enqueue(1);
  const second = h.enqueue(2);
  assert.ok(h.jobs.transition(second.id, ["queued"], "stopped"));
  h.end(first.id);
  assert.equal(h.launched.length, 1);
});

test("a launch that throws fails the job with the error's sentence and frees the slot", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1 } });
  let calls = 0;
  h.launch = () => {
    calls += 1;
    if (calls === 1) throw new Error("Claude Code is not installed.");
  };
  const first = h.enqueue(1);
  const second = h.enqueue(2);
  const row = h.jobs.get(first.id);
  assert.equal(row?.state, "failed");
  assert.equal(row?.error, "Claude Code is not installed.");
  assert.equal(row?.runningSince, null);
  assert.equal(h.jobs.get(second.id)?.state, "running", "the freed slot went to the next job");
});

test("a launch that rejects fails the job and frees the slot", async () => {
  const h = createQueueHarness({ settings: { maxEdits: 1 } });
  let calls = 0;
  h.launch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("The editing folder is missing.");
  };
  const first = h.enqueue(1);
  const second = h.enqueue(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.jobs.get(first.id)?.state, "failed");
  assert.equal(h.jobs.get(first.id)?.error, "The editing folder is missing.");
  assert.equal(h.jobs.get(second.id)?.state, "running");
  const update = h.events("job-updated", first.id).at(-1);
  assert.equal(update?.payload.state, "failed");
  assert.equal(update?.payload.error, "The editing folder is missing.");
});

test("a rejection that arrives after the job moved on does not fail it", async () => {
  const h = createQueueHarness();
  /** @type {(error: Error) => void} */
  let reject = () => {};
  h.launch = () => new Promise((_resolve, rej) => void (reject = rej));
  const job = h.enqueue(1);
  assert.ok(h.jobs.transition(job.id, ["running"], "paused"));
  reject(new Error("late"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.jobs.get(job.id)?.state, "paused");
});

test("a launch that is still starting does not hold up the next pass", () => {
  const h = createQueueHarness({ settings: { maxEdits: 2 } });
  h.launch = () => new Promise(() => {});
  h.enqueue(1);
  h.enqueue(2);
  assert.equal(h.launched.length, 2);
});

test("two enqueue calls in the same tick never start more jobs than slots", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1 } });
  h.enqueue(1);
  h.enqueue(2);
  h.enqueue(3);
  assert.equal(h.launched.length, 1);
  assert.equal(h.jobs.running("edits").length, 1);
});

test("a request during a pass causes exactly one more pass, however many arrive", () => {
  const h = createQueueHarness({ settings: { maxEdits: 4 } });
  // Every pass looks at the last launch of the edit queue, so counting those counts passes.
  let looks = 0;
  const last = h.launches.last.bind(h.launches);
  h.launches.last = (queue) => {
    looks += 1;
    return last(queue);
  };
  h.service.kick();
  const perPass = looks;
  assert.ok(perPass > 0);

  looks = 0;
  h.enqueue(1);
  const plain = looks;

  looks = 0;
  h.launch = () => {
    h.service.kick();
    h.service.kick();
    h.service.kick();
  };
  h.enqueue(2);
  assert.equal(h.launched.length, 2, "each job started once");
  assert.equal(looks - plain, perPass, "three requests during a pass: one more pass");
});

test("more slots take effect at once; fewer slots never stop a running job", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1 } });
  const a = h.enqueue(1);
  h.enqueue(2);
  h.enqueue(3);
  assert.equal(h.launched.length, 1);
  h.settings.update({ maxEdits: 3 });
  h.service.settingsChanged();
  assert.equal(h.launched.length, 3);

  h.enqueue(4);
  h.settings.update({ maxEdits: 1 });
  h.service.settingsChanged();
  assert.equal(h.launched.length, 3, "nothing new starts");
  assert.equal(h.jobs.running("edits").length, 3, "and nothing is stopped");
  h.end(a.id);
  assert.equal(h.launched.length, 3, "two still hold slots, the limit is one");
});

test("events of settings reach the service through eventsKickingOnSettings", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1 } });
  const bus = eventsKickingOnSettings(
    { emit: (/** @type {{ event: string }} */ _event) => {} },
    () => h.service.kick(),
  );
  h.enqueue(1);
  h.enqueue(2);
  h.settings.update({ maxEdits: 2 });
  bus.emit({ event: "something-else" });
  assert.equal(h.launched.length, 1);
  bus.emit({ event: "settings-changed" });
  assert.equal(h.launched.length, 2);
});

test("the start delay holds the next new session until its timer fires", () => {
  const h = createQueueHarness({
    settings: { maxEdits: 3, startDelayMinutes: 10 },
    maxWaitMs: 20 * MIN,
  });
  h.enqueue(1);
  const start = /** @type {number} */ (h.launches.last("edits"));
  const second = h.enqueue(2);
  assert.equal(h.launched.length, 1);
  const waiting = h.service.view(/** @type {never} */ (h.jobs.get(second.id)));
  assert.equal(waiting.startsAt, start + 10 * MIN);
  assert.equal(waiting.lastActivity, "Waiting for the start delay");
  // The second job joined 1 ms after the first one launched.
  assert.equal(h.armed()?.ms, 10 * MIN - 1);

  h.clock.advance(10 * MIN);
  h.fireTimer();
  assert.equal(h.launched.length, 2);
  assert.equal(h.launches.last("edits"), h.clock.now());
  assert.equal(h.armed(), null, "nothing waits for the delay any more");
});

test("the delay timer wakes at least every minute so a slept computer cannot postpone a start", () => {
  const h = createQueueHarness({ settings: { maxEdits: 3, startDelayMinutes: 10 } });
  h.enqueue(1);
  h.enqueue(2);
  assert.equal(h.armed()?.ms, 60_000);
  h.clock.advance(60_000);
  h.fireTimer();
  assert.equal(h.launched.length, 1);
  assert.equal(h.armed()?.ms, 60_000, "armed again for the rest");
  h.clock.advance(9 * MIN);
  h.fireTimer();
  assert.equal(h.launched.length, 2);
});

test("one new launch per delay period even with several free slots; jobs wait one delay apart", () => {
  const h = createQueueHarness({
    settings: { maxEdits: 4, startDelayMinutes: 5 },
    maxWaitMs: 60 * MIN,
  });
  h.enqueue(1);
  h.enqueue(2);
  h.enqueue(3);
  assert.equal(h.launched.length, 1);
  h.clock.advance(5 * MIN);
  h.fireTimer();
  assert.equal(h.launched.length, 2);
  h.clock.advance(5 * MIN);
  h.fireTimer();
  assert.equal(h.launched.length, 3);
});

test("a change of the delay setting re-plans at once", () => {
  const h = createQueueHarness({ settings: { maxEdits: 3, startDelayMinutes: 30 } });
  h.enqueue(1);
  h.enqueue(2);
  assert.equal(h.launched.length, 1);
  h.settings.update({ startDelayMinutes: 0 });
  h.service.settingsChanged();
  assert.equal(h.launched.length, 2);
  assert.equal(h.armed(), null);
});

test("when nothing holds a slot the next launch starts at once even inside the delay", () => {
  const h = createQueueHarness({ settings: { maxEdits: 2, startDelayMinutes: 30 } });
  const a = h.enqueue(1);
  h.end(a.id);
  h.enqueue(2);
  assert.equal(h.launched.length, 2);
});

test("a per-user limit keeps a user's next edit waiting while others pass", () => {
  const h = createQueueHarness({ settings: { maxEdits: 3, maxEditsPerUser: 1 } });
  // v1 and v4 are ann's, v2 is bob's.
  const a1 = h.enqueue(1);
  const a2 = h.enqueue(4);
  const b1 = h.enqueue(2);
  assert.deepEqual(
    h.launched.map((j) => j.id),
    [a1.id, b1.id],
  );
  assert.equal(h.jobs.get(a2.id)?.state, "queued");
  assert.equal(h.service.view(/** @type {never} */ (h.jobs.get(a2.id))).position, 1);
  h.end(a1.id);
  assert.equal(h.jobs.get(a2.id)?.state, "running");
});

test("the timeline and render queues have their own slots and run first in first out", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1, maxTimelineEdits: 1, maxRenders: 1 } });
  h.enqueue(1);
  const t1 = h.enqueue(2, { kind: "timelineEdit" });
  const t2 = h.enqueue(3, { kind: "timelineEdit" });
  const r1 = h.enqueue(4, { kind: "render" });
  const r2 = h.enqueue(5, { kind: "render" });
  assert.deepEqual(
    h.launched.map((j) => j.kind),
    ["edit", "timelineEdit", "render"],
  );
  assert.equal(h.service.view(/** @type {never} */ (h.jobs.get(t2.id))).position, 1);
  assert.equal(h.service.view(/** @type {never} */ (h.jobs.get(r2.id))).position, 1);
  h.end(t1.id);
  h.end(r1.id);
  assert.deepEqual(h.launched.map((j) => j.id).slice(3), [t2.id, r2.id]);
  assert.equal(h.launches.last("timeline"), null, "only the edit queue keeps a delay clock");
});

test("enqueue refuses a second active job for a video and Urgent from a user who may not", () => {
  const h = createQueueHarness({ usersMayMarkUrgent: (id) => id !== "u2" });
  h.enqueue(1);
  throwsCode(() => h.enqueue(1), "conflict");
  throwsCode(() => h.enqueue(2, { urgent: true }), "forbidden");
  assert.equal(h.jobs.forUser("u2").length, 0);
  assert.equal(h.enqueue(3, { urgent: true }).urgent, true);
});

test("setUrgent moves a waiting edit ahead and refuses everything else", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1 } });
  const running = h.enqueue(1);
  const a = h.enqueue(2);
  const b = h.enqueue(3);
  const t = h.enqueue(4, { kind: "timelineEdit" });
  const view = h.service.setUrgent(b.id, true);
  assert.equal(view.urgent, true);
  assert.equal(view.position, 1);
  assert.equal(h.service.view(/** @type {never} */ (h.jobs.get(a.id))).position, 2);
  throwsCode(() => h.service.setUrgent(running.id, true), "conflict");
  throwsCode(() => h.service.setUrgent(t.id, true), "conflict");
  throwsCode(() => h.service.setUrgent("nope", true), "notFound");
  h.service.setUrgent(b.id, false);
  assert.equal(h.service.view(/** @type {never} */ (h.jobs.get(b.id))).position, 2);
  h.end(running.id);
  assert.equal(h.launched.at(-1)?.id, a.id);
});

test("startNow starts the edit that only the delay holds, and refuses other jobs", () => {
  const h = createQueueHarness({ settings: { maxEdits: 3, startDelayMinutes: 30 } });
  const first = h.enqueue(1);
  const held = h.enqueue(2);
  const behind = h.enqueue(3);
  throwsCode(() => h.service.startNow(behind.id), "conflict");
  throwsCode(() => h.service.startNow(first.id), "conflict");
  throwsCode(() => h.service.startNow("nope"), "notFound");
  const view = h.service.startNow(held.id);
  assert.equal(view.state, "running");
  assert.equal(h.launched.length, 2);
  assert.equal(h.jobs.get(held.id)?.startNow, false, "the skip is used up");
  const next = h.service.view(/** @type {never} */ (h.jobs.get(behind.id)));
  assert.equal(next.startsAt, h.clock.now() + 30 * MIN, "it was a launch: the delay starts again");
});

test("startNow is refused when a slot, not the delay, holds the edit", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1, startDelayMinutes: 30 } });
  h.enqueue(1);
  const waiting = h.enqueue(2);
  throwsCode(() => h.service.startNow(waiting.id), "conflict");
  const render = h.enqueue(3, { kind: "render" });
  throwsCode(() => h.service.startNow(render.id), "conflict");
});

test("requeue: a paused job continues with its old place and counts as no launch", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1, startDelayMinutes: 10 } });
  const old = h.enqueue(1, { joinedAt: 5 });
  assert.ok(h.jobs.transition(old.id, ["running"], "paused"));
  h.service.released(old.id);
  const later = h.enqueue(2);
  assert.equal(later.state, "running", "the paused job holds no slot");
  h.end(later.id);
  const launchesBefore = h.launches.count("edits");
  h.service.requeue(old.id);
  assert.equal(h.launched.at(-1)?.id, old.id);
  assert.equal(h.launched.at(-1)?.resume, true);
  assert.equal(h.launched.at(-1)?.joinedAt, 5);
  assert.equal(h.launches.count("edits"), launchesBefore, "a resume is not a launch");
});

test("requeue keeps the original place in the line", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1 } });
  const runner = h.enqueue(1, { joinedAt: 1 });
  const old = h.enqueue(2, { joinedAt: 2 });
  // `old` runs later, then is paused.
  h.end(runner.id);
  assert.ok(h.jobs.transition(old.id, ["running"], "paused"));
  const blocker = h.enqueue(3, { joinedAt: 3 });
  const newer = h.enqueue(4, { joinedAt: 4 });
  assert.equal(blocker.state, "running");
  const view = h.service.requeue(old.id);
  assert.equal(view.state, "queued");
  assert.equal(view.position, 1, "ahead of the job that joined later");
  assert.equal(h.service.view(/** @type {never} */ (h.jobs.get(newer.id))).position, 2);
  assert.equal(view.lastActivity, "Waiting to continue");
});

test("requeue without a session is a launch, and refuses jobs that are not paused or failed", () => {
  const h = createQueueHarness({ settings: { maxEdits: 2 } });
  const job = h.enqueue(1);
  throwsCode(() => h.service.requeue(job.id), "conflict");
  throwsCode(() => h.service.requeue("nope"), "notFound");
  assert.ok(h.jobs.transition(job.id, ["running"], "paused"));
  h.service.released(job.id);
  const before = h.launches.count("edits");
  h.clock.advance(1000);
  h.service.requeue(job.id, { resume: false });
  assert.equal(h.launched.at(-1)?.resume, false);
  assert.equal(h.launches.count("edits"), before + 1);
});

test("requeue of a failed job clears its error and end time; a second active job is a conflict", () => {
  const h = createQueueHarness({ settings: { maxEdits: 2 } });
  const job = h.enqueue(1);
  assert.ok(h.jobs.transition(job.id, ["running"], "failed", { error: "Boom." }));
  h.service.released(job.id);
  const view = h.service.requeue(job.id);
  assert.deepEqual([view.error, view.endedAt], [null, null]);

  const other = h.enqueue(2);
  assert.ok(h.jobs.transition(other.id, ["running"], "failed"));
  h.enqueue(2);
  throwsCode(() => h.service.requeue(other.id), "conflict");
});

test("events: job-updated to the owner and admins, queue-changed to everybody, never twice", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1 } });
  const first = h.enqueue(1);
  assert.equal(h.events("job-updated", first.id).length, 1);
  assert.equal(h.events("job-updated", first.id)[0].payload.state, "running");
  assert.equal(h.events("queue-changed").length, 1);
  assert.deepEqual(h.events("job-updated")[0], {
    event: "job-updated",
    payload: h.events("job-updated")[0].payload,
    userId: "u1",
    admins: true,
  });
  assert.deepEqual(h.events("queue-changed")[0], {
    event: "queue-changed",
    payload: { queue: "edits" },
    userId: null,
    admins: false,
  });

  h.emitted.length = 0;
  const second = h.enqueue(2);
  assert.equal(h.events("job-updated", second.id).length, 1);
  assert.equal(h.events("job-updated", second.id)[0].payload.position, 1);
  assert.equal(h.events("job-updated", second.id)[0].userId, "u2");
  assert.deepEqual(
    h.events("queue-changed").map((e) => e.payload.queue),
    ["edits"],
  );

  h.emitted.length = 0;
  h.service.kick();
  h.service.kick();
  assert.equal(h.emitted.length, 0, "a pass that changes nothing says nothing");
});

test("events: a job leaving the line moves the others, each told once", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1 } });
  const running = h.enqueue(1);
  const a = h.enqueue(2);
  const b = h.enqueue(3);
  const c = h.enqueue(4);
  h.emitted.length = 0;
  h.end(running.id);
  assert.equal(h.events("job-updated", running.id).length, 1);
  assert.equal(h.events("job-updated", running.id)[0].payload.state, "completed");
  assert.equal(h.events("job-updated", a.id).length, 1);
  assert.equal(h.events("job-updated", a.id)[0].payload.state, "running");
  assert.deepEqual(
    [b.id, c.id].map((id) => h.events("job-updated", id)[0].payload.position),
    [1, 2],
  );
  assert.equal(h.events("queue-changed").length, 1);
});

test("events of two queues: one queue-changed for each queue that changed", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1, maxRenders: 1 } });
  h.enqueue(1);
  h.enqueue(2, { kind: "render" });
  assert.deepEqual(
    h.events("queue-changed").map((e) => e.payload.queue),
    ["edits", "renders"],
  );
});

test("events: setUrgent changes positions, and setting it to the same value says nothing", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1 } });
  h.enqueue(1);
  const a = h.enqueue(2);
  const b = h.enqueue(3);
  h.emitted.length = 0;
  h.service.setUrgent(b.id, true);
  assert.equal(h.events("job-updated", b.id).length, 1);
  assert.equal(h.events("job-updated", a.id).length, 1);
  assert.equal(h.events("job-updated", a.id)[0].payload.position, 2);
  assert.equal(h.events("queue-changed").length, 1);
  h.emitted.length = 0;
  h.service.setUrgent(b.id, true);
  assert.equal(h.emitted.length, 0);
});

test("events: the delay running out changes startsAt and is announced", () => {
  const h = createQueueHarness({
    settings: { maxEdits: 3, startDelayMinutes: 10 },
    maxWaitMs: 60 * MIN,
  });
  h.enqueue(1);
  const second = h.enqueue(2);
  const third = h.enqueue(3);
  assert.equal(
    h.events("job-updated", second.id)[0].payload.startsAt,
    /** @type {number} */ (h.launches.last("edits")) + 10 * MIN,
  );
  h.emitted.length = 0;
  h.clock.advance(10 * MIN);
  h.fireTimer();
  assert.equal(h.events("job-updated", second.id)[0].payload.state, "running");
  assert.equal(h.events("job-updated", third.id)[0].payload.startsAt, h.clock.now() + 10 * MIN);
});

test("changed and setLive announce a job once; the live line and cost show in the view", () => {
  const h = createQueueHarness();
  const job = h.enqueue(1);
  h.emitted.length = 0;
  h.service.setLive(job.id, { lastActivity: "Running ffmpeg", costUsd: 0.42 });
  assert.equal(h.events("job-updated", job.id).length, 1);
  assert.equal(h.events("job-updated", job.id)[0].payload.lastActivity, "Running ffmpeg");
  assert.equal(h.events("job-updated", job.id)[0].payload.costUsd, 0.42);
  h.service.setLive(job.id, { lastActivity: "Running ffmpeg" });
  assert.equal(h.events("job-updated", job.id).length, 1, "no change, no event");
  assert.equal(h.events("queue-changed").length, 0);

  h.jobs.setProgress(job.id, { percent: 10, stage: "Inspecting", secondsLeft: null });
  h.service.changed(job.id);
  assert.equal(h.events("job-updated", job.id).at(-1)?.payload.progress.percent, 10);

  h.end(job.id);
  assert.equal(h.jobs.get(job.id)?.costUsd, 0.42, "the cost is kept when the job ends");
  const view = h.service.view(/** @type {never} */ (h.jobs.get(job.id)));
  assert.deepEqual([view.lastActivity, view.costUsd], [null, 0.42]);
});

test("view gives the whole JobView: the wire name of the video and the row's facts", () => {
  const h = createQueueHarness({ settings: { maxEdits: 1 } });
  h.enqueue(1);
  const queued = h.enqueue(2, {
    urgent: true,
    setup: "opencodeGo",
    harness: "opencode2",
    model: "m",
    effort: "low",
    videoType: "short",
  });
  assert.deepEqual(queued, {
    id: queued.id,
    videoId: "c-u2/v2",
    userId: "u2",
    kind: "edit",
    queue: "edits",
    state: "queued",
    urgent: true,
    position: 1,
    joinedAt: queued.joinedAt,
    startedAt: null,
    endedAt: null,
    activeMs: 0,
    runningSince: null,
    startsAt: null,
    lastActivity: "Waiting for a free slot",
    error: null,
    progress: null,
    videoType: "short",
    setup: "opencodeGo",
    harness: "opencode2",
    model: "m",
    effort: "low",
    costUsd: null,
  });
  assert.equal(h.service.viewMany(h.jobs.active()).length, 2);
});

test("released prunes old ended jobs and hands their ids to removeLogs", () => {
  const h = createQueueHarness();
  for (let n = 0; n < 52; n += 1)
    h.jobs.create({
      videoKey: "v1",
      userId: "u1",
      kind: "edit",
      videoType: "long",
      state: "completed",
    });
  const job = h.enqueue(1);
  h.end(job.id);
  assert.equal(h.removedLogs.length, 1);
  assert.equal(h.removedLogs[0].length, 3);
});

test("summaries count running and waiting jobs and name the slots of every queue", () => {
  const h = createQueueHarness({ settings: { maxEdits: 2, maxTimelineEdits: 3, maxRenders: 1 } });
  h.enqueue(1);
  h.enqueue(2);
  h.enqueue(3);
  h.enqueue(4, { kind: "render" });
  assert.deepEqual(h.service.summaries(), [
    { queue: "edits", running: 2, waiting: 1, slots: 2 },
    { queue: "timeline", running: 0, waiting: 0, slots: 3 },
    { queue: "renders", running: 1, waiting: 0, slots: 1 },
  ]);
});

test("stop ends scheduling and the timer; running jobs are left alone", () => {
  const h = createQueueHarness({ settings: { maxEdits: 2, startDelayMinutes: 10 } });
  const a = h.enqueue(1);
  h.enqueue(2);
  assert.ok(h.armed());
  h.service.stop();
  assert.equal(h.armed(), null);
  h.end(a.id);
  h.service.kick();
  assert.equal(h.launched.length, 1);
  assert.equal(h.jobs.get(a.id)?.state, "completed");
});

test("a failing database pass is logged and does not break the next one", () => {
  const h = createQueueHarness({ settings: { maxEdits: 2 } });
  const original = h.jobs.waiting;
  let broken = true;
  h.jobs.waiting = (queue) => {
    if (broken) throw new Error("disk I/O error");
    return original(queue);
  };
  h.service.kick();
  assert.ok(h.warnings.some((w) => /could not be scheduled/.test(w)));
  broken = false;
  h.enqueue(1);
  assert.equal(h.launched.length, 1);
});

// The queue RPC functions (docs/SPEC.md sections 8 and 14): a user's own queue and the admin's.

import test from "node:test";
import assert from "node:assert/strict";
import { createQueueHarness, MIN } from "../jobs/queueSupport.js";
import { createTestApp, rejectsWith } from "./support.js";
import { queueFunctions } from "../../src/rpc/queue.js";

/** @typedef {import("../../../src/lib/wire/jobs.ts").QueueView} QueueView */
/** @typedef {import("../../../src/lib/wire/jobs.ts").AdminQueueView} AdminQueueView */
/** @typedef {import("../../../src/lib/wire/jobs.ts").JobView} JobView */

/**
 * The test app's database gets a channel per user and twelve videos; the queue service shares it,
 * and the functions are registered on the app's own RPC.
 * @param {Record<string, unknown>} [settings]
 */
function setup(settings = { maxEdits: 1, maxTimelineEdits: 1, maxRenders: 1 }) {
  const app = createTestApp();
  const admin = app.makeUser("root@example.com", { role: "admin" });
  const ann = app.makeUser("ann@example.com");
  const bob = app.makeUser("bob@example.com");
  const cy = app.makeUser("cy@example.com");
  /** @type {Map<string, { id: string, name: string }>} video key -> owner, filled by `enqueue` */
  const owners = new Map();
  for (const user of [ann, bob, cy]) {
    const name = user.email.split("@")[0];
    app.db.run(
      "INSERT INTO channels (id, user_id, name, dir, video_type, profiles, position, created_at) VALUES (?, ?, ?, ?, 'auto', '{}', 0, 1)",
      `c-${name}`,
      user.id,
      `Channel of ${name}`,
      `/media/${name}`,
    );
  }
  for (let n = 1; n <= 12; n += 1) {
    app.db.run(
      "INSERT INTO videos (id, channel_id, folder_name, created_at) VALUES (?, 'c-ann', ?, 1)",
      `v${n}`,
      `video ${n}`,
    );
  }
  const h = createQueueHarness({ settings, db: app.db, clock: app.clock });
  app.rpc.register(
    queueFunctions({
      queues: h.service,
      jobs: h.jobs,
      users: app.users,
      describeVideo: (key) => {
        const owner = owners.get(key);
        return {
          videoId: `c-${owner?.name}/${key}`,
          channelName: `Channel of ${owner?.name}`,
          folderName: `video ${key.slice(1)}`,
        };
      },
    }),
  );
  /**
   * @param {number} n
   * @param {{ id: string, email: string }} user
   * @param {Parameters<typeof h.enqueue>[1]} [fields]
   */
  function enqueue(n, user, fields = {}) {
    owners.set(`v${n}`, { id: user.id, name: user.email.split("@")[0] });
    return h.enqueue(n, { userId: user.id, ...fields });
  }
  return { app, h, admin, ann, bob, cy, enqueue };
}

/** @param {ReturnType<typeof setup>} s @param {string} name @param {unknown} input @param {{ id: string } | null} user */
function call(s, name, input, user) {
  return s.app.call(name, input, s.app.contextFor(user));
}

test("a user sees only their own waiting and running jobs, with positions and jobs ahead", async () => {
  const s = setup();
  s.enqueue(1, s.ann);
  s.enqueue(2, s.bob);
  s.enqueue(4, s.ann);
  s.enqueue(3, s.cy);
  const view = /** @type {QueueView} */ (await call(s, "getQueue", {}, s.ann));
  assert.deepEqual(
    view.jobs.map((e) => [e.job.state, e.job.position, e.ahead, e.folderName, e.channelName]),
    [
      ["running", null, null, "video 1", "Channel of ann"],
      ["queued", 2, 1, "video 4", "Channel of ann"],
    ],
  );
  const text = JSON.stringify(view);
  assert.ok(!text.includes("video 2") && !text.includes("video 3"));
  assert.ok(!text.includes("bob") && !text.includes(s.bob.id));
  assert.deepEqual(
    view.queues.map((q) => [q.queue, q.running, q.waiting, q.slots]),
    [
      ["edits", 1, 3, 1],
      ["timeline", 0, 0, 1],
      ["renders", 0, 0, 1],
    ],
  );
});

test("getQueue lists the three queues in order and leaves paused jobs out", async () => {
  const s = setup();
  s.enqueue(7, s.ann, { kind: "render" });
  s.enqueue(4, s.ann, { kind: "timelineEdit" });
  s.enqueue(1, s.ann);
  const pausedJob = s.enqueue(10, s.ann);
  assert.ok(s.h.jobs.transition(pausedJob.id, ["queued"], "running"));
  assert.ok(s.h.jobs.transition(pausedJob.id, ["running"], "paused"));
  const view = /** @type {QueueView} */ (await call(s, "getQueue", {}, s.ann));
  assert.deepEqual(
    view.jobs.map((e) => e.job.queue),
    ["edits", "timeline", "renders"],
  );
  assert.ok(!view.jobs.some((e) => e.job.id === pausedJob.id));
});

test("a user with no jobs gets an empty list and the totals", async () => {
  const s = setup();
  s.enqueue(1, s.ann);
  const view = /** @type {QueueView} */ (await call(s, "getQueue", {}, s.bob));
  assert.deepEqual(view.jobs, []);
  assert.equal(view.queues[0].running, 1);
});

test("getQueue needs a signed-in user", async () => {
  const s = setup();
  await rejectsWith(call(s, "getQueue", {}, null), "unauthenticated");
});

test("the admin sees every active job with user, channel, video, kind, state, Urgent and position", async () => {
  const s = setup();
  s.enqueue(1, s.ann);
  s.enqueue(2, s.bob, { urgent: true });
  s.enqueue(4, s.ann);
  s.enqueue(5, s.bob, { kind: "render" });
  const done = s.enqueue(6, s.bob, { kind: "timelineEdit" });
  s.h.end(done.id);
  const view = /** @type {AdminQueueView} */ (await call(s, "adminGetQueue", {}, s.admin));
  assert.deepEqual(
    view.jobs.map((e) => [
      e.queue,
      e.userEmail,
      e.folderName,
      e.kind,
      e.state,
      e.urgent,
      e.position,
    ]),
    [
      ["edits", "ann@example.com", "video 1", "edit", "running", false, null],
      ["edits", "bob@example.com", "video 2", "edit", "queued", true, 1],
      ["edits", "ann@example.com", "video 4", "edit", "queued", false, 2],
      ["renders", "bob@example.com", "video 5", "render", "running", false, null],
    ],
  );
  assert.equal(view.jobs[1].channelName, "Channel of bob");
  assert.equal(view.jobs[1].userId, s.bob.id);
  assert.deepEqual(
    view.queues.map((q) => [q.running, q.waiting]),
    [
      [1, 2],
      [0, 0],
      [1, 0],
    ],
  );
});

test("the admin sees when the start delay lets the next edit start", async () => {
  const s = setup({ maxEdits: 3, startDelayMinutes: 10 });
  s.enqueue(1, s.ann);
  s.enqueue(2, s.bob);
  const view = /** @type {AdminQueueView} */ (await call(s, "adminGetQueue", {}, s.admin));
  assert.equal(view.jobs[0].startsAt, null);
  assert.equal(
    view.jobs[1].startsAt,
    /** @type {number} */ (s.h.launches.last("edits")) + 10 * MIN,
  );
});

test("admin functions refuse a user and a signed-out caller", async () => {
  const s = setup();
  const job = s.enqueue(2, s.bob);
  for (const [name, input] of /** @type {[string, unknown][]} */ ([
    ["adminGetQueue", {}],
    ["adminSetJobUrgent", { jobId: job.id, urgent: true }],
    ["adminStartJobNow", { jobId: job.id }],
  ])) {
    await rejectsWith(call(s, name, input, s.ann), "forbidden");
    await rejectsWith(call(s, name, input, null), "unauthenticated");
  }
  assert.equal(s.h.jobs.get(job.id)?.urgent, false);
});

test("adminSetJobUrgent reorders the line and refuses what is not a waiting edit", async () => {
  const s = setup();
  const running = s.enqueue(1, s.ann);
  const first = s.enqueue(2, s.bob);
  const second = s.enqueue(4, s.ann);
  const view = /** @type {JobView} */ (
    await call(s, "adminSetJobUrgent", { jobId: second.id, urgent: true }, s.admin)
  );
  assert.deepEqual([view.urgent, view.position], [true, 1]);
  await rejectsWith(
    call(s, "adminSetJobUrgent", { jobId: running.id, urgent: true }, s.admin),
    "conflict",
  );
  await rejectsWith(
    call(s, "adminSetJobUrgent", { jobId: "nope", urgent: true }, s.admin),
    "notFound",
  );
  await rejectsWith(call(s, "adminSetJobUrgent", { jobId: first.id }, s.admin), "invalidInput");
  await rejectsWith(call(s, "adminSetJobUrgent", { urgent: true }, s.admin), "invalidInput");
  s.h.end(running.id);
  assert.equal(s.h.launched.at(-1)?.id, second.id);
});

test("adminStartJobNow starts the edit the delay holds and refuses the others", async () => {
  const s = setup({ maxEdits: 3, startDelayMinutes: 30 });
  const first = s.enqueue(1, s.ann);
  const held = s.enqueue(2, s.bob);
  await rejectsWith(call(s, "adminStartJobNow", { jobId: first.id }, s.admin), "conflict");
  const view = /** @type {JobView} */ (
    await call(s, "adminStartJobNow", { jobId: held.id }, s.admin)
  );
  assert.equal(view.state, "running");
  await rejectsWith(call(s, "adminStartJobNow", {}, s.admin), "invalidInput");
});

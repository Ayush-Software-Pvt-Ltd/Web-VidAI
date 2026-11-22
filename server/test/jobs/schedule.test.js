// The pure scheduling rules, one test per sentence of docs/SPEC.md section 8 ("The edit queue",
// "The timeline queue and the render queue").

import test from "node:test";
import assert from "node:assert/strict";
import { lineOrder, plan, queueOfKind } from "../../src/jobs/schedule.js";

const MIN = 60_000;
const NOW = 1_000_000_000;

/**
 * @param {string} id
 * @param {Partial<import("../../src/jobs/schedule.js").WaitingJob>} [fields]
 * @returns {import("../../src/jobs/schedule.js").WaitingJob}
 */
function job(id, fields = {}) {
  return {
    id,
    userId: "u1",
    urgent: false,
    joinedAt: 0,
    resume: false,
    startNow: false,
    ...fields,
  };
}

/** Jobs that joined one after the other, in the order given. @param {...string} ids */
function inOrder(...ids) {
  return ids.map((id, index) => job(id, { joinedAt: 100 + index }));
}

/** @param {...string} ids */
function holding(...ids) {
  return ids.map((id) => ({ id, userId: "x" }));
}

/**
 * @param {Partial<Parameters<typeof plan>[0]> & { slots?: number, perUser?: number, delayMin?: number }} input
 */
function run({ slots = 1, perUser = 0, delayMin = 0, ...rest }) {
  return plan({
    queue: "edits",
    waiting: [],
    running: [],
    lastLaunchAt: null,
    now: NOW,
    ...rest,
    limits: { slots, perUser, startDelayMs: delayMin * MIN },
  });
}

test("kinds wait in their own line", () => {
  assert.equal(queueOfKind("edit"), "edits");
  assert.equal(queueOfKind("reEdit"), "edits");
  assert.equal(queueOfKind("timelineEdit"), "timeline");
  assert.equal(queueOfKind("render"), "renders");
});

test("slots: running, pausing and stopping jobs hold one, so nothing starts when all are held", () => {
  const full = run({ slots: 2, waiting: inOrder("a"), running: holding("r1", "r2") });
  assert.deepEqual(full.start, []);
  const free = run({ slots: 2, waiting: inOrder("a", "b"), running: holding("r1") });
  assert.deepEqual(free.start, ["a"]);
});

test("slots lowered below the running count: nothing starts and nothing is asked to stop", () => {
  const result = run({ slots: 1, waiting: inOrder("a"), running: holding("r1", "r2", "r3") });
  assert.deepEqual(result.start, []);
});

test("without any delay every free slot starts the next job in line", () => {
  const result = run({ slots: 3, waiting: inOrder("a", "b", "c", "d") });
  assert.deepEqual(result.start, ["a", "b", "c"]);
  assert.equal(result.wakeAt, null);
  assert.equal(result.startsAt.size, 0);
});

test("an Urgent job is behind the running ones: it starts only when a slot is free", () => {
  const waiting = [job("normal", { joinedAt: 1 }), job("urgent", { joinedAt: 2, urgent: true })];
  const busy = run({ slots: 1, waiting, running: holding("r") });
  assert.deepEqual(busy.start, []);
  assert.equal(busy.positions.get("urgent"), 1);
  assert.equal(busy.positions.get("normal"), 2);
  const free = run({ slots: 1, waiting });
  assert.deepEqual(free.start, ["urgent"]);
});

test("an Urgent job is behind earlier Urgent jobs and ahead of everything else", () => {
  const waiting = [
    job("n1", { joinedAt: 1 }),
    job("u2", { joinedAt: 5, urgent: true }),
    job("u1", { joinedAt: 3, urgent: true }),
    job("n2", { joinedAt: 2 }),
  ];
  assert.deepEqual(
    lineOrder("edits", waiting).map((j) => j.id),
    ["u1", "u2", "n1", "n2"],
  );
});

test("ten mixed jobs come out in the documented order", () => {
  const waiting = [
    job("a", { joinedAt: 10 }),
    job("b", { joinedAt: 11, urgent: true }),
    job("c", { joinedAt: 12 }),
    job("d", { joinedAt: 13, urgent: true }),
    job("e", { joinedAt: 14 }),
    job("f", { joinedAt: 15, urgent: true }),
    job("g", { joinedAt: 16 }),
    job("h", { joinedAt: 17 }),
    job("i", { joinedAt: 18, urgent: true }),
    job("j", { joinedAt: 19 }),
  ];
  const result = run({ slots: 10, waiting });
  assert.deepEqual(result.start, ["b", "d", "f", "i", "a", "c", "e", "g", "h", "j"]);
  assert.deepEqual(
    [...result.positions.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id),
    ["b", "d", "f", "i", "a", "c", "e", "g", "h", "j"],
  );
});

test("ties in the join time go to the id, so the order is total and stable", () => {
  const waiting = [job("b", { joinedAt: 1 }), job("a", { joinedAt: 1 }), job("c", { joinedAt: 1 })];
  assert.deepEqual(
    lineOrder("edits", waiting).map((j) => j.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    lineOrder("edits", [...waiting].reverse()).map((j) => j.id),
    ["a", "b", "c"],
  );
});

test("a continued job has its original joinedAt, so it gets its old place back", () => {
  // `paused` joined first; two later jobs wait; continuing puts it ahead of them again.
  const waiting = [
    job("late1", { joinedAt: 50 }),
    job("paused", { joinedAt: 5, resume: true }),
    job("late2", { joinedAt: 60 }),
  ];
  const result = run({ slots: 1, waiting });
  assert.deepEqual(result.start, ["paused"]);
  assert.equal(result.positions.get("paused"), 1);
});

test("positions are 1..n without holes, also when a job is skipped for its user limit", () => {
  const waiting = [
    job("a", { userId: "busy", joinedAt: 1 }),
    job("b", { userId: "free", joinedAt: 2 }),
    job("c", { userId: "busy", joinedAt: 3 }),
    job("d", { userId: "other", joinedAt: 4 }),
  ];
  const running = [{ id: "r", userId: "busy" }];
  const result = run({ slots: 3, perUser: 1, waiting, running });
  assert.deepEqual(result.start, ["b", "d"]);
  assert.deepEqual([...result.positions.values()].sort(), [1, 2, 3, 4]);
  assert.equal(result.positions.get("a"), 1, "the skipped job keeps its number");
  assert.equal(result.positions.get("c"), 3);
});

test("the per-user limit skips a user's job and admits it once one of their edits has ended", () => {
  const waiting = [
    job("a", { userId: "ann", joinedAt: 1 }),
    job("b", { userId: "bob", joinedAt: 2 }),
  ];
  const ann = [
    { id: "r1", userId: "ann" },
    { id: "r2", userId: "ann" },
  ];
  const held = run({ slots: 4, perUser: 2, waiting, running: ann });
  assert.deepEqual(held.start, ["b"]);
  const admitted = run({ slots: 4, perUser: 2, waiting, running: ann.slice(1) });
  assert.deepEqual(admitted.start, ["a", "b"]);
});

test("the per-user limit counts the jobs this very plan starts", () => {
  const waiting = [1, 2, 3].map((n) => job(`a${n}`, { userId: "ann", joinedAt: n }));
  const result = run({ slots: 5, perUser: 2, waiting });
  assert.deepEqual(result.start, ["a1", "a2"]);
});

test("a per-user limit of 0 means no limit, and it never applies to the other queues", () => {
  const waiting = [1, 2, 3].map((n) => job(`a${n}`, { userId: "ann", joinedAt: n }));
  assert.equal(run({ slots: 5, perUser: 0, waiting }).start.length, 3);
  const timeline = plan({
    queue: "timeline",
    waiting,
    running: [],
    limits: { slots: 5, perUser: 1, startDelayMs: 0 },
    lastLaunchAt: null,
    now: NOW,
  });
  assert.equal(timeline.start.length, 3);
});

test("the delay: the first job starts at once, the next waits one delay with several free slots", () => {
  const first = run({ slots: 3, delayMin: 10, waiting: inOrder("a", "b", "c") });
  assert.deepEqual(first.start, ["a"]);
  assert.equal(first.startsAt.get("b"), NOW + 10 * MIN);
  assert.equal(first.startsAt.size, 1, "only the job that is next gets a start time");
  assert.equal(first.wakeAt, NOW + 10 * MIN);
});

test("the delay: with a launch 4 minutes ago and a job running, the next job waits 6 more minutes", () => {
  const result = run({
    slots: 2,
    delayMin: 10,
    waiting: inOrder("a", "b"),
    running: holding("r"),
    lastLaunchAt: NOW - 4 * MIN,
  });
  assert.deepEqual(result.start, []);
  assert.equal(result.startsAt.get("a"), NOW + 6 * MIN);
  assert.equal(result.wakeAt, NOW + 6 * MIN);
});

test("the delay passes: exactly one job per delay period starts, the clock restarts for the next", () => {
  const result = run({
    slots: 3,
    delayMin: 10,
    waiting: inOrder("a", "b"),
    running: holding("r"),
    lastLaunchAt: NOW - 10 * MIN,
  });
  assert.deepEqual(result.start, ["a"]);
  assert.equal(result.startsAt.get("b"), NOW + 10 * MIN);
});

test("a launch longer ago than the delay lets a job start at once", () => {
  const result = run({
    slots: 2,
    delayMin: 10,
    waiting: inOrder("a"),
    running: holding("r"),
    lastLaunchAt: NOW - 30 * MIN,
  });
  assert.deepEqual(result.start, ["a"]);
  assert.equal(result.wakeAt, null);
});

test("with nothing holding a slot the delay is open, also right after a launch", () => {
  const result = run({ slots: 2, delayMin: 10, waiting: inOrder("a"), lastLaunchAt: NOW - MIN });
  assert.deepEqual(result.start, ["a"]);
});

test("waiting only for a free slot is not the delay: no start time and nothing to wake up for", () => {
  const result = run({
    slots: 1,
    delayMin: 10,
    waiting: inOrder("a", "b"),
    running: holding("r"),
    lastLaunchAt: NOW - 30 * MIN,
  });
  assert.deepEqual(result.start, []);
  assert.equal(result.startsAt.size, 0);
  assert.equal(result.wakeAt, null);
  const stillDelayed = run({
    slots: 1,
    delayMin: 10,
    waiting: inOrder("a"),
    running: holding("r"),
    lastLaunchAt: NOW - 2 * MIN,
  });
  assert.equal(stillDelayed.startsAt.size, 0, "no free slot: a slot, not the delay, holds it");
  assert.equal(stillDelayed.wakeAt, null);
});

test("the start time belongs to the next job that the user limit lets through", () => {
  const waiting = [
    job("a", { userId: "busy", joinedAt: 1 }),
    job("b", { userId: "free", joinedAt: 2 }),
  ];
  const result = run({
    slots: 3,
    perUser: 1,
    delayMin: 10,
    waiting,
    running: [{ id: "r", userId: "busy" }],
    lastLaunchAt: NOW - MIN,
  });
  assert.deepEqual(result.start, []);
  assert.equal(result.startsAt.has("a"), false);
  assert.equal(result.startsAt.get("b"), NOW + 9 * MIN);
});

test("a waiting job with resume is neither held by the delay nor counted as a launch", () => {
  const waiting = [job("fresh", { joinedAt: 1 }), job("resumed", { joinedAt: 2, resume: true })];
  const result = run({
    slots: 3,
    delayMin: 10,
    waiting,
    running: holding("r"),
    lastLaunchAt: NOW - 2 * MIN,
  });
  assert.deepEqual(result.start, ["resumed"], "a resume passes the held fresh job");
  assert.equal(result.startsAt.get("fresh"), NOW + 8 * MIN, "and does not restart the clock");
  assert.equal(result.wakeAt, NOW + 8 * MIN);
  // Even alone, a resume does not restart the clock: the fresh job behind it waits for the rest of it.
  const alone = run({
    slots: 3,
    delayMin: 10,
    waiting: [job("resumed", { resume: true }), job("fresh", { joinedAt: 5 })],
    lastLaunchAt: NOW - 2 * MIN,
  });
  assert.deepEqual(alone.start, ["resumed"]);
  assert.equal(alone.startsAt.get("fresh"), NOW + 8 * MIN);
});

test("several resumes start together, limited by the free slots only", () => {
  const waiting = inOrder("a", "b", "c").map((j) => ({ ...j, resume: true }));
  const result = run({
    slots: 5,
    delayMin: 10,
    waiting,
    running: holding("r"),
    lastLaunchAt: NOW - MIN,
  });
  assert.deepEqual(result.start, ["a", "b", "c"]);
});

test("startNow skips the delay for that job and counts as a launch", () => {
  const waiting = [job("a", { joinedAt: 1, startNow: true }), job("b", { joinedAt: 2 })];
  const result = run({
    slots: 3,
    delayMin: 10,
    waiting,
    running: holding("r"),
    lastLaunchAt: NOW - MIN,
  });
  assert.deepEqual(result.start, ["a"]);
  assert.equal(result.startsAt.get("b"), NOW + 10 * MIN, "the clock restarted at the launch");
});

test("startNow still needs a free slot and keeps the job's place", () => {
  const waiting = [job("a", { startNow: true })];
  const result = run({ slots: 1, delayMin: 10, waiting, running: holding("r"), lastLaunchAt: NOW });
  assert.deepEqual(result.start, []);
  assert.equal(result.positions.get("a"), 1);
});

test("a last launch in the future (the clock was set back) counts as now", () => {
  const result = run({
    slots: 2,
    delayMin: 10,
    waiting: inOrder("a"),
    running: holding("r"),
    lastLaunchAt: NOW + 60 * MIN,
  });
  assert.equal(result.startsAt.get("a"), NOW + 10 * MIN);
});

test("wakeAt is null when nothing waits for the delay", () => {
  assert.equal(run({ slots: 2, delayMin: 10 }).wakeAt, null);
  assert.equal(run({ slots: 2, delayMin: 0, waiting: inOrder("a", "b") }).wakeAt, null);
});

test("the timeline and render queues are plain first-in first-out: no Urgent, no delay, own slots", () => {
  for (const queue of /** @type {const} */ (["timeline", "renders"])) {
    const waiting = [
      job("late", { joinedAt: 9, urgent: true }),
      job("early", { joinedAt: 1 }),
      job("middle", { joinedAt: 5 }),
    ];
    const result = plan({
      queue,
      waiting,
      running: holding("r"),
      limits: { slots: 3, perUser: 1, startDelayMs: 10 * MIN },
      lastLaunchAt: NOW,
      now: NOW,
    });
    assert.deepEqual(result.start, ["early", "middle"], queue);
    assert.equal(result.startsAt.size, 0);
    assert.equal(result.wakeAt, null);
    assert.equal(result.positions.get("late"), 3);
  }
});

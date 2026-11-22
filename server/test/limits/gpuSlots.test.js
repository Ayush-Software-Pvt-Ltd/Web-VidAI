import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { LEASE_MS, createSlotFile, readSlots } from "../../src/limits/gpuFiles.js";
import { acquireGpuSlot, createGpuSlotKeeper } from "../../src/limits/gpuSlots.js";
import { createFakeTime } from "./fakes.js";

/** @type {string[]} */
const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const ME = process.pid;
/** Every pid but the dead one is alive. */
const DEAD = 999_999_001;
const isAlive = (/** @type {number} */ pid) => pid !== DEAD;

/** @type {ReturnType<typeof createFakeTime>} */
let time;
/** @type {string} */
let dir;
/** @type {ReturnType<typeof createGpuSlotKeeper>} */
let keeper;

/** @param {{ total: number, perJob: number }} limits */
function limit(limits) {
  keeper.setLimits(limits);
}

/**
 * @param {string} jobId
 * @param {{ signal?: AbortSignal, pid?: number }} [extra]
 */
function acquire(jobId, extra = {}) {
  return acquireGpuSlot({
    dir,
    jobId,
    pid: ME,
    clock: time.clock,
    timers: time.timers,
    isAlive,
    ...extra,
  });
}

/**
 * Tracks whether a promise settled.
 * @template T
 * @param {Promise<T>} promise
 */
function track(promise) {
  const state = {
    done: false,
    value: /** @type {T | undefined} */ (undefined),
    error: /** @type {unknown} */ (null),
  };
  promise.then(
    (value) => {
      state.done = true;
      state.value = value;
    },
    (error) => {
      state.done = true;
      state.error = error;
    },
  );
  return state;
}

beforeEach(() => {
  time = createFakeTime();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-gpu-"));
  made.push(dir);
  dir = path.join(dir, "locks", "gpu");
  keeper = createGpuSlotKeeper({ dir, clock: time.clock, timers: time.timers, isAlive });
});
afterEach(() => keeper.stop());

const names = () => fs.readdirSync(dir).sort();

describe("limits.json", () => {
  test("is written whole with the two numbers, by temporary name and rename", () => {
    limit({ total: 3, perJob: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "limits.json"), "utf8")), {
      total: 3,
      perJob: 2,
    });
    assert.deepEqual(names(), ["limits.json"], "no temporary file is left");
    limit({ total: 5, perJob: 9 });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "limits.json"), "utf8")), {
      total: 5,
      perJob: 5,
    });
    assert.deepEqual(keeper.limits(), { total: 5, perJob: 5 });
  });

  test("a program with no limits file uses one slot in all and one per job", async () => {
    const held = await acquire("job-1");
    assert.equal(held.index, 0);
    const second = track(acquire("job-2"));
    await time.advance(3000);
    assert.equal(second.done, false);
    held.release();
    await time.advance(1000);
    assert.equal(second.done, true);
  });

  test("a corrupt limits file is read as the defaults", async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "limits.json"), "{not json");
    const held = await acquire("job-1");
    assert.equal(held.index, 0);
    held.release();
  });
});

describe("taking and giving back", () => {
  test("slots are taken in order, with the format of the contract", async () => {
    limit({ total: 3, perJob: 3 });
    const a = await acquire("job-a", { pid: 4242 });
    const b = await acquire("job-b");
    assert.deepEqual([a.index, b.index], [0, 1]);
    const record = JSON.parse(fs.readFileSync(path.join(dir, "slot-0"), "utf8"));
    assert.deepEqual(Object.keys(record).sort(), ["at", "jobId", "pid"]);
    assert.equal(record.jobId, "job-a");
    assert.equal(record.pid, 4242);
    assert.equal(record.at, time.clock.now());
    assert.ok(Math.abs(fs.statSync(path.join(dir, "slot-0")).mtimeMs - time.clock.now()) < 2);
    a.release();
    assert.deepEqual(names(), ["limits.json", "slot-1"]);
    const c = await acquire("job-c");
    assert.equal(c.index, 0, "the first name that can be created");
    b.release();
    c.release();
  });

  test("when all are taken a client waits and gets one when it is released", async () => {
    limit({ total: 3, perJob: 3 });
    const held = [await acquire("a"), await acquire("b"), await acquire("c")];
    const waiting = track(acquire("d"));
    await time.advance(5000);
    assert.equal(waiting.done, false);
    held[1]?.release();
    await time.advance(999);
    assert.equal(waiting.done, false, "it tries every second, not sooner");
    await time.advance(1);
    assert.equal(waiting.done, true);
    assert.equal(waiting.value?.index, 1);
  });

  test("a job never holds more than perJob", async () => {
    limit({ total: 4, perJob: 2 });
    const a1 = await acquire("job-a");
    const a2 = await acquire("job-a");
    const a3 = track(acquire("job-a"));
    await time.advance(5000);
    assert.equal(a3.done, false, "slots are free, but the job has its two");
    const b = await acquire("job-b");
    assert.equal(b.index, 2);
    a1.release();
    await time.advance(1000);
    assert.equal(a3.done, true);
    a2.release();
    b.release();
    a3.value?.release();
  });

  test("release is idempotent and never removes a slot someone else took", async () => {
    limit({ total: 1, perJob: 1 });
    const a = await acquire("job-a");
    a.release();
    a.release();
    const b = await acquire("job-b");
    a.release();
    assert.deepEqual(names(), ["limits.json", "slot-0"], "b's slot is untouched");
    b.release();
    b.release();
    assert.deepEqual(names(), ["limits.json"]);
    assert.equal(time.pending(), 0, "no renewal timer is left");
  });

  test("abort while waiting rejects with AbortError and leaves no timer", async () => {
    limit({ total: 1, perJob: 1 });
    const holder = await acquire("a");
    const controller = new AbortController();
    const waiting = track(acquire("b", { signal: controller.signal }));
    await time.advance(2500);
    controller.abort();
    await time.flush();
    assert.equal(waiting.done, true);
    assert.equal(/** @type {Error} */ (waiting.error).name, "AbortError");
    // Only the holder's renewal timer remains.
    assert.equal(time.pending(), 1);
    holder.release();
    assert.equal(time.pending(), 0);
  });

  test("an already aborted signal rejects at once", async () => {
    limit({ total: 1, perJob: 1 });
    await assert.rejects(acquire("a", { signal: AbortSignal.abort() }), { name: "AbortError" });
    assert.deepEqual(names(), ["limits.json"]);
  });

  test("an abort after the slot is held gives it back", async () => {
    limit({ total: 1, perJob: 1 });
    const controller = new AbortController();
    const held = await acquire("a", { signal: controller.signal });
    assert.deepEqual(names(), ["limits.json", "slot-0"]);
    controller.abort();
    assert.deepEqual(names(), ["limits.json"]);
    held.release();
    assert.equal(time.pending(), 0);
  });
});

describe("the lease", () => {
  test("renewal every 60 seconds keeps a slot beyond 15 minutes", async () => {
    limit({ total: 1, perJob: 1 });
    const held = await acquire("a");
    const waiting = track(acquire("b"));
    await time.advance(40 * 60 * 1000);
    assert.equal(waiting.done, false, "never taken over while it is renewed");
    assert.deepEqual(
      keeper.list().map((s) => [s.index, s.jobId, s.state]),
      [[0, "a", "held"]],
    );
    assert.ok(keeper.list()[0]?.ageMs <= 60_000);
    assert.deepEqual(keeper.sweep(), []);
    held.release();
    await time.advance(1000);
    assert.equal(waiting.done, true);
  });

  test("an expired slot is taken over", async () => {
    limit({ total: 1, perJob: 1 });
    assert.ok(createSlotFile(dir, 0, { jobId: "old", pid: ME, at: time.clock.now() }));
    const waiting = track(acquire("new"));
    await time.advance(LEASE_MS - 1000);
    assert.equal(waiting.done, false, "just under 15 minutes is not yet expired");
    await time.advance(2000);
    assert.equal(waiting.done, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "slot-0"), "utf8")).jobId, "new");
    assert.deepEqual(names(), ["limits.json", "slot-0"], "the renamed-away file is deleted");
  });

  test("a dead holder's slot is taken over at once", async () => {
    limit({ total: 1, perJob: 1 });
    assert.ok(createSlotFile(dir, 0, { jobId: "dead", pid: DEAD, at: time.clock.now() }));
    const held = await acquire("new");
    assert.equal(held.index, 0);
  });

  test("a corrupt slot file waits for the lease, then is taken over; nothing crashes", async () => {
    limit({ total: 1, perJob: 1 });
    for (const content of ["", "{", "[]", '{"jobId":1,"pid":"x"}', "\u0000\u0000"]) {
      fs.writeFileSync(path.join(dir, "slot-0"), content);
      const seconds = time.clock.now() / 1000;
      fs.utimesSync(path.join(dir, "slot-0"), seconds, seconds);
      const waiting = track(acquire("new"));
      await time.advance(LEASE_MS - 1000);
      assert.equal(waiting.done, false, `${JSON.stringify(content)} within its lease`);
      assert.equal(keeper.list()[0]?.state, "unreadable");
      await time.advance(2000);
      assert.equal(waiting.done, true, `${JSON.stringify(content)} after its lease`);
      waiting.value?.release();
    }
  });

  test("a leftover renamed file older than the lease is cleaned up by the sweep", async () => {
    limit({ total: 2, perJob: 2 });
    const stale = path.join(dir, "slot-1.gone-1-1-abc");
    const temporary = path.join(dir, "limits.json.tmp-1-1-abc");
    for (const file of [stale, temporary]) {
      fs.writeFileSync(file, "x");
      const seconds = time.clock.now() / 1000;
      fs.utimesSync(file, seconds, seconds);
    }
    keeper.sweep();
    assert.equal(fs.existsSync(stale), true);
    await time.advance(LEASE_MS + 1000);
    keeper.sweep();
    assert.deepEqual(names(), ["limits.json"]);
  });
});

describe("many clients at once", () => {
  for (const [label, makeStale] of /** @type {[string, () => void][]} */ ([
    [
      "an expired slot",
      () => {
        createSlotFile(dir, 0, { jobId: "old", pid: ME, at: time.clock.now() - LEASE_MS - 5000 });
      },
    ],
    [
      "a dead holder's slot",
      () => {
        createSlotFile(dir, 0, { jobId: "old", pid: DEAD, at: time.clock.now() });
      },
    ],
  ])) {
    test(`${label} is taken over exactly once by 20 clients`, async () => {
      limit({ total: 1, perJob: 1 });
      makeStale();
      const controller = new AbortController();
      const states = Array.from({ length: 20 }, (_, i) =>
        track(acquire(`job-${i}`, { signal: controller.signal })),
      );
      await time.flush();
      const winners = states.filter((s) => s.done && s.value !== undefined);
      assert.equal(winners.length, 1);
      assert.equal(readSlots(dir).length, 1);
      controller.abort();
      await time.flush();
      winners[0]?.value?.release();
    });
  }

  test("20 clients on 3 slots: never more than 3 holders, never more than perJob for one job", async () => {
    limit({ total: 3, perJob: 2 });
    let active = 0;
    let maxActive = 0;
    /** @type {Map<string, number>} */
    const perJob = new Map();
    let maxPerJob = 0;
    let maxFiles = 0;
    let finished = 0;

    /** @param {string} jobId @param {number} i */
    async function client(jobId, i) {
      const held = await acquire(jobId, { pid: ME });
      active += 1;
      perJob.set(jobId, (perJob.get(jobId) ?? 0) + 1);
      maxActive = Math.max(maxActive, active);
      maxPerJob = Math.max(maxPerJob, perJob.get(jobId) ?? 0);
      maxFiles = Math.max(maxFiles, readSlots(dir).length);
      await new Promise((resolve) => {
        time.timers.setTimeout(() => resolve(undefined), 1500 + (i % 4) * 700);
      });
      active -= 1;
      perJob.set(jobId, (perJob.get(jobId) ?? 1) - 1);
      held.release();
      finished += 1;
    }

    const clients = Array.from({ length: 20 }, (_, i) => client(`job-${i % 4}`, i));
    for (let step = 0; step < 400 && finished < 20; step += 1) {
      await time.advance(500);
      maxFiles = Math.max(maxFiles, readSlots(dir).length);
    }
    await Promise.all(clients);
    assert.equal(finished, 20);
    assert.ok(maxActive <= 3 && maxActive >= 2, `at most 3 at once, saw ${maxActive}`);
    assert.ok(maxPerJob <= 2, `at most perJob for one job, saw ${maxPerJob}`);
    assert.ok(maxFiles <= 3, `at most 3 files, saw ${maxFiles}`);
    assert.deepEqual(names(), ["limits.json"]);
  });
});

describe("the keeper", () => {
  test("lowering total removes the high slots", async () => {
    limit({ total: 4, perJob: 4 });
    const held = [];
    for (let i = 0; i < 4; i += 1) held.push(await acquire(`job-${i}`));
    assert.deepEqual(names(), ["limits.json", "slot-0", "slot-1", "slot-2", "slot-3"]);
    limit({ total: 2, perJob: 2 });
    assert.deepEqual(names(), ["limits.json", "slot-0", "slot-1"]);
    // Nothing below the new total is free, so a newcomer waits.
    const controller = new AbortController();
    const late = track(acquire("late", { signal: controller.signal }));
    await time.advance(3000);
    assert.equal(late.done, false);
    controller.abort();
    await time.flush();
    assert.equal(/** @type {Error} */ (late.error).name, "AbortError");
    for (const h of held) h.release();
  });

  test("a sweep after an outside change removes slots at or above total", () => {
    limit({ total: 4, perJob: 4 });
    for (let i = 0; i < 4; i += 1)
      createSlotFile(dir, i, { jobId: `j${i}`, pid: ME, at: time.clock.now() });
    fs.writeFileSync(path.join(dir, "limits.json"), '{"total":2,"perJob":2}');
    assert.equal(keeper.sweep().length, 0, "the keeper goes by the limits it wrote itself");
    limit({ total: 3, perJob: 3 });
    assert.deepEqual(names(), ["limits.json", "slot-0", "slot-1", "slot-2"]);
  });

  test("endJob removes the job's slots now and any it creates later", async () => {
    limit({ total: 3, perJob: 3 });
    await acquire("a");
    await acquire("a");
    await acquire("b");
    keeper.endJob("a");
    assert.deepEqual(
      keeper.list().map((s) => s.jobId),
      ["b"],
    );
    createSlotFile(dir, 0, { jobId: "a", pid: ME, at: time.clock.now() });
    assert.equal(keeper.sweep().length, 1);
    await time.advance(LEASE_MS + 60_000);
    // After the lease time the ended job is forgotten (a job id is never reused).
    createSlotFile(dir, 0, { jobId: "a", pid: ME, at: time.clock.now() });
    keeper.sweep();
    assert.equal(
      keeper.list().some((s) => s.jobId === "a"),
      true,
    );
  });

  test("a sweep removes slots of dead processes and expired ones, and keeps the rest", async () => {
    limit({ total: 4, perJob: 4 });
    createSlotFile(dir, 0, { jobId: "dead", pid: DEAD, at: time.clock.now() });
    createSlotFile(dir, 1, { jobId: "live", pid: ME, at: time.clock.now() });
    createSlotFile(dir, 2, { jobId: "old", pid: ME, at: time.clock.now() - 2 * LEASE_MS });
    fs.writeFileSync(path.join(dir, "slot-3"), "garbage");
    const removed = keeper.sweep();
    assert.deepEqual(
      removed.map((r) => [r.index, r.jobId, r.reason]),
      [
        [0, "dead", "holder gone"],
        [2, "old", "expired"],
      ],
    );
    assert.deepEqual(
      keeper.list().map((s) => [s.index, s.state]),
      [
        [1, "held"],
        [3, "unreadable"],
      ],
    );
  });

  test("list says who holds what", async () => {
    limit({ total: 3, perJob: 3 });
    await acquire("job-a", { pid: 4242 });
    const [slot] = keeper.list();
    assert.deepEqual(
      { index: slot?.index, jobId: slot?.jobId, pid: slot?.pid, state: slot?.state },
      { index: 0, jobId: "job-a", pid: 4242, state: "held" },
    );
    assert.equal(slot?.at, time.clock.now());
  });

  test("the timer sweeps and stops", async () => {
    limit({ total: 2, perJob: 2 });
    keeper.start();
    keeper.start();
    assert.equal(time.pending(), 1);
    createSlotFile(dir, 0, { jobId: "dead", pid: DEAD, at: time.clock.now() });
    await time.advance(30_000);
    assert.deepEqual(keeper.list(), []);
    keeper.stop();
    assert.equal(time.pending(), 0);
    keeper.stop();
  });

  test("a folder that does not exist yet is fine", () => {
    assert.deepEqual(keeper.list(), []);
    assert.deepEqual(keeper.sweep(), []);
  });
});

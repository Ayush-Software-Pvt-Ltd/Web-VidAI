// A seeded random walk over the whole life of the queues, checking the rules of docs/SPEC.md
// section 8 after every step: slots, the per-user limit, Urgent first and first in first out in
// every class, the start delay and the positions.

import test from "node:test";
import assert from "node:assert/strict";
import { plan, QUEUES } from "../../src/jobs/schedule.js";

const MIN = 60_000;

/** @param {number} seed */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @typedef {object} Sim
 * @property {string} id
 * @property {"edits" | "timeline" | "renders"} queue
 * @property {string} userId
 * @property {boolean} urgent
 * @property {number} joinedAt
 * @property {"queued" | "running" | "paused" | "ended"} state
 * @property {boolean} resume
 * @property {boolean} startNow
 */

/** @param {number} seed @param {number} steps */
function walk(seed, steps) {
  const random = mulberry32(seed);
  /** @param {number} n */
  const pick = (n) => Math.floor(random() * n);
  /** @type {Sim[]} */
  const jobs = [];
  const limits = { edits: 2, timeline: 2, renders: 1, perUser: 0, delayMin: 0 };
  const lastLaunch = { value: /** @type {number | null} */ (null) };
  let now = 1_000_000;
  let counter = 0;
  const users = ["u1", "u2", "u3"];

  /** @param {Sim["queue"]} queue */
  const slotsOf = (queue) => limits[queue];
  /** @param {Sim["queue"]} queue */
  const holdersOf = (queue) => jobs.filter((j) => j.queue === queue && j.state === "running");

  function schedule() {
    for (const queue of QUEUES) {
      const waiting = jobs.filter((j) => j.queue === queue && j.state === "queued");
      const running = holdersOf(queue);
      const edits = queue === "edits";
      const delayMs = edits ? limits.delayMin * MIN : 0;
      const result = plan({
        queue,
        waiting,
        running,
        limits: {
          slots: slotsOf(queue),
          perUser: edits ? limits.perUser : 0,
          startDelayMs: delayMs,
        },
        lastLaunchAt: edits ? lastLaunch.value : null,
        now,
      });

      // Positions are 1..n over the line.
      assert.deepEqual(
        [...result.positions.values()].sort((a, b) => a - b),
        waiting.map((_, i) => i + 1),
      );
      assert.equal(new Set(result.start).size, result.start.length);

      const free = Math.max(0, slotsOf(queue) - running.length);
      assert.ok(result.start.length <= free, "never more starts than free slots");

      // Apply the starts one by one, checking the per-user limit and the delay at each.
      const counts = new Map();
      for (const j of running) counts.set(j.userId, (counts.get(j.userId) ?? 0) + 1);
      let holding = running.length;
      let last = lastLaunch.value === null ? null : Math.min(lastLaunch.value, now);
      for (const id of result.start) {
        const j = /** @type {Sim} */ (jobs.find((x) => x.id === id));
        assert.equal(j.state, "queued");
        if (edits && limits.perUser > 0) {
          assert.ok(
            (counts.get(j.userId) ?? 0) < limits.perUser,
            "no user exceeds the limit by a start",
          );
        }
        if (edits && !j.resume && !j.startNow && delayMs > 0 && holding > 0 && last !== null) {
          assert.ok(now >= last + delayMs, "a fresh launch respects the delay");
        }
        counts.set(j.userId, (counts.get(j.userId) ?? 0) + 1);
        holding += 1;
        if (edits && !j.resume) last = now;
      }

      // After the starts: fairness among the jobs that were left waiting.
      const startedIds = new Set(result.start);
      const order = [...waiting].sort(
        (a, b) =>
          (edits ? Number(b.urgent) - Number(a.urgent) : 0) ||
          a.joinedAt - b.joinedAt ||
          (a.id < b.id ? -1 : 1),
      );
      /** @param {Sim} j */
      const eligible = (j) =>
        !(edits && limits.perUser > 0 && (counts.get(j.userId) ?? 0) >= limits.perUser);
      order.forEach((later, laterIndex) => {
        if (!startedIds.has(later.id)) return;
        for (const earlier of order.slice(0, laterIndex)) {
          if (startedIds.has(earlier.id) || !eligible(earlier)) continue;
          // An earlier job left waiting while a later one started: only a fresh job held by the
          // delay may be passed, and only by a resume or a Start now.
          assert.ok(edits, "the plain queues are strictly first in first out");
          assert.ok(!earlier.resume && !earlier.startNow, "a resume or Start now is never passed");
          assert.ok(later.resume || later.startNow, "only a resume or Start now passes a held job");
        }
      });
      // A non-Urgent job never starts while an eligible Urgent one waits (unless it is a resume
      // or Start now passing a delay).
      if (edits) {
        for (const j of order) {
          if (!startedIds.has(j.id) || j.urgent || j.resume || j.startNow) continue;
          for (const u of order) {
            if (u.urgent && !startedIds.has(u.id) && eligible(u)) {
              assert.fail(`non-Urgent ${j.id} started while Urgent ${u.id} waits`);
            }
          }
        }
      }
      // `startsAt` belongs to at most one waiting job, and only with a free slot.
      assert.ok(result.startsAt.size <= 1);
      if (result.startsAt.size === 1) {
        assert.ok(holding < slotsOf(queue), "a start time needs a free slot");
        assert.notEqual(result.wakeAt, null);
        assert.ok(/** @type {number} */ (result.wakeAt) > now);
      } else if (result.wakeAt !== null) {
        assert.fail("wakeAt without a start time");
      }

      for (const id of result.start) {
        const j = /** @type {Sim} */ (jobs.find((x) => x.id === id));
        j.state = "running";
        if (edits && !j.resume) lastLaunch.value = now;
        j.startNow = false;
      }
    }
  }

  for (let step = 0; step < steps; step += 1) {
    now += pick(4) * 30_000;
    const action = pick(10);
    if (action <= 2) {
      const queue = /** @type {Sim["queue"]} */ (QUEUES[pick(3)]);
      jobs.push({
        id: `j${(counter += 1)}`,
        queue,
        userId: users[pick(users.length)],
        urgent: queue === "edits" && pick(4) === 0,
        joinedAt: now,
        state: "queued",
        resume: false,
        startNow: false,
      });
    } else if (action === 3) {
      const running = jobs.filter((j) => j.state === "running");
      const j = running[pick(running.length)];
      if (j) j.state = "paused";
    } else if (action === 4) {
      const paused = jobs.filter((j) => j.state === "paused");
      const j = paused[pick(paused.length)];
      if (j) {
        j.state = "queued";
        j.resume = pick(4) !== 0;
      }
    } else if (action === 5) {
      const live = jobs.filter((j) => j.state !== "ended");
      const j = live[pick(live.length)];
      if (j) j.state = "ended";
    } else if (action === 6) {
      const running = jobs.filter((j) => j.state === "running");
      const j = running[pick(running.length)];
      if (j) j.state = "ended";
    } else if (action === 7) {
      const waiting = jobs.filter((j) => j.state === "queued" && j.queue === "edits");
      const j = waiting[pick(waiting.length)];
      if (j) j.urgent = !j.urgent;
    } else if (action === 8) {
      limits.edits = 1 + pick(4);
      limits.timeline = 1 + pick(3);
      limits.renders = 1 + pick(2);
      limits.perUser = pick(3);
      limits.delayMin = pick(3) === 0 ? 0 : 1 + pick(3);
    } else {
      const waiting = jobs.filter((j) => j.state === "queued" && j.queue === "edits");
      const j = waiting[pick(waiting.length)];
      if (j && pick(2) === 0) j.startNow = true;
    }
    schedule();
  }
}

test("random sequences keep every rule of the three queues", () => {
  for (let seed = 1; seed <= 1500; seed += 1) {
    try {
      walk(seed, 60);
    } catch (error) {
      if (error instanceof Error) error.message = `seed ${seed}: ${error.message}`;
      throw error;
    }
  }
});

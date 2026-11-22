// The per-key queue behind "one operation at a time per video" (docs/SPEC.md section 11).

import assert from "node:assert/strict";
import test from "node:test";
import { createKeyedQueue } from "../../src/timeline/keyedQueue.js";

/** Lets other tasks run. */
const turn = () => new Promise((resolve) => setImmediate(resolve));

test("operations of one key run one after the other, in the order asked", async () => {
  const queue = createKeyedQueue();
  /** @type {string[]} */
  const log = [];
  /** @param {string} name @param {number} turns */
  const job = (name, turns) => async () => {
    log.push(`start ${name}`);
    for (let i = 0; i < turns; i += 1) await turn();
    log.push(`end ${name}`);
    return name;
  };
  const results = await Promise.all([
    queue.run("v", job("a", 5)),
    queue.run("v", job("b", 1)),
    queue.run("v", job("c", 3)),
  ]);
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
});

test("different keys run side by side, and a failure never blocks the next operation", async () => {
  const queue = createKeyedQueue();
  /** @type {string[]} */
  const log = [];
  const slow = queue.run("one", async () => {
    log.push("one start");
    await turn();
    await turn();
    log.push("one end");
  });
  const other = queue.run("two", async () => void log.push("two"));
  await other;
  assert.deepEqual(log, ["one start", "two"]);
  await slow;
  const failing = queue.run("one", () => Promise.reject(new Error("boom")));
  const after = queue.run("one", () => "still runs");
  await assert.rejects(failing, /boom/);
  assert.equal(await after, "still runs");
  // A synchronous throw is a rejection too.
  await assert.rejects(
    queue.run("one", () => {
      throw new Error("sync");
    }),
    /sync/,
  );
});

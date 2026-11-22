// The queue of preview copies (docs/SPEC.md section 11, Preview copies): one at a time, shared
// files made once, cancel, stop, a failure remembered.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCopyQueue } from "../../src/timeline/proxyQueue.js";

const log = { info() {}, warn() {}, error() {}, debug() {} };

/** A queue whose copies end when the test says so. */
function setup() {
  /** @type {{ name: string, signal: AbortSignal, end: (outcome: "made" | "failed" | "cancelled") => void }[]} */
  const started = [];
  /** @type {string[]} */
  const finished = [];
  let changes = 0;
  const queue = createCopyQueue({
    log,
    run: (item, signal) =>
      new Promise((resolve) => {
        const entry = { name: item.name, signal, end: resolve };
        started.push(entry);
        signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
      }),
    onFinished: (item, outcome) => finished.push(`${item.name}:${outcome}`),
    onChange: () => {
      changes += 1;
    },
  });
  return { queue, started, finished, changes: () => changes };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("files are made one at a time, in the order they were wanted", async () => {
  const { queue, started, finished } = setup();
  queue.want({ name: "a" }, "v1");
  queue.want({ name: "b" }, "v1");
  queue.want({ name: "c" }, "v2");
  assert.deepEqual(
    started.map((s) => s.name),
    ["a"],
  );
  started[0]?.end("made");
  await tick();
  assert.deepEqual(
    started.map((s) => s.name),
    ["a", "b"],
  );
  started[1]?.end("made");
  await tick();
  started[2]?.end("made");
  await queue.idle();
  assert.deepEqual(finished, ["a:made", "b:made", "c:made"]);
});

test("a video that is open goes ahead of the ones waiting, but never ahead of the running one", async () => {
  const { queue, started } = setup();
  queue.want({ name: "a" }, "v1");
  queue.want({ name: "b" }, "v1");
  queue.want({ name: "c" }, "v2");
  queue.want({ name: "c" }, "v2", { first: true });
  queue.want({ name: "d" }, "v3", { first: true });
  started[0]?.end("made");
  await tick();
  assert.equal(started[1]?.name, "d");
  started[1]?.end("made");
  await tick();
  assert.equal(started[2]?.name, "c");
});

test("a file two videos need is made once", async () => {
  const { queue, started, finished } = setup();
  assert.equal(queue.want({ name: "shared" }, "v1"), true);
  assert.equal(queue.want({ name: "shared" }, "v2"), true);
  assert.equal(queue.want({ name: "other" }, "v2"), true);
  assert.equal(started.length, 1);
  started[0]?.end("made");
  await tick();
  started[1]?.end("made");
  await queue.idle();
  assert.deepEqual(finished, ["shared:made", "other:made"]);
});

test("cancelling a video drops what only it wanted", async () => {
  const { queue, started, finished } = setup();
  queue.want({ name: "a" }, "v1");
  queue.want({ name: "b" }, "v1");
  queue.want({ name: "c" }, "v2");
  queue.cancelVideo("v1");
  // "a" runs and nobody wants it any more: it is ended.
  assert.equal(started[0]?.signal.aborted, true);
  await tick();
  assert.deepEqual(
    started.map((s) => s.name),
    ["a", "c"],
  );
  started[1]?.end("made");
  await queue.idle();
  assert.deepEqual(finished, ["c:made"], "a cancelled copy is not reported as finished");
});

test("a running copy another video still wants keeps running", async () => {
  const { queue, started } = setup();
  queue.want({ name: "shared" }, "v1");
  queue.want({ name: "shared" }, "v2");
  queue.cancelVideo("v1");
  assert.equal(started[0]?.signal.aborted, false);
  assert.equal(queue.isRunning("shared"), true);
  queue.cancelVideo("v2");
  assert.equal(started[0]?.signal.aborted, true);
});

test("a failed copy is remembered and not tried again", async () => {
  const { queue, started } = setup();
  queue.want({ name: "bad" }, "v1");
  started[0]?.end("failed");
  await queue.idle();
  assert.equal(queue.hasFailed("bad"), true);
  assert.equal(queue.want({ name: "bad" }, "v1"), false);
  assert.equal(queue.want({ name: "bad" }, "v2", { first: true }), false);
  assert.equal(started.length, 1);
  // Another name (the file changed) is tried.
  assert.equal(queue.want({ name: "bad-changed" }, "v1"), true);
  assert.equal(started.length, 2);
});

test("a copy that throws counts as failed and the queue goes on", async () => {
  /** @type {string[]} */
  const ran = [];
  const queue = createCopyQueue({
    log,
    run: async (item) => {
      ran.push(item.name);
      if (item.name === "a") throw new Error("boom");
      return "made";
    },
  });
  queue.want({ name: "a" }, "v");
  queue.want({ name: "b" }, "v");
  await queue.idle();
  assert.deepEqual(ran, ["a", "b"]);
  assert.equal(queue.hasFailed("a"), true);
  assert.equal(queue.hasFailed("b"), false);
});

test("a cancelled copy is not a failure", async () => {
  const { queue, started } = setup();
  queue.want({ name: "a" }, "v1");
  queue.cancelVideo("v1");
  await tick();
  assert.equal(queue.hasFailed("a"), false);
  assert.equal(queue.want({ name: "a" }, "v1"), true);
  assert.equal(started.length, 2);
});

test("stop ends the running copy, forgets the rest and resolves", async () => {
  const { queue, started } = setup();
  queue.want({ name: "a" }, "v");
  queue.want({ name: "b" }, "v");
  await queue.stop();
  assert.equal(started[0]?.signal.aborted, true);
  assert.equal(started.length, 1, "b never starts");
  assert.equal(queue.busy(), false);
  assert.equal(queue.want({ name: "c" }, "v"), false, "nothing is accepted after stop");
  await queue.idle();
});

test("idle resolves at once when there is nothing to do, and after the last copy otherwise", async () => {
  const { queue, started } = setup();
  await queue.idle();
  queue.want({ name: "a" }, "v");
  let idle = false;
  void queue.idle().then(() => {
    idle = true;
  });
  await tick();
  assert.equal(idle, false);
  started[0]?.end("made");
  await tick();
  assert.equal(idle, true);
});

test("isPending covers waiting and running copies; changes are announced", async () => {
  const { queue, started, changes } = setup();
  queue.want({ name: "a" }, "v");
  queue.want({ name: "b" }, "v");
  assert.equal(queue.isPending("a"), true);
  assert.equal(queue.isPending("b"), true);
  assert.equal(queue.isRunning("b"), false);
  assert.equal(queue.isPending("zzz"), false);
  const before = changes();
  started[0]?.end("made");
  await tick();
  assert.ok(changes() > before);
  assert.equal(queue.isPending("a"), false);
});

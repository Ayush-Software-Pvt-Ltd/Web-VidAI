// The log store, the scrubber and the sink: round trip through a real file, secrets never reaching
// the file or the listener, and batching with injected timers.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  API_KEY_LABEL,
  MAX_LOG_DETAIL_CHARS,
  createLogSink,
  createLogStore,
  createScrubber,
  draft,
  errorDraft,
  statusDraft,
} from "../../src/jobs/log.js";

/** @typedef {import("../../src/jobs/log.js").JobLogBatch} JobLogBatch */

/**
 * A temp logs folder, removed when the test ends.
 * @param {import("node:test").TestContext} t
 * @returns {string}
 */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "logs");
}

/**
 * Timers the test advances by hand.
 * @returns {{ timers: import("../../src/jobs/log.js").Timers, advance(ms: number): void, pending(): number }}
 */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  /** @type {Map<number, { at: number, callback: () => void }>} */
  const queue = new Map();
  return {
    timers: {
      setTimeout(callback, ms) {
        const id = nextId;
        nextId += 1;
        queue.set(id, { at: now + ms, callback });
        return id;
      },
      clearTimeout(handle) {
        queue.delete(/** @type {number} */ (handle));
      },
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...queue.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (due === undefined) break;
        queue.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
    pending: () => queue.size,
  };
}

/**
 * A sink on a temp folder with fake timers and a recording listener.
 * @param {import("node:test").TestContext} t
 * @param {Partial<Parameters<typeof createLogSink>[0]>} [options]
 */
function setup(t, options = {}) {
  const dir = tempDir(t);
  const store = createLogStore({ dir });
  const clock = fakeTimers();
  /** @type {JobLogBatch[]} */
  const batches = [];
  /** @type {unknown[]} */
  const errors = [];
  const sink = createLogSink({
    store,
    notify: (batch) => batches.push(batch),
    timers: clock.timers,
    clock: { now: () => Date.parse("2026-11-22T10:00:00.000Z") },
    onError: (error) => errors.push(error),
    ...options,
  });
  return { dir, store, sink, clock, batches, errors };
}

test("an entry goes through the file and comes back unchanged", (t) => {
  const { store, sink, clock, batches } = setup(t);
  sink.push(
    "v1",
    "job1",
    [
      statusDraft("Claude Code is running"),
      draft("tool", "Bash: ls", { detail: "ls -la\nक \u{1F600}", nested: true }),
      errorDraft("boom"),
    ],
    "2026-11-22T10:00:00.000Z",
  );
  clock.advance(0);
  const expected = [
    {
      seq: 1,
      ts: "2026-11-22T10:00:00.000Z",
      kind: "status",
      text: "Claude Code is running",
      detail: null,
      nested: false,
    },
    {
      seq: 2,
      ts: "2026-11-22T10:00:00.000Z",
      kind: "tool",
      text: "Bash: ls",
      detail: "ls -la\nक \u{1F600}",
      nested: true,
    },
    {
      seq: 3,
      ts: "2026-11-22T10:00:00.000Z",
      kind: "error",
      text: "boom",
      detail: null,
      nested: false,
    },
  ];
  assert.deepEqual(store.read("job1"), expected);
  assert.deepEqual(batches, [{ videoId: "v1", jobId: "job1", entries: expected }]);
  // One JSON object per line, the key order of the Rust struct.
  const lines = fs.readFileSync(store.path("job1"), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.deepEqual(Object.keys(JSON.parse(lines[0] ?? "")), [
    "seq",
    "ts",
    "kind",
    "text",
    "detail",
    "nested",
  ]);
  assert.equal(path.basename(store.path("job1")), "job1.jsonl");
});

test("the default timestamp comes from the clock", (t) => {
  const { store, sink, clock } = setup(t);
  sink.push("v1", "job1", [statusDraft("x")]);
  clock.advance(0);
  assert.equal(store.read("job1")[0]?.ts, "2026-11-22T10:00:00.000Z");
});

test("a read gives the last entries and skips lines that cannot be read", (t) => {
  const { store, sink, clock } = setup(t);
  const drafts = Array.from({ length: 10 }, (_, i) => statusDraft(`line ${i}`));
  sink.push("v1", "job1", drafts);
  clock.advance(0);
  assert.deepEqual(
    store.read("job1", 3).map((e) => e.seq),
    [8, 9, 10],
  );
  assert.deepEqual(store.read("job1", 0), []);
  assert.deepEqual(store.read("missing"), []);
  // A crash cut the last line short and added junk; the next append starts on a new line.
  fs.appendFileSync(store.path("job1"), '{"seq":11,"ts":"x"\nnot json\n{"seq":"a"}\n{"seq":12');
  assert.equal(store.read("job1").length, 10);
  store.append("job1", [
    { seq: 13, ts: "t", kind: "status", text: "after", detail: null, nested: false },
  ]);
  assert.equal(store.read("job1").at(-1)?.text, "after");
  assert.equal(store.read("job1").length, 11);
});

test("job ids that are not plain file names are refused", (t) => {
  const { store } = setup(t);
  for (const id of ["", "../x", "a/b", "a b", ".", ".."]) {
    assert.throws(() => store.path(id), /Invalid job id/);
  }
});

test("seq numbers continue after the last one on disk and never repeat", (t) => {
  const { dir, sink, clock, batches } = setup(t);
  sink.push("v1", "job1", [statusDraft("a"), statusDraft("b")]);
  clock.advance(0);
  // A new sink (the server restarted) goes on after seq 2; another job starts at 1.
  const again = createLogSink({
    store: createLogStore({ dir }),
    notify: (batch) => batches.push(batch),
    timers: clock.timers,
  });
  again.push("v1", "job1", [statusDraft("c")]);
  again.push("v2", "job2", [statusDraft("d")]);
  again.flush();
  const seqs = batches.map((b) => [b.jobId, ...b.entries.map((e) => e.seq)]);
  assert.deepEqual(seqs, [
    ["job1", 1, 2],
    ["job1", 3],
    ["job2", 1],
  ]);
});

test("entries are batched: the first goes at once, then at most one batch per interval", (t) => {
  const { store, sink, clock, batches } = setup(t);
  sink.push("v1", "job1", [statusDraft("1")]);
  // Nothing has gone out before the event loop turns (pushes of the same turn share a batch).
  sink.push("v1", "job1", [statusDraft("2")]);
  assert.equal(batches.length, 0);
  clock.advance(0);
  assert.deepEqual(
    batches.map((b) => b.entries.map((e) => e.text)),
    [["1", "2"]],
  );
  // During the cooling period entries wait, in order, and go out together when it ends.
  sink.push("v1", "job1", [statusDraft("3")]);
  clock.advance(100);
  sink.push("v1", "job1", [statusDraft("4"), statusDraft("5")]);
  clock.advance(49);
  assert.equal(batches.length, 1);
  clock.advance(1);
  assert.deepEqual(
    batches.map((b) => b.entries.map((e) => e.text)),
    [
      ["1", "2"],
      ["3", "4", "5"],
    ],
  );
  // That batch started a new cooling period; a quiet interval ends it and the next entry is
  // delivered without delay again.
  clock.advance(150);
  assert.equal(clock.pending(), 0);
  sink.push("v1", "job1", [statusDraft("6")]);
  clock.advance(0);
  assert.equal(batches.length, 3);
  assert.deepEqual(
    store.read("job1").map((e) => [e.seq, e.text]),
    [
      [1, "1"],
      [2, "2"],
      [3, "3"],
      [4, "4"],
      [5, "5"],
      [6, "6"],
    ],
  );
});

test("jobs in one batch keep their own order", (t) => {
  const { sink, clock, batches } = setup(t);
  sink.push("v1", "a", [statusDraft("a1")]);
  sink.push("v2", "b", [statusDraft("b1")]);
  sink.push("v1", "a", [statusDraft("a2")]);
  clock.advance(0);
  assert.deepEqual(
    batches.map((b) => [b.videoId, b.jobId, b.entries.map((e) => e.text)]),
    [
      ["v1", "a", ["a1", "a2"]],
      ["v2", "b", ["b1"]],
    ],
  );
});

test("flush writes at once and close flushes and stops the timers", (t) => {
  const { store, sink, clock, batches } = setup(t);
  sink.push("v1", "job1", [statusDraft("x")]);
  assert.equal(sink.flush(), true);
  assert.equal(sink.flush(), false);
  assert.equal(store.read("job1").length, 1);
  clock.advance(0);
  assert.equal(batches.length, 1);
  sink.push("v1", "job1", [statusDraft("y")]);
  sink.close();
  assert.equal(clock.pending(), 0);
  assert.equal(store.read("job1").length, 2);
  // After close, entries are written at once.
  sink.push("v1", "job1", [statusDraft("z")]);
  assert.equal(store.read("job1").length, 3);
  assert.equal(clock.pending(), 0);
});

test("forget starts the numbering over for a job whose log was deleted", (t) => {
  const { store, sink, clock } = setup(t);
  sink.push("v1", "job1", [statusDraft("a"), statusDraft("b")]);
  clock.advance(0);
  store.remove("job1");
  store.remove("job1");
  sink.forget("job1");
  sink.push("v1", "job1", [statusDraft("c")]);
  clock.advance(150);
  assert.deepEqual(
    store.read("job1").map((e) => e.seq),
    [1],
  );
});

test("a failing write still reaches the listener and a failing listener does not stop the sink", (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // `logs` is a file, so every write fails.
  fs.writeFileSync(dir, "not a folder");
  const clock = fakeTimers();
  /** @type {string[]} */
  const seen = [];
  /** @type {unknown[]} */
  const errors = [];
  const sink = createLogSink({
    store: createLogStore({ dir }),
    notify: (batch) => {
      seen.push(...batch.entries.map((e) => e.text));
      if (batch.entries.length > 1) throw new Error("listener broke");
    },
    timers: clock.timers,
    onError: (error) => errors.push(error),
  });
  sink.push("v1", "job1", [statusDraft("one"), statusDraft("two")]);
  clock.advance(0);
  assert.deepEqual(seen, ["one", "two"]);
  assert.equal(errors.length, 2);
  sink.push("v1", "job1", [statusDraft("three")]);
  clock.advance(150);
  assert.deepEqual(seen, ["one", "two", "three"]);
});

test("the scrubber replaces a key everywhere and is exact about what it knows", () => {
  const scrubber = createScrubber();
  assert.equal(scrubber.scrub("sk-abc"), "sk-abc");
  scrubber.add("  ");
  scrubber.add("sk-abc");
  scrubber.add("sk-abc");
  assert.equal(scrubber.scrub("a sk-abc b sk-abc"), `a ${API_KEY_LABEL} b ${API_KEY_LABEL}`);
  // A longer secret that contains a shorter one is replaced whole.
  scrubber.add("sk-abc-longer", "[other key]");
  assert.equal(scrubber.scrub("x sk-abc-longer y"), "x [other key] y");
  // The form inside a JSON string is known too.
  scrubber.add('quo"te\\key');
  assert.equal(scrubber.scrub(JSON.stringify({ k: 'quo"te\\key' })), `{"k":"${API_KEY_LABEL}"}`);
});

test("a secret never reaches the file or the listener, whichever field it is in", (t) => {
  const key = "sk-live-0123456789abcdefghij";
  const { store, sink, clock, batches } = setup(t);
  sink.addSecret(key);
  sink.push("v1", "job1", [
    draft("assistant", `the key is ${key}.`),
    draft("tool", `Bash: curl -H "Authorization: ${key}"`, {
      detail: JSON.stringify({ command: `curl ${key}` }, null, 2),
    }),
    errorDraft(`bad key ${key}`, { detail: `request with ${key} failed` }),
  ]);
  clock.advance(0);
  const onDisk = fs.readFileSync(store.path("job1"), "utf8");
  assert.ok(!onDisk.includes(key));
  assert.ok(!JSON.stringify(batches).includes(key));
  assert.ok(onDisk.includes(API_KEY_LABEL));
  assert.equal(store.read("job1")[0]?.text, `the key is ${API_KEY_LABEL}.`);
});

test("a secret on the cut of the length limit does not leave a prefix", (t) => {
  const key = "sk-live-0123456789abcdefghij";
  const { store, sink, clock, batches } = setup(t);
  sink.addSecret(key);
  // The key starts 8 characters before the end: cutting first would leave "sk-li" in front of
  // the "...", while the scrubbed text is one character over the limit and is cut inside its label.
  const filler = "x".repeat(MAX_LOG_DETAIL_CHARS - 8);
  sink.push("v1", "job1", [draft("tool", "Bash: x", { detail: `${filler}${key}` })]);
  clock.advance(0);
  const detail = store.read("job1")[0]?.detail ?? "";
  assert.ok(!detail.includes("sk-"));
  assert.ok(!JSON.stringify(batches).includes("sk-"));
  assert.ok(Array.from(detail).length <= MAX_LOG_DETAIL_CHARS);
  assert.ok(detail.endsWith("..."));
});

test("a shared scrubber also covers keys added after the sink was made", (t) => {
  const scrubber = createScrubber();
  const { store, sink, clock } = setup(t, { scrubber });
  scrubber.add("later-secret-value");
  sink.push("v1", "job1", [statusDraft("uses later-secret-value now")]);
  clock.advance(0);
  assert.equal(store.read("job1")[0]?.text, `uses ${API_KEY_LABEL} now`);
  assert.equal(sink.scrub("later-secret-value"), API_KEY_LABEL);
});

test("long text and detail are cut to the limit, in code points", (t) => {
  const { store, sink, clock } = setup(t);
  sink.push("v1", "job1", [
    draft("assistant", "\u{1F600}".repeat(5000), { detail: "क".repeat(5000) }),
  ]);
  clock.advance(0);
  const [entry] = store.read("job1");
  assert.equal(Array.from(entry?.text ?? "").length, MAX_LOG_DETAIL_CHARS);
  assert.equal(Array.from(entry?.detail ?? "").length, MAX_LOG_DETAIL_CHARS);
});

test("a blank detail is stored as null and empty pushes do nothing", (t) => {
  const { store, sink, clock, batches } = setup(t);
  sink.push("v1", "job1", []);
  sink.push("v1", "job1", [draft("status", "x", { detail: "   " })]);
  clock.advance(0);
  assert.equal(batches.length, 1);
  assert.equal(store.read("job1")[0]?.detail, null);
});

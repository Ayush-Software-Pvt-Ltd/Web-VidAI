import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { createLineSplitter, runTool } from "../../src/render/tool.js";

/** A child that the test drives. */
function fakeChild(pid = 42) {
  const child = new EventEmitter();
  const out = new EventEmitter();
  const err = new EventEmitter();
  let stdinEnded = false;
  return Object.assign(child, {
    pid,
    stdout: out,
    stderr: err,
    stdin: { end: () => void (stdinEnded = true) },
    ended: () => stdinEnded,
    out,
    err,
  });
}

describe("line splitter", () => {
  it("splits on LF, CRLF and a bare CR and keeps the unfinished part", () => {
    /** @type {string[]} */
    const lines = [];
    const s = createLineSplitter((l) => lines.push(l));
    s.push("a\nb\r\nc\rd");
    s.push("e\n\n");
    s.end();
    assert.deepEqual(lines, ["a", "b", "c", "de"]);
  });
  it("emits a last line without a newline on end", () => {
    /** @type {string[]} */
    const lines = [];
    const s = createLineSplitter((l) => lines.push(l));
    s.push("tail");
    s.end();
    assert.deepEqual(lines, ["tail"]);
  });
});

describe("runTool", () => {
  it("reports the pid, streams lines, keeps output and calls the hooks in order", async () => {
    const child = fakeChild();
    /** @type {string[]} */
    const events = [];
    const started = runTool(
      { command: "x", args: [], env: {} },
      {
        spawn: () => /** @type {never} */ (child),
        onStart: (pid) => void events.push(`start:${pid}`),
        onEnd: (pid) => void events.push(`end:${pid}`),
        onLine: (line, stream) => void events.push(`${stream}:${line}`),
      },
    );
    assert.equal(started.pid, 42);
    assert.ok(child.ended());
    await new Promise((r) => setImmediate(r));
    child.out.emit("data", Buffer.from("one\ntw"));
    child.out.emit("data", "o\n");
    child.err.emit("data", "oops\n");
    child.emit("exit", 3, null);
    child.emit("close");
    const result = await started.done;
    assert.equal(result.code, 3);
    assert.equal(result.stdout, "one\ntwo\n");
    assert.equal(result.stderr, "oops\n");
    assert.equal(result.startError, null);
    assert.deepEqual(events, ["start:42", "stdout:one", "stdout:two", "stderr:oops", "end:42"]);
  });

  it("does not wait forever for pipes that stay open", async () => {
    const child = fakeChild();
    const started = runTool(
      { command: "x", args: [], env: {} },
      { spawn: () => /** @type {never} */ (child), closeWaitMs: 10 },
    );
    await new Promise((r) => setImmediate(r));
    child.emit("exit", 0, null);
    assert.equal((await started.done).code, 0);
  });

  it("never rejects: a throwing spawn and an error event become startError", async () => {
    const thrown = runTool(
      { command: "x", args: [], env: {} },
      {
        spawn: () => {
          throw new Error("no such program");
        },
      },
    );
    assert.equal(thrown.pid, null);
    assert.equal((await thrown.done).startError?.message, "no such program");

    const child = fakeChild(7);
    const failing = runTool(
      { command: "x", args: [], env: {} },
      {
        spawn: () => /** @type {never} */ (child),
        onStart: () => {
          throw new Error("registry down");
        },
      },
    );
    await new Promise((r) => setImmediate(r));
    child.emit("error", new Error("ENOENT"));
    const result = await failing.done;
    assert.equal(result.startError?.message, "ENOENT");
    assert.equal(result.code, null);
  });

  it("keeps only the last bytes when output is long", async () => {
    const child = fakeChild();
    const started = runTool(
      { command: "x", args: [], env: {} },
      { spawn: () => /** @type {never} */ (child), keepBytes: 5 },
    );
    await new Promise((r) => setImmediate(r));
    child.out.emit("data", "0123456789");
    child.emit("exit", 0, null);
    child.emit("close");
    assert.equal((await started.done).stdout, "56789");
  });
});

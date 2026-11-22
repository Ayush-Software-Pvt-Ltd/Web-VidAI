import { test } from "node:test";
import assert from "node:assert/strict";
import { TAIL_LINES, lineSplitter, runProcess } from "../../src/toolkit/run.js";
import { CAN_RUN_FAKE_PYTHON } from "../support/fake-python.js";

const posix = { skip: !CAN_RUN_FAKE_PYTHON && "needs a POSIX shell" };

test("lines are cut at every kind of line end, and the unfinished line is flushed", () => {
  /** @type {string[]} */
  const lines = [];
  const splitter = lineSplitter((line) => lines.push(line));
  splitter.push("one\ntw");
  splitter.push("o\r\nthree\r");
  splitter.push("\n\n   \nfour");
  assert.deepEqual(lines, ["one", "two", "three"]);
  splitter.flush();
  assert.deepEqual(lines, ["one", "two", "three", "four"]);
});

test("a program's output goes to onLine and the tail, stdout and stderr alike", posix, async () => {
  /** @type {string[]} */
  const seen = [];
  const result = await runProcess({
    command: "/bin/sh",
    args: ["-c", "echo out; echo err >&2; exit 3"],
    timeoutMs: 5000,
    onLine: (line) => seen.push(line),
  });
  assert.equal(result.started, true);
  assert.equal(result.code, 3);
  assert.deepEqual([...seen].sort(), ["err", "out"]);
  assert.deepEqual([...result.tail].sort(), ["err", "out"]);
});

test("only the last lines are kept", posix, async () => {
  const result = await runProcess({
    command: "/bin/sh",
    args: ["-c", `i=0; while [ $i -lt ${TAIL_LINES + 20} ]; do echo line$i; i=$((i+1)); done`],
    timeoutMs: 5000,
  });
  assert.equal(result.tail.length, TAIL_LINES);
  assert.equal(result.tail.at(-1), `line${TAIL_LINES + 19}`);
});

test("a program that runs too long is ended", posix, async () => {
  const result = await runProcess({ command: "/bin/sh", args: ["-c", "sleep 30"], timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test("aborting ends the program", posix, async () => {
  const controller = new AbortController();
  const done = runProcess({
    command: "/bin/sh",
    args: ["-c", "sleep 30"],
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const result = await done;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
});

test("a signal that is already aborted ends it at once", posix, async () => {
  const result = await runProcess({
    command: "/bin/sh",
    args: ["-c", "sleep 30"],
    timeoutMs: 30_000,
    signal: AbortSignal.abort(),
  });
  assert.equal(result.aborted, true);
});

test("a program that does not exist is reported, not thrown", async () => {
  const result = await runProcess({ command: "/nonexistent/python", timeoutMs: 1000 });
  assert.equal(result.started, false);
  assert.equal(result.code, null);
  assert.match(result.error ?? "", /does not exist|cannot start/);
});

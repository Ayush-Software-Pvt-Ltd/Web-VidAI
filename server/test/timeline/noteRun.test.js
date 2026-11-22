// The runner of the capture programs, with real child processes (a few node one-liners).

import assert from "node:assert/strict";
import { test } from "node:test";
import { startRun } from "../../src/timeline/noteRun.js";
import { isAlive } from "../../src/platform/process.js";

const node = process.execPath;

test("a program runs to its end and its output is returned", async () => {
  const run = startRun({
    command: node,
    args: ["-e", "console.log('out'); console.error('err'); process.exit(3)"],
    timeoutMs: 20_000,
  });
  const result = await run.done;
  assert.equal(result.code, 3);
  assert.equal(result.stdout.trim(), "out");
  assert.equal(result.stderr.trim(), "err");
  assert.equal(result.timedOut, false);
  assert.equal(result.stopped, false);
});

test("a program that runs too long is ended with its tree", async () => {
  const run = startRun({
    command: node,
    args: [
      "-e",
      "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000)",
    ],
    timeoutMs: 600,
  });
  const result = await run.done;
  assert.equal(result.timedOut, true);
  const grandchild = Number(result.stdout.trim());
  assert.ok(grandchild > 0);
  for (let i = 0; i < 40 && isAlive(grandchild); i += 1)
    await new Promise((r) => setTimeout(r, 50));
  assert.equal(isAlive(grandchild), false);
});

test("stop ends the program and says so", async () => {
  const run = startRun({
    command: node,
    args: ["-e", "console.log('up'); setInterval(()=>{},1000)"],
    timeoutMs: 60_000,
  });
  await new Promise((r) => setTimeout(r, 300));
  await run.stop();
  const result = await run.done;
  assert.equal(result.stopped, true);
  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
});

test("a program that cannot be started rejects", async () => {
  const run = startRun({ command: "/nonexistent/program", args: [], timeoutMs: 1000 });
  await assert.rejects(run.done, /does not exist|not an executable/);
});

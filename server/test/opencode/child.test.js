// The server process (with the cases the job engine tests cover through the fake): output lines, the wait for the listening line, the failure text, the
// end of the whole process tree.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_TIMINGS,
  LINE_BYTES,
  Output,
  PipeLines,
  TAIL_LINES,
  resolveTimings,
  spawnServer,
} from "../../src/agents/opencode/child.js";
import { listeningUrl } from "../../src/agents/opencode/launch.js";
import { isAlive } from "../../src/platform/process.js";
import { sleep, until, untilDead } from "./engineSupport.js";

const FAST = resolveTimings({
  pollMs: 2,
  drainMs: 300,
  stderrDrainMs: 100,
  failureOutputWaitMs: 300,
});

/**
 * A node program standing in for the server.
 * @param {string} script
 * @param {object} [options]
 * @param {{ now: () => number }} [options.clock]
 * @param {Partial<import("../../src/agents/opencode/child.js").Timings>} [options.timings]
 * @param {NodeJS.Platform} [options.platform]
 */
function start(script, options = {}) {
  return spawnServer({
    program: process.execPath,
    args: ["-e", script],
    cwd: os.tmpdir(),
    env: { PATH: process.env["PATH"] },
    listening: listeningUrl,
    timings: { ...FAST, ...options.timings },
    clock: options.clock ?? { now: () => Date.now() },
    platform: options.platform,
  });
}

/** Servers a test started, ended after it. @param {import("node:test").TestContext} t */
function ending(t) {
  /** @type {Array<ReturnType<typeof start>>} */
  const started = [];
  t.after(async () => {
    for (const child of started) await child.kill();
  });
  return /** @param {ReturnType<typeof start>} child */ (child) => {
    started.push(child);
    return child;
  };
}

/** A clock that advances `step` ms every time it is read, so waits take no real time. */
/** @param {number} step */
function steppingClock(step) {
  let now = 1_000;
  return {
    now() {
      now += step;
      return now;
    },
  };
}

test("lines split at newlines and carriage returns, half lines are kept, long ones cut", () => {
  const lines = new PipeLines();
  assert.deepEqual(lines.push(Buffer.from("one\ntw")), ["one"]);
  assert.equal(lines.half(), "tw");
  assert.deepEqual(lines.push(Buffer.from("o\r\n\r\nMigrating 10%\rMigrating 20%\r")), [
    "two",
    "Migrating 10%",
    "Migrating 20%",
  ]);
  assert.deepEqual(lines.push(Buffer.from("last")), []);
  assert.equal(lines.finish(), "last");
  assert.equal(lines.finish(), null);
  const long = new PipeLines();
  const done = long.push(Buffer.from(`${"x".repeat(LINE_BYTES + 500)}\n`));
  assert.equal(done[0]?.length, LINE_BYTES);
});

test("a character cut by a chunk edge stays whole", () => {
  const lines = new PipeLines();
  const bytes = Buffer.from("वीडियो\n");
  assert.deepEqual(lines.push(bytes.subarray(0, 4)), []);
  assert.deepEqual(lines.push(bytes.subarray(4)), ["वीडियो"]);
});

test("the output keeps the last lines and the half line of each stream", () => {
  const output = new Output();
  for (let i = 0; i < TAIL_LINES + 5; i += 1) output.push(`  line ${i}  `);
  output.push("   ");
  assert.equal(output.last(100).length, TAIL_LINES);
  assert.equal(output.last(1)[0], `line ${TAIL_LINES + 4}`);
  output.setPartial("out", "half out");
  output.setPartial("err", " ");
  assert.deepEqual(output.last(2), [`line ${TAIL_LINES + 4}`, "half out"]);
  output.setPartial("err", "half err");
  assert.deepEqual(output.last(2), ["half out", "half err"]);
  output.setPartial("out", "");
  output.setPartial("err", "");
  assert.deepEqual(output.last(2), [`line ${TAIL_LINES + 3}`, `line ${TAIL_LINES + 4}`]);
});

test("the defaults are the ones of the contract", () => {
  assert.equal(DEFAULT_TIMINGS.startLimitMs, 180_000);
  assert.equal(DEFAULT_TIMINGS.firstNoticeMs, 8_000);
  assert.equal(DEFAULT_TIMINGS.noticeEveryMs, 15_000);
  assert.equal(DEFAULT_TIMINGS.requestTimeoutMs, 30_000);
  assert.equal(DEFAULT_TIMINGS.subscribeTimeoutMs, 10_000);
  assert.equal(DEFAULT_TIMINGS.reconcileEveryMs, 30_000);
  assert.deepEqual(resolveTimings({ pollMs: 1 }), { ...DEFAULT_TIMINGS, pollMs: 1 });
});

const LISTEN = `console.log(JSON.stringify({url:"http://127.0.0.1:4321"}));`;

test("the listening line is found, and what comes after it is not kept", async (t) => {
  const keep = ending(t);
  const child = keep(
    start(
      `console.log("Warning: first");${LISTEN}console.log("after");process.stdin.resume();process.stdin.on("end",()=>process.exit(0));`,
    ),
  );
  assert.equal(await child.waitForUrl(() => {}), "http://127.0.0.1:4321");
  assert.equal(await child.end({ graceMs: 1_000 }), true);
  await child.exitedPromise;
  const report = await child.exitReport(Promise.resolve());
  assert.equal(report.code, 0);
  assert.deepEqual(report.stderrTail, ["Warning: first"]);
});

test("a line printed just before the exit still counts as the address", async (t) => {
  const keep = ending(t);
  const child = keep(start(LISTEN));
  assert.equal(await child.waitForUrl(() => {}), "http://127.0.0.1:4321");
});

test("a server that ends at once fails with what it printed", async (t) => {
  const keep = ending(t);
  const child = keep(start(`console.error("Error: cannot open the database");process.exit(1);`));
  await assert.rejects(
    () => child.waitForUrl(() => {}),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "OpenCode ended before it was ready");
      return true;
    },
  );
  const failure = await child.failure("OpenCode ended before it was ready");
  assert.equal(
    failure.message,
    "OpenCode ended before it was ready (Error: cannot open the database)",
  );
});

test("a failed start tells the last four lines, oldest first", async (t) => {
  const keep = ending(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-child-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "printed");
  const child = keep(
    start(
      `for (let i=1;i<=6;i++) console.error("e"+i);
process.stderr.write("",()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"x"));setInterval(()=>{},1000);`,
    ),
  );
  await until("the output", () => fs.existsSync(marker));
  const failure = await child.failure("boom");
  assert.equal(failure.message, "boom (e3 | e4 | e5 | e6)");
  assert.equal(isAlive(child.pid), false);
});

test("a server that stays silent hits the limit, says so with advice, and is ended", async (t) => {
  const keep = ending(t);
  const statuses = /** @type {string[]} */ ([]);
  const child = keep(start(`setInterval(()=>{},1000);`, { clock: steppingClock(2_000) }));
  /** @type {Error | null} */
  let error = null;
  try {
    await child.waitForUrl((text) => statuses.push(text));
  } catch (caught) {
    error = /** @type {Error} */ (caught);
  }
  assert.ok(error);
  assert.match(
    error.message,
    /^OpenCode did not become ready within 180 seconds, and it printed nothing\./,
  );
  assert.ok(
    error.message.includes(
      `run "${process.execPath} serve" in Terminal on the computer that runs VidAI; if that hangs too, reinstall OpenCode`,
    ),
    error.message,
  );
  assert.deepEqual(statuses.slice(0, 3), [
    "Still waiting for OpenCode to start (8 s)",
    "Still waiting for OpenCode to start (24 s)",
    "Still waiting for OpenCode to start (40 s)",
  ]);
  const pid = child.pid;
  const failure = await child.failure(error.message);
  assert.ok(failure.message.startsWith("OpenCode did not become ready"));
  assert.equal(isAlive(pid), false, "nothing of the server keeps running");
});

test("on Windows the advice names PowerShell", async (t) => {
  const keep = ending(t);
  const child = keep(
    start(`setInterval(()=>{},1000);`, {
      clock: steppingClock(100_000),
      platform: "win32",
    }),
  );
  await assert.rejects(
    () => child.waitForUrl(() => {}),
    /serve" in PowerShell on the computer that runs VidAI/,
  );
});

test("a server that printed something gets no silence advice, a progress display is not lost", async (t) => {
  const keep = ending(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-child-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "printed");
  // Carriage returns only, and the last piece has no line end at all.
  const child = keep(
    start(
      `process.stderr.write("Migrating database 0%\\r");process.stderr.write("Migrating database 99%",()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"x"));setInterval(()=>{},1000);`,
      { clock: steppingClock(30_000) },
    ),
  );
  await until("the output", () => fs.existsSync(marker));
  await sleep(20);
  /** @type {Error | null} */
  let error = null;
  try {
    await child.waitForUrl(() => {});
  } catch (caught) {
    error = /** @type {Error} */ (caught);
  }
  assert.ok(error);
  assert.ok(!error.message.includes("it printed nothing"), error.message);
  const failure = await child.failure(error.message);
  assert.ok(failure.message.includes("Migrating database 99%"), failure.message);
});

test("the exit comes after the stream finished, and stderr is the tail", async (t) => {
  const keep = ending(t);
  const child = keep(start(`${LISTEN}console.error("last words");process.exit(3);`));
  await child.waitForUrl(() => {});
  /** @type {() => void} */
  let release = () => {};
  const streamDone = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  let reported = false;
  const report = child.exitReport(streamDone).then((r) => {
    reported = true;
    return r;
  });
  await sleep(100);
  assert.equal(reported, false, "the exit waits for the event stream");
  release();
  const r = await report;
  assert.equal(r.code, 3);
  assert.equal(r.signal, null);
  assert.deepEqual(r.stderrTail, ["last words"]);
});

test("a stream that never finishes delays the exit by the drain time only", async (t) => {
  const keep = ending(t);
  const child = keep(start(`${LISTEN}process.exit(0);`));
  await child.waitForUrl(() => {});
  const begun = Date.now();
  await child.exitReport(new Promise(() => {}));
  assert.ok(Date.now() - begun < 2_000);
});

test("ending a server ends its whole tree, also tools in groups of their own that ignore SIGTERM", async (t) => {
  const keep = ending(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-child-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, "pids");
  const child = keep(
    start(
      `${LISTEN}const {spawn}=require("node:child_process");const fs=require("node:fs");
const a=spawn("sleep",["300"],{detached:true,stdio:"ignore"});
const b=spawn("sh",["-c",'trap "" TERM; while true; do sleep 1; done'],{detached:true,stdio:"ignore"});
fs.writeFileSync(${JSON.stringify(pidFile)},[a.pid,b.pid].join("\\n"));
setInterval(()=>{},1000);`,
    ),
  );
  await child.waitForUrl(() => {});
  const pids = (
    await until("the tool pids", () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8"))
  )
    .split("\n")
    .map(Number);
  assert.equal(pids.length, 2);
  assert.ok(pids.every((pid) => isAlive(pid)));
  assert.equal(await child.end({ graceMs: 500 }), true);
  await untilDead([child.pid, ...pids]);
});

test("a program that cannot be started is an error with its reason", () => {
  assert.throws(
    () =>
      spawnServer({
        program: path.join(os.tmpdir(), "no-such-opencode2"),
        args: [],
        cwd: os.tmpdir(),
        env: {},
        listening: listeningUrl,
        timings: FAST,
        clock: { now: () => Date.now() },
      }),
    (error) => /** @type {{ code?: string }} */ (error).code === "ENOENT",
  );
});

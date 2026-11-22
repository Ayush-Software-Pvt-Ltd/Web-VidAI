// The process registry (docs/SPEC.md section 6, "Leftover processes"): what a crashed server left
// behind is ended at the next start, and only what is still the same process.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createProcessRegistry, readRegistry } from "../../src/jobs/registry.js";
import { endTree, isAlive } from "../../src/platform/process.js";

const dirs = /** @type {string[]} */ ([]);
const children = /** @type {import("node:child_process").ChildProcess[]} */ ([]);

after(() => {
  for (const child of children)
    if (child.pid !== undefined && isAlive(child.pid)) child.kill("SIGKILL");
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function folder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-registry-"));
  dirs.push(dir);
  return dir;
}

/** A real process that lives until it is ended (`sleep 60`, a marker argument tells them apart). */
function sleeper(marker = "a") {
  const child = spawn("sleep", [String(60 + marker.length)], { stdio: "ignore", detached: true });
  child.unref();
  children.push(child);
  return /** @type {number} */ (child.pid);
}

/** @param {number} pid @param {number} [ms] */
async function gone(pid, ms = 3000) {
  for (let spent = 0; spent < ms; spent += 20) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isAlive(pid);
}

/** @param {string} file @param {Record<string, unknown>} [over] */
function make(file, over = {}) {
  return createProcessRegistry({
    file,
    isAlive,
    endTree,
    clock: { now: () => 5 },
    graceMs: 500,
    ...over,
  });
}

describe("process registry", () => {
  it("ends a leftover process of an earlier run and empties the file", async () => {
    const file = path.join(folder(), "processes.json");
    const pid = sleeper();
    await make(file).add({ jobId: "job-1", pid, startedAt: 1 });
    assert.equal(readRegistry(file).length, 1);

    const later = make(file);
    assert.equal(await later.endLeftovers(), 1);
    assert.equal(await gone(pid), true);
    assert.deepEqual(readRegistry(file), []);
    assert.deepEqual(later.entries(), []);
  });

  it("leaves a process alone that was removed before the crash", async () => {
    const file = path.join(folder(), "processes.json");
    const pid = sleeper();
    const registry = make(file);
    await registry.add({ jobId: "job-1", pid });
    await registry.remove(pid);
    assert.deepEqual(readRegistry(file), []);
    assert.equal(await make(file).endLeftovers(), 0);
    assert.equal(isAlive(pid), true);
  });

  it("never ends a reused pid: the recorded command line must still match", async () => {
    const file = path.join(folder(), "processes.json");
    const pid = sleeper();
    // The record says another program had this pid.
    await make(file).add({ jobId: "job-1", pid, command: "/usr/bin/some-other-program --old" });
    /** @type {number[]} */
    const ended = [];
    const registry = make(file, {
      endTree: async (/** @type {number} */ p) => {
        ended.push(p);
        return true;
      },
    });
    assert.equal(await registry.endLeftovers(), 0);
    assert.deepEqual(ended, []);
    assert.equal(isAlive(pid), true);
    assert.deepEqual(readRegistry(file), [], "the file is cleared all the same");
  });

  it("never ends an entry whose command line is unknown", async () => {
    const file = path.join(folder(), "processes.json");
    const pid = sleeper();
    await make(file).add({ jobId: "job-1", pid, command: "" });
    assert.equal(await make(file).endLeftovers(), 0);
    assert.equal(isAlive(pid), true);
  });

  it("skips a process that is already gone", async () => {
    const file = path.join(folder(), "processes.json");
    const pid = sleeper();
    await make(file).add({ jobId: "job-1", pid });
    process.kill(pid, "SIGKILL");
    assert.equal(await gone(pid), true);
    assert.equal(await make(file).endLeftovers(), 0);
  });

  it("treats a damaged file as empty", async () => {
    const file = path.join(folder(), "processes.json");
    for (const text of ["", "{not json", "{}", '"x"', "[1, 2]", '[{"pid":"x"}]']) {
      fs.writeFileSync(file, text);
      assert.deepEqual(readRegistry(file), [], text);
      assert.equal(await make(file).endLeftovers(), 0, text);
    }
    assert.deepEqual(readRegistry(path.join(path.dirname(file), "missing.json")), []);
  });

  it("writes by temporary name and rename, and keeps no temporary file", async () => {
    const dir = folder();
    const file = path.join(dir, "processes.json");
    const registry = make(file);
    await registry.add({ jobId: "job-1", pid: 999_991, command: "x" });
    await registry.add({ jobId: "job-2", pid: 999_992, command: "y" });
    assert.deepEqual(fs.readdirSync(dir), ["processes.json"]);
    assert.deepEqual(
      readRegistry(file).map((e) => e.pid),
      [999_991, 999_992],
    );
  });

  it("serializes changes and records a pid once", async () => {
    const file = path.join(folder(), "processes.json");
    const registry = make(file);
    await Promise.all([
      registry.add({ jobId: "job-1", pid: 999_993, command: "x" }),
      registry.add({ jobId: "job-1", pid: 999_993, command: "z" }),
      registry.add({ jobId: "job-1", pid: 999_994, command: "x" }),
      registry.remove(999_994),
    ]);
    const all = readRegistry(file);
    assert.equal(all.length, 1);
    assert.equal(all[0]?.command, "x");
    assert.equal(all[0]?.startedAt, 5);
  });

  it("gives the other processes of the same job as known pids", async () => {
    const file = path.join(folder(), "processes.json");
    const a = sleeper("a");
    const b = sleeper("bb");
    const registry = make(file);
    await registry.add({ jobId: "job-1", pid: a });
    await registry.add({ jobId: "job-1", pid: b });
    /** @type {Array<{ pid: number, known: number[] }>} */
    const calls = [];
    const later = make(file, {
      endTree: async (/** @type {number} */ pid, /** @type {any} */ o) => {
        calls.push({ pid, known: [...o.knownPids].sort() });
        return true;
      },
    });
    assert.equal(await later.endLeftovers(), 2);
    assert.deepEqual(calls[0]?.known, [a, b].sort());
  });

  it("goes on when a process cannot be ended", async () => {
    const file = path.join(folder(), "processes.json");
    const a = sleeper("a");
    await make(file).add({ jobId: "job-1", pid: a });
    const later = make(file, {
      endTree: async () => {
        throw new Error("no");
      },
    });
    assert.equal(await later.endLeftovers(), 0);
    assert.deepEqual(readRegistry(file), []);
  });
});

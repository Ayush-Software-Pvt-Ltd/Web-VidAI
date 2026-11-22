// One real test of the governor on this computer: a shell with two CPU burners, limited to 0.5
// processors. Short, with a generous bound, and nothing of it survives (also when it fails).

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { after, test } from "node:test";
import { endTree, listTree, treeCpuSeconds } from "../../src/platform/process.js";
import { systemProcessTable } from "../../src/platform/cpu.js";
import { createCpuGovernor } from "../../src/limits/throttle.js";

const POSIX_ONLY = process.platform === "win32" ? "needs a POSIX shell and ps" : false;

/** @type {number[]} */
const roots = [];
/** @type {ReturnType<typeof createCpuGovernor>[]} */
const governors = [];

after(async () => {
  for (const governor of governors) governor.stop();
  for (const root of roots) await endTree(root, { graceMs: 200 });
});

/** @param {number} pid */
function state(pid) {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "a real tree limited to 0.5 processors uses clearly less than two burners would",
  { skip: POSIX_ONLY },
  async () => {
    const child = spawn("sh", ["-c", "yes > /dev/null & yes > /dev/null & wait"], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    const root = /** @type {number} */ (child.pid);
    roots.push(root);

    /** @type {string[]} */
    const signalled = [];
    const governor = createCpuGovernor({
      clock: { now: () => Date.now() },
      intervalMs: 100,
      processes: {
        snapshot: systemProcessTable.snapshot,
        signal: (pid, signal) => {
          signalled.push(`${signal}:${pid}`);
          return systemProcessTable.signal(pid, signal);
        },
      },
    });
    governors.push(governor);
    governor.add("real", { rootPid: root, exempt: true });
    governor.setBudget("real", 0.5);

    const started = Date.now();
    await sleep(2500);
    const wall = (Date.now() - started) / 1000;
    const members = await listTree(root);
    const burners = members.filter((pid) => pid !== root);
    assert.equal(burners.length, 2, "two burners run");
    const used = await treeCpuSeconds(burners);
    // Unthrottled, two burners would use about 2 * wall. A loaded machine only lowers `used`.
    assert.ok(used < 0.6 * 2 * wall, `used ${used.toFixed(2)} CPU seconds in ${wall.toFixed(2)} s`);
    assert.ok(
      signalled.some((s) => s.startsWith("SIGSTOP:")),
      "the governor held them at least once",
    );
    assert.ok(
      signalled.every((s) => !s.endsWith(`:${root}`)),
      "the root was never signalled",
    );

    governor.remove("real");
    await sleep(100);
    for (const pid of members) {
      assert.ok(!state(pid).startsWith("T"), `process ${pid} is left stopped (${state(pid)})`);
    }
    assert.equal(await endTree(root, { graceMs: 500 }), true);
    assert.deepEqual(await listTree(root), []);
  },
);

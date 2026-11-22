import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  collectTree,
  collectWindowsTree,
  cpuByPid,
  endTree,
  isAlive,
  listTree,
  parseCpuTable,
  parseCpuTime,
  parsePs,
  parseWindowsCpu,
  parseWindowsProcesses,
  resume,
  runHelper,
  spawnAgent,
  suspend,
  treeCpuSeconds,
} from "../../src/platform/process.js";

const POSIX_ONLY = process.platform === "win32" ? "needs a POSIX shell and ps" : false;

/** @type {string[]} */
const dirs = [];
/** @type {number[]} */
const roots = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-process-"));
  dirs.push(dir);
  return dir;
}
after(async () => {
  for (const root of roots) await endTree(root, { graceMs: 100 });
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {() => boolean} condition
 * @param {string} what
 * @param {number} [ms]
 */
async function until(condition, what, ms = 20_000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** @param {number} pid */
function pgidOf(pid) {
  return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }));
}

/** Gone, or only a zombie that nobody collected yet. @param {number} pid */
function gone(pid) {
  if (!isAlive(pid)) return true;
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
      .trim()
      .startsWith("Z");
  } catch {
    return true;
  }
}

/** The id of a process that has ended. */
const deadPid = () => spawnSync("true").pid;

/** @param {string} file */
const readPid = (file) => Number(fs.readFileSync(file, "utf8").trim());

/** @param {number} pid @param {number} ppid @param {number} pgid @param {boolean} [zombie] */
const row = (pid, ppid, pgid, zombie = false) => ({ pid, ppid, pgid, zombie });

describe("parsers", () => {
  test("parsePs reads pid, ppid, pgid and the zombie state", () => {
    const text = [
      "    1     0     1 Ss",
      "  200     1   200 S+",
      "  300   200   200 Z",
      "  301   200   301 Ss+",
      "garbage",
      "",
    ].join("\n");
    assert.deepEqual(parsePs(text), [
      row(1, 0, 1),
      row(200, 1, 200),
      row(300, 200, 200, true),
      row(301, 200, 301),
    ]);
  });

  test("parseCpuTime reads every format of ps", () => {
    assert.equal(parseCpuTime("0:00.00"), 0);
    assert.equal(parseCpuTime("1:02.50"), 62.5);
    assert.equal(parseCpuTime("01:02:03"), 3723);
    assert.equal(parseCpuTime("1-02:03:04"), 86_400 + 7384);
    assert.equal(parseCpuTime("45"), 45);
    assert.equal(parseCpuTime(" 0:01.00 "), 1);
    assert.equal(parseCpuTime("abc"), null);
    assert.equal(parseCpuTime(""), null);
    assert.equal(parseCpuTime("1:2:3:4"), null);
  });

  test("parseCpuTable maps pids to seconds and skips bad lines", () => {
    const table = parseCpuTable("  10 0:01.50\n 11 01:00:00\nnope\n 12 x\n");
    assert.deepEqual(
      [...table],
      [
        [10, 1.5],
        [11, 3600],
      ],
    );
  });

  test("parseWindowsProcesses reads CSV, with a byte order mark and quotes", () => {
    const csv =
      '﻿"ProcessId","ParentProcessId","Start"\r\n"4","0","132000000000000000"\r\n"1000","4","133000000000000000"\r\n"1001","1000",""\r\n';
    assert.deepEqual(parseWindowsProcesses(csv), [
      { pid: 4, ppid: 0, start: 132000000000000000 },
      { pid: 1000, ppid: 4, start: 133000000000000000 },
      { pid: 1001, ppid: 1000, start: null },
    ]);
  });

  test("parseWindowsProcesses reads JSON, also a single object", () => {
    assert.deepEqual(
      parseWindowsProcesses('[{"ProcessId":5,"ParentProcessId":1,"Start":10},{"ProcessId":"x"}]'),
      [{ pid: 5, ppid: 1, start: 10 }],
    );
    assert.deepEqual(parseWindowsProcesses('{"processid":7,"parentprocessid":5}'), [
      { pid: 7, ppid: 5, start: null },
    ]);
    assert.deepEqual(parseWindowsProcesses("{broken"), []);
    assert.deepEqual(parseWindowsProcesses(""), []);
    assert.deepEqual(parseWindowsProcesses("garbage"), []);
  });

  test("parseWindowsCpu reads CSV and JSON", () => {
    assert.deepEqual(
      [...parseWindowsCpu('"Id","Cpu"\r\n"10","1.5"\r\n"11","0.25"\r\n')],
      [
        [10, 1.5],
        [11, 0.25],
      ],
    );
    assert.deepEqual([...parseWindowsCpu('{"Id":12,"Cpu":3}')], [[12, 3]]);
    assert.deepEqual([...parseWindowsCpu("")], []);
    assert.deepEqual([...parseWindowsCpu('"Id","Cpu"\r\n"10",""\r\n')], []);
  });
});

describe("collectTree", () => {
  const SELF = 9000;
  const options = { selfPid: SELF, selfPgid: 8000 };

  test("finds descendants by parent id, root first", () => {
    const rows = [row(500, 100, 500), row(501, 500, 500), row(502, 501, 777), row(900, 100, 900)];
    const tree = collectTree(rows, 500, options);
    assert.deepEqual(tree.pids, [500, 501, 502]);
  });

  test("includes members of the groups of members, also when the root is gone", () => {
    // 600 is gone; its group lives on under init.
    const rows = [row(601, 1, 600), row(602, 1, 600), row(700, 1, 700)];
    assert.deepEqual(collectTree(rows, 600, options).pids, [601, 602]);
    // A descendant that leads a group of its own brings that group along.
    const nested = [row(10, 1, 10), row(11, 10, 11), row(12, 1, 11), row(13, 1, 13)];
    assert.deepEqual(collectTree(nested, 10, options).pids, [10, 11, 12]);
    assert.deepEqual(collectTree(nested, 10, options).groups, [10, 11]);
  });

  test("known pids and their groups belong to the tree", () => {
    const rows = [row(10, 1, 10), row(20, 1, 20), row(21, 1, 20), row(30, 1, 30)];
    assert.deepEqual(collectTree(rows, 10, { ...options, knownPids: [20] }).pids, [10, 20, 21]);
  });

  test("never includes zombies, pid 1 and below, the server or the server's own group", () => {
    const rows = [
      row(1, 0, 1),
      row(500, 100, 500),
      row(501, 500, 500, true),
      row(502, 500, 8000),
      row(SELF, 500, 8000),
      row(503, SELF, 8000),
    ];
    const tree = collectTree(rows, 500, options);
    // 502 is a child of 500 by parent id, and is a member; its group is the server's, so the
    // group's other processes (SELF, 503) are not.
    assert.deepEqual(tree.pids, [500, 502]);
    assert.ok(!tree.groups.includes(8000));
    assert.deepEqual(collectTree(rows, 1, options).pids, []);
    assert.deepEqual(collectTree(rows, 0, options).pids, []);
  });

  test("an empty table or an unknown root gives nothing", () => {
    assert.deepEqual(collectTree([], 500, options).pids, []);
    assert.deepEqual(collectTree([row(1, 0, 1), row(200, 1, 200)], 500, options).pids, []);
  });

  test("reads the server's group from the rows when it is not given", () => {
    const rows = [row(process.pid, 1, 4242), row(500, 1, 500), row(501, 1, 4242)];
    assert.deepEqual(collectTree(rows, 500).pids, [500]);
  });
});

describe("collectWindowsTree", () => {
  const SELF = 99_999;
  const w = (
    /** @type {number} */ pid,
    /** @type {number} */ ppid,
    /** @type {number | null} */ start,
  ) => ({
    pid,
    ppid,
    start,
  });

  test("finds descendants that started after their parent", () => {
    const rows = [
      w(1000, 4, 100),
      w(1001, 1000, 200),
      w(1002, 1001, 300),
      // A reused parent id: this process started before the "parent" did.
      w(1003, 1000, 50),
      w(2000, 4, 100),
    ];
    assert.deepEqual(collectWindowsTree(rows, 1000, { selfPid: SELF }), [1000, 1001, 1002]);
  });

  test("unknown start times do not block, known pids are added, the server and System are not", () => {
    const rows = [
      w(1000, 4, null),
      w(1001, 1000, null),
      w(3000, 4, 5),
      w(SELF, 1000, 9),
      w(4, 0, 1),
      w(2, 1, 1),
    ];
    assert.deepEqual(
      collectWindowsTree(rows, 1000, { selfPid: SELF, knownPids: [3000] }),
      [1000, 1001, 3000],
    );
    assert.deepEqual(collectWindowsTree(rows, 4, { selfPid: SELF }), []);
  });
});

describe("isAlive", () => {
  test("this process is, nonsense and gone processes are not", () => {
    assert.equal(isAlive(process.pid), true);
    assert.equal(isAlive(0), false);
    assert.equal(isAlive(-5), false);
    assert.equal(isAlive(1.5), false);
    assert.equal(isAlive(2 ** 22 + 12345), false);
  });
});

describe("spawnAgent", { skip: POSIX_ONLY }, () => {
  test("pipes stdio, leads a process group of its own and passes the environment", async () => {
    const child = spawnAgent({
      command: "/bin/sh",
      args: ["-c", 'echo "$GREETING from $(pwd)"; read -r line; echo "got $line"; echo oops >&2'],
      cwd: fs.realpathSync(os.tmpdir()),
      env: { PATH: "/usr/bin:/bin", GREETING: "hello" },
    });
    roots.push(/** @type {number} */ (child.pid));
    assert.ok(/** @type {number} */ (child.pid) > 0);
    assert.equal(pgidOf(/** @type {number} */ (child.pid)), child.pid);
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.stdin.write("ping\n");
    await new Promise((resolve) => child.once("close", resolve));
    assert.equal(
      Buffer.concat(out).toString(),
      `hello from ${fs.realpathSync(os.tmpdir())}\ngot ping\n`,
    );
    assert.equal(Buffer.concat(err).toString(), "oops\n");
  });

  test("the child's environment is exactly the one given", async () => {
    const child = spawnAgent({
      command: "/usr/bin/env",
      env: { ONLY: "this" },
    });
    /** @type {Buffer[]} */
    const out = [];
    child.stdout.on("data", (c) => out.push(c));
    await new Promise((resolve) => child.once("close", resolve));
    assert.ok(Buffer.concat(out).toString().includes("ONLY=this"));
    assert.ok(!Buffer.concat(out).toString().includes("HOME="));
  });

  test("a missing program, a program that is no program and a missing folder throw", () => {
    const dir = tempDir();
    const plain = path.join(dir, "plain");
    fs.writeFileSync(plain, "x", { mode: 0o644 });
    assert.throws(() => spawnAgent({ command: path.join(dir, "missing") }), {
      code: "ENOENT",
      message: /does not exist/,
    });
    assert.throws(() => spawnAgent({ command: plain }), { code: "EACCES" });
    assert.throws(() => spawnAgent({ command: "/bin/sh", cwd: path.join(dir, "nope") }), {
      code: "ENOENT",
      message: /folder/,
    });
    assert.throws(
      () => spawnAgent({ command: "no-such-program-anywhere", env: { PATH: "/bin" } }),
      {
        code: "ENOENT",
      },
    );
  });
});

describe("process trees", { skip: POSIX_ONLY }, () => {
  /** A tree that ignores SIGTERM, with a group of its own, an orphan in the group and a loner. */
  const TREE_SCRIPT = [
    "trap '' TERM",
    `sh -c 'trap "" TERM; while :; do sleep 1; done' &`,
    'echo $! > "$1/stubborn"',
    "set -m",
    "sleep 300 &",
    'echo $! > "$1/own-group"',
    "set +m",
    '( sleep 300 & echo $! > "$1/orphan" ) &',
    '( set -m; sleep 300 & echo $! > "$1/loner" ) &',
    'echo ready > "$1/ready"',
    "while :; do sleep 1; done",
  ].join("\n");

  /** Starts the tree script; resolves with its pids. */
  async function startTree() {
    const dir = tempDir();
    const script = path.join(dir, "tree.sh");
    fs.writeFileSync(script, `#!/bin/sh\n${TREE_SCRIPT}\n`, { mode: 0o755 });
    const child = spawnAgent({ command: script, args: [dir], env: { PATH: "/usr/bin:/bin" } });
    const root = /** @type {number} */ (child.pid);
    roots.push(root);
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.on("error", () => {});
    await until(() => fs.existsSync(path.join(dir, "ready")), "the tree");
    await until(() => fs.existsSync(path.join(dir, "loner")), "the loner");
    await until(() => fs.existsSync(path.join(dir, "orphan")), "the orphan");
    const pid = (/** @type {string} */ name) => readPid(path.join(dir, name));
    return {
      root,
      stubborn: pid("stubborn"),
      ownGroup: pid("own-group"),
      orphan: pid("orphan"),
      loner: pid("loner"),
    };
  }

  test("listTree finds children, group members and known pids", async () => {
    const t = await startTree();
    try {
      assert.equal(pgidOf(t.ownGroup), t.ownGroup, "the child leads a group of its own");
      assert.equal(pgidOf(t.orphan), t.root, "the orphan stays in the root's group");
      await until(() => !gone(t.root) && pgidOf(t.orphan) === t.root, "the orphan");
      const tree = await listTree(t.root);
      assert.equal(tree[0], t.root);
      for (const pid of [t.stubborn, t.ownGroup, t.orphan]) {
        assert.ok(tree.includes(pid), `${pid} is in the tree`);
      }
      assert.ok(!tree.includes(t.loner), "a stranger in a group of its own is not");
      assert.ok(!tree.includes(process.pid));
      const known = await listTree(t.root, [t.loner]);
      assert.ok(known.includes(t.loner));
    } finally {
      await endTree(t.root, { graceMs: 100, knownPids: [t.loner] });
    }
  });

  test("endTree ends programs that ignore SIGTERM, in groups of their own, and orphans", async () => {
    const t = await startTree();
    const all = [t.root, t.stubborn, t.ownGroup, t.orphan, t.loner];
    const started = Date.now();
    const done = await endTree(t.root, { graceMs: 300, knownPids: [t.loner] });
    assert.equal(done, true);
    assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
    for (const pid of all) assert.ok(gone(pid), `${pid} is gone`);
    assert.ok(isAlive(process.pid));
    assert.deepEqual(await listTree(t.root), []);
  });

  test("endTree waits for the grace time when a program stops by itself", async () => {
    const child = spawnAgent({
      command: "/bin/sh",
      args: ["-c", "while :; do sleep 1; done"],
      env: { PATH: "/usr/bin:/bin" },
    });
    const root = /** @type {number} */ (child.pid);
    roots.push(root);
    child.stdout.resume();
    child.stderr.resume();
    const started = Date.now();
    assert.equal(await endTree(root, { graceMs: 5000 }), true);
    // SIGTERM is enough: no need to wait for the grace time.
    assert.ok(Date.now() - started < 3000);
    assert.ok(gone(root));
  });

  test("endTree of a tree that is already gone, and of nothing, is true at once", async () => {
    assert.equal(await endTree(2 ** 22 + 4321), true);
    assert.equal(await endTree(0), true);
    assert.equal(await endTree(1), true);
    assert.ok(isAlive(process.pid));
  });
});

describe("cpu time and freezing", { skip: POSIX_ONLY }, () => {
  /** @param {number} root */
  async function cpu(root) {
    return treeCpuSeconds(await listTree(root));
  }

  test("treeCpuSeconds grows for a busy tree and suspend and resume freeze and thaw it", async () => {
    const child = spawnAgent({
      command: "/bin/sh",
      args: ["-c", "while :; do :; done"],
      env: { PATH: "/usr/bin:/bin" },
    });
    const root = /** @type {number} */ (child.pid);
    roots.push(root);
    child.stdout.resume();
    child.stderr.resume();
    const deadline = Date.now() + 20_000;
    while ((await cpu(root)) < 0.2) {
      assert.ok(Date.now() < deadline, "cpu time never grew");
      await sleep(100);
    }
    const byPid = await cpuByPid([root, deadPid()]);
    assert.ok((byPid.get(root) ?? 0) >= 0.2);
    assert.equal(byPid.size, 1, "a process that ended has no entry");

    assert.equal(await suspend(root), true);
    await sleep(150);
    const frozenA = await cpu(root);
    await sleep(600);
    const frozenB = await cpu(root);
    assert.ok(frozenB - frozenA < 0.05, `grew by ${frozenB - frozenA} while frozen`);

    assert.equal(await resume(root), true);
    const thawed = Date.now() + 20_000;
    while ((await cpu(root)) - frozenB < 0.2) {
      assert.ok(Date.now() < thawed, "cpu time did not grow after resume");
      await sleep(100);
    }
  });

  test("treeCpuSeconds of nothing is 0", async () => {
    assert.equal(await treeCpuSeconds([]), 0);
    assert.equal(await treeCpuSeconds([deadPid()]), 0);
  });

  test("suspend of a tree that is gone is false", async () => {
    assert.equal(await suspend(2 ** 22 + 77), false);
    assert.equal(await resume(2 ** 22 + 77), false);
  });
});

describe("runHelper", { skip: POSIX_ONLY }, () => {
  const env = { PATH: "/usr/bin:/bin" };

  test("collects output and the exit code", async () => {
    const result = await runHelper({
      command: "/bin/sh",
      args: ["-c", "echo out; echo err >&2; exit 3"],
      env,
      timeoutMs: 10_000,
    });
    assert.deepEqual(result, {
      code: 3,
      signal: null,
      stdout: "out\n",
      stderr: "err\n",
      timedOut: false,
    });
  });

  test("has no stdin to wait for", async () => {
    const result = await runHelper({ command: "/bin/cat", env, timeoutMs: 10_000 });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  });

  test("ends the whole tree at the time limit", async () => {
    const dir = tempDir();
    const started = Date.now();
    const result = await runHelper({
      command: "/bin/sh",
      args: ["-c", `sleep 30 & echo $! > ${dir}/child; wait`],
      env,
      timeoutMs: 400,
    });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 8000);
    const child = readPid(path.join(dir, "child"));
    await until(() => gone(child), "the child to end");
  });

  test("a grandchild holding the pipes does not hold the result for long", async () => {
    const started = Date.now();
    const result = await runHelper({
      command: "/bin/sh",
      args: ["-c", "echo done; (sleep 3) &"],
      env,
      timeoutMs: 10_000,
    });
    assert.equal(result.stdout, "done\n");
    assert.ok(Date.now() - started < 5000);
  });

  test("rejects when the program cannot be started", async () => {
    await assert.rejects(runHelper({ command: "/no/such/helper", env, timeoutMs: 1000 }), {
      code: "ENOENT",
    });
  });
});

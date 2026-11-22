import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { createEventBus } from "../../src/events.js";
import { createLimitsModule } from "../../src/limits/index.js";
import { createFakeLog, createFakeTable, createFakeTime } from "./fakes.js";

/** @type {string[]} */
const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A Windows helper that answers every request and ends when its stdin ends. */
function createAutoHelper() {
  /** @type {string[]} */
  const written = [];
  /** @type {((line: string) => void)[]} */
  const lines = [];
  /** @type {((code: number | null) => void)[]} */
  const exits = [];
  const helper = {
    write(/** @type {string} */ line) {
      written.push(line);
      const request = /** @type {{ id: number }} */ (JSON.parse(line));
      queueMicrotask(() => lines.forEach((l) => l(JSON.stringify({ id: request.id, ok: true }))));
    },
    onLine: (/** @type {(line: string) => void} */ l) => {
      lines.push(l);
    },
    onExit: (/** @type {(code: number | null) => void} */ l) => {
      exits.push(l);
    },
    end: () => queueMicrotask(() => exits.forEach((l) => l(0))),
    kill: () => {},
  };
  return {
    helper,
    ready: () => lines.forEach((l) => l('{"ready":true}')),
    requests: () => written.map((l) => /** @type {Record<string, unknown>} */ (JSON.parse(l))),
  };
}

/**
 * @param {{ platform?: string, processors?: number, settings?: Record<string, number>, events?: boolean }} [options]
 */
function setup({ platform = "darwin", processors = 8, settings = {}, events = false } = {}) {
  const time = createFakeTime();
  const log = createFakeLog();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-limits-"));
  made.push(root);
  const values = {
    cpuPerEditPercent: 100,
    cpuTotalPercent: 100,
    gpuPerEditPercent: 100,
    gpuTotalPercent: 100,
    ...settings,
  };
  const table = createFakeTable(time.clock);
  const win = createAutoHelper();
  const bus = createEventBus();
  const module = createLimitsModule({
    settings: {
      getAll: () => /** @type {import("../../../src/lib/wire.ts").AdminSettings} */ (values),
    },
    dataDir: root,
    clock: time.clock,
    timers: time.timers,
    log,
    platform,
    processors,
    isAlive: () => true,
    ...(events ? { events: bus } : {}),
    limiterOptions:
      platform === "win32"
        ? {
            spawnHelper: () => {
              queueMicrotask(win.ready);
              return win.helper;
            },
            listTree: async (pid) => [pid],
          }
        : { processes: table.processes },
  });
  return { time, log, root, values, table, win, bus, module, api: module.api };
}

/** @type {ReturnType<typeof setup>} */
let ctx;
afterEach(async () => {
  await ctx?.module.stop();
});

/** The rates the Windows helper was asked for, in order. @param {ReturnType<typeof setup>} c */
const rates = (c) => c.win.requests().filter((r) => r.op === "setRate");

describe("environment and state", () => {
  beforeEach(() => {
    ctx = setup({ processors: 8, settings: { cpuPerEditPercent: 50, cpuTotalPercent: 100 } });
  });

  test("envFor says the cores the job will have, where its GPU slots are, and who it is", () => {
    const env = ctx.api.envFor("job-1");
    assert.deepEqual(Object.keys(env).sort(), ["VE_CPU_CORES", "VE_GPU_SLOTS_DIR", "VE_JOB_ID"]);
    assert.equal(env.VE_CPU_CORES, "4");
    assert.equal(env.VE_JOB_ID, "job-1");
    assert.equal(env.VE_GPU_SLOTS_DIR, path.join(ctx.root, "locks", "gpu"));
  });

  test("the cores follow the number of jobs running, counted with the one being started", () => {
    // 8 processors, 50% per edit = 4, total 8: two jobs get 4 each, three get 8/3 -> 3 cores.
    ctx.api.jobStarted("a", { rootPid: null, kind: "edit" });
    ctx.api.jobStarted("b", { rootPid: null, kind: "edit" });
    assert.equal(ctx.api.envFor("c").VE_CPU_CORES, "3");
    assert.equal(ctx.api.envFor("a").VE_CPU_CORES, "4", "a running job is not counted twice");
    assert.deepEqual(ctx.api.cpuState(), { processors: 8, running: 2, budget: 4 });
    ctx.api.jobEnded("b");
    assert.equal(ctx.api.cpuState().running, 1);
    ctx.api.jobEnded("b");
    ctx.api.jobEnded("a");
    assert.equal(ctx.api.cpuState().running, 0);
  });

  test("jobStarted returns what the job runs with", () => {
    assert.deepEqual(ctx.api.jobStarted("a", { rootPid: null, kind: "render" }), {
      budget: 4,
      cpuCores: 4,
      renderWorkers: 4,
    });
    const second = ctx.api.jobStarted("b", { rootPid: null, kind: "render" });
    assert.equal(second.budget, 4);
    const third = ctx.api.jobStarted("c", { rootPid: null, kind: "render" });
    assert.ok(Math.abs(third.budget - 8 / 3) < 1e-9);
    assert.equal(third.cpuCores, 3);
    assert.equal(third.renderWorkers, 1, "under 4 processors a render uses one worker");
  });

  test("start writes limits.json from the settings, stop is final and idempotent", async () => {
    const file = path.join(ctx.root, "locks", "gpu", "limits.json");
    assert.equal(fs.existsSync(file), false);
    ctx.module.start();
    ctx.module.start();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { total: 8, perJob: 8 });
    assert.equal(ctx.time.pending(), 1, "the slot sweep");
    await ctx.module.stop();
    await ctx.module.stop();
    assert.equal(ctx.time.pending(), 0);
  });
});

describe("a per-edit value above the total (SPEC section 5: shown as limited by the total)", () => {
  // The settings store what the admin typed and never refuse it; the value that takes effect for a
  // job is the smaller of the two, so a page reads `min(per edit, total)` or these numbers.
  test("the cores of a job: the total caps the per-edit value", () => {
    ctx = setup({ processors: 8, settings: { cpuPerEditPercent: 100, cpuTotalPercent: 25 } });
    // 8 processors: per edit 8, total 2. One job gets 2, not 8; two jobs share the 2.
    assert.equal(ctx.api.envFor("a").VE_CPU_CORES, "2");
    assert.equal(ctx.api.limitsFor("a").budget, 2);
    assert.deepEqual(ctx.api.jobStarted("a", { rootPid: null, kind: "edit" }), {
      budget: 2,
      cpuCores: 2,
      renderWorkers: 1,
    });
    assert.deepEqual(ctx.api.cpuState(), { processors: 8, running: 1, budget: 2 });
    ctx.api.jobStarted("b", { rootPid: null, kind: "edit" });
    assert.equal(ctx.api.cpuState().budget, 1);
  });

  test("the GPU tasks of a job: the total caps the per-edit value", () => {
    ctx = setup({ settings: { gpuPerEditPercent: 100, gpuTotalPercent: 25 } });
    assert.deepEqual(ctx.api.gpuState(), { total: 2, perJob: 2, slots: [] });
    ctx.module.start();
    const written = JSON.parse(
      fs.readFileSync(path.join(ctx.root, "locks", "gpu", "limits.json"), "utf8"),
    );
    assert.deepEqual(written, { total: 2, perJob: 2 });
  });

  test("the stored per-edit value is not changed: only the effect is limited", async () => {
    ctx = setup({ processors: 8, settings: { cpuPerEditPercent: 100, cpuTotalPercent: 25 } });
    assert.equal(ctx.values.cpuPerEditPercent, 100);
    ctx.values.cpuTotalPercent = 100;
    ctx.api.refresh();
    // Raising the total lets the stored per-edit value take effect again.
    assert.equal(ctx.api.envFor("a").VE_CPU_CORES, "8");
  });
});

describe("GPU", () => {
  test("gpuState lists the limits of the settings and who holds what; jobEnded frees slots", async () => {
    ctx = setup({ settings: { gpuTotalPercent: 38, gpuPerEditPercent: 25 } });
    ctx.module.start();
    assert.deepEqual(ctx.api.gpuState(), { total: 3, perJob: 2, slots: [] });
    const held = await ctx.api.acquireGpuSlot("job-1");
    const state = ctx.api.gpuState();
    assert.equal(state.slots.length, 1);
    assert.equal(state.slots[0]?.jobId, "job-1");
    assert.equal(state.slots[0]?.state, "held");
    ctx.api.jobEnded("job-1");
    assert.deepEqual(ctx.api.gpuState().slots, []);
    held.release();
  });

  test("a waiting render can be aborted", async () => {
    ctx = setup({ settings: { gpuTotalPercent: 13, gpuPerEditPercent: 13 } });
    ctx.module.start();
    const held = await ctx.api.acquireGpuSlot("a");
    const controller = new AbortController();
    const waiting = ctx.api.acquireGpuSlot("b", controller.signal);
    const settled = assert.rejects(waiting, { name: "AbortError" });
    await ctx.time.advance(2000);
    controller.abort();
    await settled;
    held.release();
  });
});

describe("settings changes", () => {
  test("settings-changed on the event bus rewrites limits.json and the budgets", async () => {
    ctx = setup({
      platform: "win32",
      settings: { cpuTotalPercent: 50 },
      events: true,
    });
    ctx.module.start();
    const file = path.join(ctx.root, "locks", "gpu", "limits.json");
    ctx.api.jobStarted("a", { rootPid: 500, kind: "render" });
    await flush();
    await flush();
    assert.deepEqual(rates(ctx).at(-1)?.rate, 5000, "4 of 8 processors");

    ctx.values.cpuTotalPercent = 25;
    ctx.values.gpuTotalPercent = 50;
    ctx.values.gpuPerEditPercent = 25;
    ctx.bus.emit({ event: "settings-changed", payload: null, userId: null, admins: true });
    await flush();
    await flush();
    assert.equal(rates(ctx).at(-1)?.rate, 2500);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { total: 4, perJob: 2 });

    ctx.bus.emit({ event: "something-else", payload: null, userId: null, admins: true });
    const before = rates(ctx).length;
    await flush();
    assert.equal(rates(ctx).length, before);

    // After stop the module no longer listens.
    await ctx.module.stop();
    ctx.values.gpuTotalPercent = 100;
    ctx.bus.emit({ event: "settings-changed", payload: null, userId: null, admins: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { total: 4, perJob: 2 });
  });

  test("refresh does the same without the event bus, and only rewrites a changed limits.json", () => {
    ctx = setup();
    ctx.module.start();
    const file = path.join(ctx.root, "locks", "gpu", "limits.json");
    const before = fs.statSync(file).ino;
    ctx.api.refresh();
    assert.equal(fs.statSync(file).ino, before, "unchanged limits are not written again");
    ctx.values.gpuTotalPercent = 25;
    ctx.api.refresh();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { total: 2, perJob: 2 });
  });

  test("an unwritable limits folder is logged, never thrown", () => {
    ctx = setup();
    fs.mkdirSync(path.join(ctx.root, "locks"), { recursive: true });
    fs.writeFileSync(path.join(ctx.root, "locks", "gpu"), "a file, not a folder");
    ctx.module.start();
    assert.ok(ctx.log.lines.some((l) => l.level === "warn" && /limits\.json/.test(l.message)));
  });
});

describe("Windows", () => {
  test("8 processors at 50%: one job gets rate 5000, a second halves both", async () => {
    ctx = setup({ platform: "win32", settings: { cpuTotalPercent: 50 } });
    ctx.api.jobStarted("a", { rootPid: 500, kind: "render" });
    await flush();
    await flush();
    ctx.api.jobStarted("b", { rootPid: 600, kind: "render" });
    await flush();
    await flush();
    const ops = ctx.win.requests();
    assert.deepEqual(
      ops.filter((r) => r.op === "create").map((r) => r.job),
      ["a", "b"],
    );
    assert.deepEqual(
      rates(ctx).map((r) => [r.job, r.rate]),
      [
        ["a", 5000],
        ["a", 2500],
        ["b", 2500],
      ],
    );
    ctx.api.jobEnded("b");
    await flush();
    await flush();
    assert.deepEqual(rates(ctx).at(-1) && [rates(ctx).at(-1)?.job, rates(ctx).at(-1)?.rate], [
      "a",
      5000,
    ]);
    assert.ok(ctx.win.requests().some((r) => r.op === "close" && r.job === "b"));
  });

  test("a job inside the server (no root pid) counts but gets no Job Object", async () => {
    ctx = setup({ platform: "win32", settings: { cpuTotalPercent: 50 } });
    ctx.api.jobStarted("a", { rootPid: null, kind: "proxy" });
    ctx.api.jobStarted("b", { rootPid: 600, kind: "render" });
    await flush();
    await flush();
    assert.deepEqual(
      ctx.win
        .requests()
        .filter((r) => r.op === "create")
        .map((r) => r.job),
      ["b"],
    );
    assert.equal(rates(ctx).at(-1)?.rate, 2500, "shared with the job inside the server");
  });
});

describe("macOS", () => {
  test("a render is held by the governor, an agent's root is never signalled", async () => {
    ctx = setup({ processors: 4, settings: { cpuTotalPercent: 25 } });
    ctx.table.spawn({ pid: 100, rate: 1 });
    ctx.table.spawn({ pid: 101, ppid: 100, rate: 4 });
    ctx.table.spawn({ pid: 200, rate: 4 });
    ctx.api.jobStarted("edit-1", { rootPid: 100, kind: "edit" });
    ctx.api.jobStarted("render-1", { rootPid: 200, kind: "render" });
    // 4 processors, total 25% = 1, two jobs: 0.5 each.
    assert.deepEqual(ctx.api.cpuState(), { processors: 4, running: 2, budget: 0.5 });
    for (let i = 0; i < 40; i += 1) await ctx.time.advance(500);
    assert.equal(ctx.table.count(100, "SIGSTOP"), 0, "the agent program itself");
    assert.ok(ctx.table.count(101, "SIGSTOP") > 0, "its children are held");
    assert.ok(ctx.table.count(200, "SIGSTOP") > 0, "a render's root is held too");

    ctx.api.resumeAll("render-1");
    assert.deepEqual(ctx.table.stoppedAmong([200]), []);
    ctx.api.jobEnded("render-1");
    ctx.api.jobEnded("edit-1");
    for (let i = 0; i < 4; i += 1) await ctx.time.advance(500);
    assert.deepEqual(ctx.table.stoppedAmong([100, 101, 200]), []);
  });

  test("stop continues everything that is frozen", async () => {
    ctx = setup({ processors: 4, settings: { cpuTotalPercent: 25 } });
    ctx.table.spawn({ pid: 200, rate: 4 });
    ctx.api.jobStarted("render-1", { rootPid: 200, kind: "render" });
    for (let i = 0; i < 20 && ctx.table.stoppedAmong([200]).length === 0; i += 1) {
      await ctx.time.advance(500);
    }
    assert.deepEqual(ctx.table.stoppedAmong([200]), [200]);
    await ctx.module.stop();
    assert.deepEqual(ctx.table.stoppedAmong([200]), []);
  });

  test("resumeLeftovers continues stopped processes of an earlier run", async () => {
    ctx = setup();
    ctx.table.spawn({ pid: 300 });
    ctx.table.processes.signal(300, "SIGSTOP");
    assert.equal(await ctx.api.resumeLeftovers([300]), 1);
    assert.deepEqual(ctx.table.stoppedAmong([300]), []);
  });

  test("terminate answers false: the caller's endTree does it", async () => {
    ctx = setup();
    assert.equal(await ctx.api.terminate("nope"), false);
  });
});

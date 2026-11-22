import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { createCpuGovernor, resumeLeftovers } from "../../src/limits/throttle.js";
import { createFakeLog, createFakeTable, createFakeTime } from "./fakes.js";

const ROOT = 100;

/**
 * A governor over a fake table with an agent root (pid 100, exempt) and `children` busy children.
 * @param {{ budget?: number, children?: number, rate?: number, exempt?: boolean, burstSeconds?: number }} [options]
 */
function setup({ budget = 0.5, children = 2, rate = 1, exempt = true, burstSeconds } = {}) {
  const time = createFakeTime();
  const table = createFakeTable(time.clock);
  const exitSource = new EventEmitter();
  const log = createFakeLog();
  const governor = createCpuGovernor({
    clock: time.clock,
    timers: time.timers,
    processes: table.processes,
    exitSource,
    log,
    ...(burstSeconds === undefined ? {} : { burstSeconds }),
  });
  table.spawn({ pid: ROOT, ppid: 1, rate: 0.01 });
  /** @type {number[]} */
  const kids = [];
  for (let i = 1; i <= children; i += 1) {
    table.spawn({ pid: ROOT + i, ppid: ROOT, pgid: ROOT, rate });
    kids.push(ROOT + i);
  }
  governor.add("job", { rootPid: ROOT, exempt });
  governor.setBudget("job", budget);
  return { time, table, governor, kids, exitSource, log };
}

describe("the CPU governor", () => {
  test("a job ahead of its budget is suspended and later resumed", async () => {
    const { time, table, governor, kids } = setup({ budget: 0.5, children: 2 });
    await time.advance(500); // 2 processors used for half a second against 0.5: far ahead
    assert.deepEqual(table.stoppedAmong(kids), kids);
    assert.deepEqual(governor.inspect("job")?.held, kids);
    assert.ok((governor.inspect("job")?.balance ?? 0) < 0);
    // The debt is 1.0 - 0.25 = 0.75 CPU seconds, repaid at 0.5 per second: resumed after 1.5 s.
    await time.advance(1000);
    assert.deepEqual(table.stoppedAmong(kids), kids);
    await time.advance(500);
    assert.deepEqual(table.stoppedAmong(kids), []);
    for (const pid of kids) {
      assert.equal(table.count(pid, "SIGSTOP"), 1);
      assert.equal(table.count(pid, "SIGCONT"), 1);
    }
    governor.stop();
  });

  test("the exempt root is never signalled", async () => {
    const { time, table, governor } = setup({ budget: 0.5, children: 3 });
    await time.advance(20_000);
    assert.ok(table.signals.length > 0);
    assert.deepEqual(table.signalsTo(ROOT), []);
    governor.stop();
    assert.deepEqual(table.signalsTo(ROOT), []);
  });

  test("a render counts and holds its whole tree, root included", async () => {
    const { time, table, governor } = setup({ budget: 0.5, children: 0, exempt: false });
    table.get(ROOT).rate = 2;
    await time.advance(1000);
    assert.equal(table.procs.get(ROOT)?.stopped, true);
    assert.equal(table.count(ROOT, "SIGSTOP"), 1);
    governor.remove("job");
    assert.equal(table.procs.get(ROOT)?.stopped, false);
  });

  for (const budget of [0.5, 1, 1.5, 2.5, 3]) {
    test(`the average over 10 minutes is within 5 percent of a budget of ${budget}`, async () => {
      const { time, table, governor } = setup({ budget, children: 4, rate: 1 });
      await time.advance(500);
      const before = table.totalCpu();
      await time.advance(600_000);
      const seconds = 600;
      const average = (table.totalCpu() - before) / seconds;
      assert.ok(
        Math.abs(average - budget) / budget < 0.05,
        `budget ${budget}, average ${average.toFixed(3)}`,
      );
      governor.stop();
    });
  }

  test("a single process that cannot use the budget is never held", async () => {
    const { time, table, governor, kids } = setup({ budget: 2, children: 1, rate: 1 });
    await time.advance(60_000);
    assert.deepEqual(table.signals, []);
    assert.deepEqual(table.stoppedAmong(kids), []);
    governor.stop();
  });

  test("an unlimited job is never held and keeps no history", async () => {
    const { time, table, governor } = setup({ budget: 0.1, children: 2 });
    governor.setBudget("job", Infinity);
    await time.advance(20_000);
    assert.deepEqual(table.signals, []);
    assert.deepEqual(governor.inspect("job")?.measured, []);
    governor.stop();
  });

  test("new children are picked up at the next sample", async () => {
    const { time, table, governor } = setup({ budget: 0.5, children: 0 });
    await time.advance(500);
    // A grandchild appears (a child of a child) and burns two processors.
    table.spawn({ pid: 150, ppid: ROOT, pgid: ROOT, rate: 0 });
    table.spawn({ pid: 151, ppid: 150, pgid: ROOT, rate: 2 });
    await time.advance(500);
    // First seen now; what it used since it began (1.0 s of CPU in half a second) is charged.
    assert.deepEqual(governor.inspect("job")?.measured, [150, 151]);
    assert.equal(table.procs.get(151)?.stopped, true);
    governor.stop();
  });

  test("processes that left their parent but stay known are still measured", async () => {
    const { time, table, governor, kids } = setup({ budget: 0.5, children: 1 });
    await time.advance(500);
    // The child leaves the group and is handed to init, as a daemon does.
    const child = table.procs.get(kids[0] ?? 0);
    assert.ok(child);
    child.ppid = 1;
    child.pgid = 4242;
    await time.advance(2000);
    assert.ok(table.count(child.pid, "SIGSTOP") >= 1);
    governor.stop();
  });

  test("a process that vanished is forgotten without a signal", async () => {
    const { time, table, governor, kids } = setup({ budget: 0.5, children: 2 });
    await time.advance(1000);
    assert.deepEqual(governor.inspect("job")?.held, kids);
    const [gone, stays] = kids;
    table.kill(gone ?? 0);
    const before = table.signals.length;
    await time.advance(500);
    assert.deepEqual(governor.inspect("job")?.held, [stays]);
    assert.deepEqual(governor.inspect("job")?.measured, [stays]);
    assert.ok(table.signals.slice(before).every((s) => s.pid !== gone));
    governor.stop();
  });

  test("a pid reused by an unrelated process is never signalled", async () => {
    const { time, table, governor, kids } = setup({ budget: 0.5, children: 2 });
    await time.advance(1000);
    const [reused, other] = kids;
    assert.deepEqual(governor.inspect("job")?.held, kids);
    // The held child ends and a stranger gets its pid (another start time, no relation).
    table.kill(reused ?? 0);
    const stranger = table.spawn({ pid: reused ?? 0, ppid: 1, pgid: 777, rate: 5 });
    const before = table.signals.length;
    await time.advance(20_000);
    assert.equal(stranger.stopped, false);
    assert.ok(table.signals.slice(before).every((s) => s.pid !== reused));
    assert.deepEqual(governor.inspect("job")?.held.includes(reused ?? 0), false);
    assert.ok(table.count(other ?? 0, "SIGSTOP") >= 1);
    governor.stop();
  });

  test("a stranger that took the root's pid is not adopted, nor its children", async () => {
    const { time, table, governor } = setup({ budget: 0.5, children: 0 });
    await time.advance(1000);
    table.kill(ROOT);
    table.spawn({ pid: ROOT, ppid: 1, pgid: 888, rate: 3 });
    table.spawn({ pid: 300, ppid: ROOT, pgid: 888, rate: 3 });
    await time.advance(20_000);
    assert.deepEqual(table.signals, []);
    assert.deepEqual(governor.inspect("job")?.measured, []);
    governor.stop();
  });

  test("the burst cap: an idle job cannot bank credit", async () => {
    const { time, table, governor, kids } = setup({ budget: 1, children: 1, rate: 0 });
    await time.advance(600_000); // ten idle minutes
    assert.ok((governor.inspect("job")?.balance ?? 0) <= 2 + 1e-9, "the cap is 2 s of budget");
    const child = table.procs.get(kids[0] ?? 0);
    assert.ok(child);
    child.rate = 4;
    const before = table.totalCpu();
    await time.advance(10_000);
    const used = table.totalCpu() - before;
    // 10 s at a budget of 1, plus the cap of 2 s, plus up to one interval at full speed.
    assert.ok(used <= 10 + 2 + 2.5, `used ${used.toFixed(2)}`);
    assert.ok(used >= 8, `used ${used.toFixed(2)}`);
    governor.stop();
  });

  test("a job paused by someone else is left alone and earns no credit", async () => {
    const { time, table, governor, kids } = setup({ budget: 0.5, children: 2 });
    await time.advance(500);
    // The job manager's pause: resumeAll first, then the whole tree, root included, is frozen.
    governor.resumeAll("job");
    for (const pid of [ROOT, ...kids]) table.get(pid).stopped = true;
    const before = table.signals.length;
    await time.advance(60_000);
    assert.equal(table.signals.length, before);
    assert.ok((governor.inspect("job")?.balance ?? 0) <= 0);
    governor.stop();
  });

  test("when the root is gone everything held is let go", async () => {
    const { time, table, governor, kids } = setup({ budget: 0.5, children: 2 });
    await time.advance(1000);
    assert.deepEqual(table.stoppedAmong(kids), kids);
    table.kill(ROOT);
    await time.advance(500);
    assert.deepEqual(table.stoppedAmong(kids), []);
    governor.stop();
  });

  test("resumeAll continues everything and the job stays watched", async () => {
    const { time, table, governor, kids } = setup({ budget: 0.5, children: 2 });
    await time.advance(1000);
    governor.resumeAll("job");
    assert.deepEqual(table.stoppedAmong(kids), []);
    assert.deepEqual(governor.inspect("job")?.held, []);
    await time.advance(1000);
    assert.deepEqual(table.stoppedAmong(kids), kids, "held again because it is still ahead");
    governor.stop();
  });

  test("remove continues everything and forgets the job", async () => {
    const { time, table, governor, kids } = setup({ budget: 0.5, children: 2 });
    await time.advance(1000);
    assert.deepEqual(table.stoppedAmong(kids), kids);
    governor.remove("job");
    assert.deepEqual(table.stoppedAmong(kids), []);
    assert.equal(governor.inspect("job"), null);
    assert.equal(time.pending(), 0, "the timer is gone with the last job");
    const count = table.signals.length;
    await time.advance(10_000);
    assert.equal(table.signals.length, count);
    governor.remove("job"); // twice is fine
  });

  test("stop continues every job's processes, never throws, and is final", async () => {
    const { time, table, governor, kids, exitSource } = setup({ budget: 0.5, children: 2 });
    table.spawn({ pid: 200, ppid: 1, rate: 0 });
    table.spawn({ pid: 201, ppid: 200, pgid: 200, rate: 2 });
    governor.add("second", { rootPid: 200, exempt: true });
    governor.setBudget("second", 0.5);
    assert.equal(exitSource.listenerCount("exit"), 1);
    await time.advance(1500);
    assert.deepEqual(table.stoppedAmong([...kids, 201]), [...kids, 201]);
    table.failOn(kids[0] ?? 0); // one process cannot be signalled
    assert.doesNotThrow(() => governor.stop());
    assert.deepEqual(table.stoppedAmong([kids[1] ?? 0, 201]), []);
    assert.equal(time.pending(), 0);
    assert.equal(exitSource.listenerCount("exit"), 0);
    assert.doesNotThrow(() => governor.stop());
    governor.add("late", { rootPid: ROOT, exempt: true });
    assert.equal(governor.inspect("late"), null, "nothing is added after stop");
  });

  test("the exit of the process continues everything", async () => {
    const { time, table, governor, kids, exitSource } = setup({ budget: 0.5, children: 2 });
    await time.advance(1000);
    assert.deepEqual(table.stoppedAmong(kids), kids);
    exitSource.emit("exit");
    assert.deepEqual(table.stoppedAmong(kids), []);
    assert.equal(governor.inspect("job"), null);
  });

  test("an exception in one job's sample leaves nothing of it suspended and the others go on", async () => {
    const { time, table, governor, kids, log } = setup({ budget: 0.5, children: 2 });
    table.spawn({ pid: 200, ppid: 1, rate: 0 });
    table.spawn({ pid: 201, ppid: 200, pgid: 200, rate: 1 });
    table.spawn({ pid: 202, ppid: 200, pgid: 200, rate: 1 });
    governor.add("bad", { rootPid: 200, exempt: true });
    governor.setBudget("bad", 0.5);
    table.failOn(202); // stopping 202 throws; 201 may already be stopped by then
    await time.advance(1000);
    await time.advance(500);
    assert.deepEqual(
      table.stoppedAmong([201, 202]),
      [],
      "nothing of the failing job is left stopped",
    );
    assert.ok(log.lines.some((l) => l.level === "warn" && l.message.includes("bad")));
    assert.deepEqual(table.stoppedAmong(kids), kids, "the other job is limited as usual");
    governor.stop();
  });

  test("a process table that cannot be read releases everything and the governor recovers", async () => {
    const { time, table, governor, kids } = setup({ budget: 0.5, children: 2 });
    await time.advance(1000);
    assert.deepEqual(table.stoppedAmong(kids), kids);
    table.state.snapshotNull = true;
    await time.advance(500);
    assert.deepEqual(table.stoppedAmong(kids), []);
    table.state.snapshotNull = false;
    table.state.snapshotError = new Error("ps exploded");
    await time.advance(500);
    table.state.snapshotError = null;
    await time.advance(2000);
    assert.deepEqual(table.stoppedAmong(kids), kids, "the debt is still there, held again");
    governor.stop();
  });

  test("setBudget on an unknown job does nothing", () => {
    const { governor } = setup();
    assert.doesNotThrow(() => governor.setBudget("nope", 1));
    assert.doesNotThrow(() => governor.resumeAll("nope"));
    governor.stop();
  });

  test("adding a key again continues what the old job held", async () => {
    const { time, table, governor, kids } = setup({ budget: 0.5, children: 2 });
    await time.advance(1000);
    governor.add("job", { rootPid: ROOT, exempt: true });
    assert.deepEqual(table.stoppedAmong(kids), []);
    governor.stop();
  });
});

describe("resumeLeftovers", () => {
  test("continues the whole tree of each pid and nothing else", async () => {
    const time = createFakeTime();
    const table = createFakeTable(time.clock);
    table.spawn({ pid: 500, ppid: 1 });
    table.spawn({ pid: 501, ppid: 500, pgid: 500 });
    table.spawn({ pid: 502, ppid: 501, pgid: 502 }); // its own group, still a descendant
    table.spawn({ pid: 900, ppid: 1 });
    for (const pid of [500, 501, 502, 900]) table.get(pid).stopped = true;
    const sent = await resumeLeftovers([500], { processes: table.processes });
    assert.equal(sent, 3);
    assert.deepEqual(table.stoppedAmong([500, 501, 502, 900]), [900]);
  });

  test("never throws, also when the table cannot be read", async () => {
    const time = createFakeTime();
    const table = createFakeTable(time.clock);
    table.spawn({ pid: 500, ppid: 1 });
    table.get(500).stopped = true;
    table.state.snapshotError = new Error("no ps");
    assert.equal(await resumeLeftovers([500], { processes: table.processes }), 0);
    table.state.snapshotError = null;
    table.state.snapshotNull = true;
    assert.equal(await resumeLeftovers([500], { processes: table.processes }), 1);
    assert.equal(table.procs.get(500)?.stopped, false);
  });
});

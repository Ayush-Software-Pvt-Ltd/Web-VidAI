import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AppError } from "../../src/errors.js";
import {
  DEFAULT_TIMINGS,
  createClaudeService,
  metersWanted,
} from "../../src/agents/claude/service.js";
import { control, fakeClient, fakeClock, fakeTimers, settle } from "../support/claudeControl.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * A service on a fake clock, fake timers and fake helper processes.
 * @param {{ wanted?: boolean, bin?: string | null, loggedIn?: boolean, timings?: Partial<import("../../src/agents/claude/service.js").ServiceTimings> }} [options]
 */
function rig(options = {}) {
  const clock = fakeClock();
  const timers = fakeTimers();
  /** What the fake helpers answer; a function gets the call number of that helper. */
  const state = {
    wanted: options.wanted ?? true,
    bin: options.bin === undefined ? "/bin/claude" : options.bin,
    loggedIn: options.loggedIn ?? true,
    /** @type {unknown} */
    initialize: control("initialize.json"),
    /** @type {unknown} */
    settings: control("get_settings.json"),
    /** @type {any} */
    usage: control("get_usage.json"),
  };
  /** @type {ReturnType<typeof fakeClient>[]} */
  const clients = [];
  /** @type {import("../../src/agents/claude/control.js").StartControlOptions[]} */
  const starts = [];
  /** @type {import("../../../src/lib/wire/usage.ts").UsageStatus[]} */
  const usageEvents = [];
  /** @type {Array<[import("../../../src/lib/wire/usage.ts").ClaudeInfo, import("../../../src/lib/wire/usage.ts").ClaudeInfo]>} */
  const infoEvents = [];
  /** @type {string[]} */
  const logs = [];
  const service = createClaudeService({
    helperDir: "/unused/claude-helper",
    env: () => ({ PATH: "/bin" }),
    clock,
    timers,
    wanted: () => state.wanted,
    locate: async () => state.bin,
    isLoggedIn: async () => state.loggedIn,
    startClient(opts) {
      starts.push(opts);
      const client = fakeClient({
        startedAt: clock.now(),
        answers: {
          initialize: () => state.initialize,
          get_settings: () => state.settings,
          get_usage: (/** @type {number} */ n) =>
            typeof state.usage === "function" ? state.usage(n) : state.usage,
        },
      });
      clients.push(client);
      return client;
    },
    onUsage: (status) => usageEvents.push(status),
    onInfo: (info, previous) => infoEvents.push([info, previous]),
    log: (message) => logs.push(message),
    timings: options.timings,
  });
  /** @param {string} subtype */
  const count = (subtype) =>
    clients.reduce((sum, c) => sum + c.calls.filter((call) => call === subtype).length, 0);
  /** Advances the clock by `ms` and runs one tick. @param {number} ms */
  const tickAfter = async (ms) => {
    clock.advance(ms);
    timers.fire();
    await settle();
  };
  return {
    clock,
    timers,
    state,
    clients,
    starts,
    usageEvents,
    infoEvents,
    logs,
    service,
    usageCalls: () => count("get_usage"),
    infoFetches: () => clients.filter((c) => c.calls.includes("get_settings")).length,
    tickAfter,
  };
}

test("the helper is wanted for the Claude subscription only", () => {
  assert.equal(metersWanted("claudeSubscription"), true);
  for (const setup of ["opencodeGo", "anthropicApi", "openaiApi", "other", ""]) {
    assert.equal(metersWanted(setup), false, setup);
  }
});

test("the default schedule is the documented one", () => {
  assert.deepEqual(DEFAULT_TIMINGS, {
    usageIntervalVisibleMs: MIN,
    usageIntervalJobsMs: 5 * MIN,
    helperMaxAgeMs: HOUR,
    helperIdleMs: 10 * MIN,
    usageTimeoutMs: 30_000,
    tickMs: 5000,
    infoRetryEmptyMs: MIN,
    infoRetryMs: HOUR,
    infoMaxAgeMs: 24 * HOUR,
  });
});

describe("a setup that does not use the helper", () => {
  test("nothing is started, nothing is asked", async () => {
    const r = rig({ wanted: false });
    await r.service.start();
    assert.equal((await r.service.refreshUsage()).available, false);
    assert.equal((await r.service.refreshInfo()).models.length, 0);
    r.service.setWatchers(2);
    r.service.setJobsRunning(true);
    await r.tickAfter(10 * HOUR);
    assert.equal(r.starts.length, 0);
    assert.equal(r.usageEvents.length, 0);
    assert.equal(r.service.usage().error, null);
    await r.service.stop();
  });
});

describe("not ready", () => {
  test("Claude Code not installed is an error on the status", async () => {
    const r = rig({ bin: null });
    const status = await r.service.refreshUsage();
    assert.equal(status.available, false);
    assert.equal(status.error, "Claude Code is not installed on the server.");
    assert.equal(r.starts.length, 0);
    await assert.rejects(
      r.service.refreshInfo(),
      (e) => e instanceof AppError && e.code === "notReady",
    );
  });

  test("not logged in is an error on the status", async () => {
    const r = rig({ loggedIn: false });
    const status = await r.service.refreshUsage();
    assert.equal(status.error, "Claude Code is not logged in on the server.");
    assert.equal(r.starts.length, 0);
    assert.equal(r.usageEvents.length, 1);
  });

  test("the last values stay when a refresh fails", async () => {
    const r = rig();
    await r.service.refreshUsage();
    r.state.loggedIn = false;
    const status = await r.service.refreshUsage();
    assert.equal(status.limits.length, 3);
    assert.equal(status.available, true);
    assert.match(status.error ?? "", /not logged in/);
  });
});

describe("start", () => {
  test("fetches the model list and the usage once, in helpers of the data directory", async () => {
    const r = rig();
    await r.service.start();
    assert.equal(r.service.info().models.length, 7);
    assert.equal(r.service.info().defaultModel, "fable");
    assert.equal(r.service.usage().available, true);
    assert.equal(r.service.usage().limits.length, 3);
    assert.equal(r.service.usage().error, null);
    assert.equal(r.usageEvents.length, 1);
    assert.equal(r.infoEvents.length, 1);
    assert.equal(r.infoEvents[0]?.[1].fetchedAt, null);
    assert.ok(
      r.starts.every((s) => s.cwd === "/unused/claude-helper" && s.command === "/bin/claude"),
    );
    assert.equal(r.timers.running, 1);
    assert.equal(r.timers.period, DEFAULT_TIMINGS.tickMs);
    const infoClient = r.clients.find((c) => c.calls.includes("get_settings"));
    const usageClient = r.clients.find((c) => c.calls.includes("get_usage"));
    assert.equal(infoClient?.closed, 1, "the info helper is short-lived");
    assert.equal(usageClient?.isAlive(), true, "the usage helper is kept");
    await r.service.stop();
  });

  test("a second start does nothing", async () => {
    const r = rig();
    await r.service.start();
    const before = r.starts.length;
    await r.service.start();
    assert.equal(r.starts.length, before);
    assert.equal(r.timers.running, 1);
    await r.service.stop();
  });

  test("failures are logged and never reject", async () => {
    const r = rig();
    r.state.initialize = new Error("boom");
    await r.service.start();
    assert.equal(r.service.info().fetchedAt, null);
    assert.equal(r.logs.length, 1);
    assert.match(r.service.usage().error ?? "", /boom/);
    await r.service.stop();
  });
});

describe("the usage helper", () => {
  test("is reused for the next request", async () => {
    const r = rig();
    await r.service.refreshUsage();
    await r.service.refreshUsage();
    assert.equal(r.clients.length, 1);
    assert.deepEqual(r.clients[0]?.calls, ["initialize", "get_usage", "get_usage"]);
    await r.service.stop();
  });

  test("a refresh that is running is joined", async () => {
    const r = rig();
    const [a, b] = await Promise.all([r.service.refreshUsage(), r.service.refreshUsage()]);
    assert.equal(a, b);
    assert.equal(r.usageCalls(), 1);
    await r.service.stop();
  });

  test("a helper that died is replaced", async () => {
    const r = rig();
    await r.service.refreshUsage();
    r.clients[0]?.die();
    await r.service.refreshUsage();
    assert.equal(r.clients.length, 2);
    assert.equal(r.clients[0]?.closed, 1);
    assert.equal(r.service.usage().error, null);
    await r.service.stop();
  });

  test("another program replaces the helper", async () => {
    const r = rig();
    await r.service.refreshUsage();
    r.state.bin = "/other/claude";
    await r.service.refreshUsage();
    assert.equal(r.clients.length, 2);
    assert.equal(r.clients[0]?.closed, 1);
    assert.equal(r.starts[1]?.command, "/other/claude");
    await r.service.stop();
  });

  test("a reused helper that fails is retried once on a fresh process", async () => {
    const r = rig();
    r.state.usage = (/** @type {number} */ n) =>
      n === 2 ? new Error("stale") : control("get_usage.json");
    await r.service.refreshUsage();
    const status = await r.service.refreshUsage();
    assert.equal(status.error, null);
    assert.equal(r.clients.length, 2);
    assert.equal(r.clients[0]?.closed, 1);
    assert.equal(r.usageCalls(), 3);
    await r.service.stop();
  });

  test("a fresh helper that fails is not retried in a loop", async () => {
    const r = rig();
    r.state.usage = new Error("no usage");
    const status = await r.service.refreshUsage();
    assert.match(status.error ?? "", /no usage/);
    assert.equal(r.clients.length, 1);
    assert.equal(r.usageCalls(), 1);
    assert.equal(r.clients[0]?.closed, 1);
    await r.service.stop();
  });

  test("a helper that cannot be started is an error on the status", async () => {
    const clock = fakeClock();
    const service = createClaudeService({
      helperDir: "/unused",
      env: () => ({}),
      clock,
      timers: fakeTimers(),
      wanted: () => true,
      locate: () => "/bin/claude",
      isLoggedIn: async () => true,
      startClient() {
        throw new AppError("internal", "Could not start Claude Code: EACCES");
      },
    });
    const status = await service.refreshUsage();
    assert.equal(status.error, "Could not start Claude Code: EACCES");
  });

  test("an unavailable plan is reported as such", async () => {
    const r = rig();
    r.state.usage = control("get_usage_unavailable.json");
    const status = await r.service.refreshUsage();
    assert.deepEqual([status.available, status.limits.length, status.error], [false, 0, null]);
    await r.service.stop();
  });
});

describe("usage-updated", () => {
  test("is announced only when something changed", async () => {
    const r = rig();
    await r.service.refreshUsage();
    assert.equal(r.usageEvents.length, 1);
    r.clock.advance(MIN);
    await r.service.refreshUsage();
    assert.equal(r.usageEvents.length, 1, "same limits, later time: no event");
    assert.equal(r.service.usage().fetchedAt, r.clock.now());

    const changed = control("get_usage.json");
    changed.rate_limits.limits[0].percent = 21;
    r.state.usage = changed;
    await r.service.refreshUsage();
    assert.equal(r.usageEvents.length, 2);
    assert.equal(r.usageEvents[1]?.limits[0]?.usedPercent, 21);

    r.state.usage = new Error("later failure");
    await r.service.refreshUsage();
    assert.equal(r.usageEvents.length, 3, "a new error is a change");
    await r.service.refreshUsage();
    assert.equal(r.usageEvents.length, 3, "the same error is not");
    await r.service.stop();
  });

  test("a throwing listener does not break the refresh", async () => {
    const r = rig();
    const logs = /** @type {string[]} */ ([]);
    const service = createClaudeService({
      helperDir: "/unused",
      env: () => ({}),
      clock: r.clock,
      timers: r.timers,
      wanted: () => true,
      locate: () => "/bin/claude",
      isLoggedIn: async () => true,
      startClient: () =>
        fakeClient({
          startedAt: 0,
          answers: { initialize: {}, get_usage: control("get_usage.json") },
        }),
      onUsage() {
        throw new Error("listener");
      },
      log: (m) => logs.push(m),
    });
    assert.equal((await service.refreshUsage()).available, true);
    assert.deepEqual(logs, ["The usage listener failed."]);
  });
});

describe("rate_limit_event", () => {
  const info = control("rate_limit_event.json").rate_limit_info;

  test("merges the 5-hour and weekly limits and keeps the scoped one", async () => {
    const r = rig();
    await r.service.refreshUsage();
    r.service.recordRateLimitEvent(info);
    const { limits } = r.service.usage();
    assert.deepEqual(
      limits.map((l) => [l.key, l.usedPercent]),
      [
        ["fiveHour", 19],
        ["weekly", 32],
        ["weeklyFable", 11],
      ],
    );
    assert.equal(limits[0]?.resetsAt, 1794637200 * 1000);
    assert.equal(r.usageEvents.length, 2);
    r.service.recordRateLimitEvent(info);
    assert.equal(r.usageEvents.length, 2, "the same event again changes nothing");
    await r.service.stop();
  });

  test("works before any refresh and makes the meter available", () => {
    const r = rig();
    r.service.recordRateLimitEvent(info);
    assert.equal(r.service.usage().available, true);
    assert.equal(r.service.usage().limits.length, 2);
    assert.equal(r.usageEvents.length, 1);
    assert.equal(r.starts.length, 0);
  });

  test("an event of an unknown shape is ignored and never throws", () => {
    const r = rig();
    for (const bad of [null, undefined, 5, {}, { unifiedWindows: 3 }]) {
      r.service.recordRateLimitEvent(bad);
    }
    assert.equal(r.usageEvents.length, 0);
    assert.equal(r.service.usage().available, false);
  });
});

describe("the schedule", () => {
  test("while somebody watches, usage is refreshed every minute", async () => {
    const r = rig();
    r.service.setWatchers(1);
    await r.service.start();
    assert.equal(r.usageCalls(), 1);
    await r.tickAfter(59_999);
    assert.equal(r.usageCalls(), 1);
    await r.tickAfter(1);
    assert.equal(r.usageCalls(), 2);
    await r.tickAfter(5000);
    assert.equal(r.usageCalls(), 2);
    await r.tickAfter(55_000);
    assert.equal(r.usageCalls(), 3);
    assert.equal(r.clients.filter((c) => c.calls.includes("get_usage")).length, 1, "one helper");
    await r.service.stop();
  });

  test("with a job running and nobody watching, every five minutes", async () => {
    const r = rig();
    r.service.setJobsRunning(true);
    await r.service.start();
    await r.tickAfter(5 * MIN - 1);
    assert.equal(r.usageCalls(), 1);
    await r.tickAfter(1);
    assert.equal(r.usageCalls(), 2);
    r.service.setWatchers(1);
    await r.tickAfter(MIN);
    assert.equal(r.usageCalls(), 3, "watchers make it a minute again");
    await r.service.stop();
  });

  test("nobody watching and no job: nothing is asked", async () => {
    const r = rig();
    await r.service.start();
    await r.tickAfter(9 * MIN);
    await r.tickAfter(30 * MIN);
    assert.equal(r.usageCalls(), 1);
    await r.service.stop();
  });

  test("an unused helper is closed after ten minutes", async () => {
    const r = rig();
    await r.service.start();
    const usageClient = r.clients.find((c) => c.calls.includes("get_usage"));
    await r.tickAfter(10 * MIN - 1);
    assert.equal(usageClient?.closed, 0);
    await r.tickAfter(1);
    assert.equal(usageClient?.closed, 1);
    assert.equal(usageClient?.isAlive(), false);
    await r.service.refreshUsage();
    assert.equal(r.clients.filter((c) => c.calls.includes("get_usage")).length, 2, "a new helper");
    await r.service.stop();
  });

  test("a helper in regular use is not closed as idle", async () => {
    const r = rig();
    r.service.setWatchers(1);
    await r.service.start();
    for (let i = 0; i < 15; i += 1) await r.tickAfter(MIN);
    const usageClients = r.clients.filter((c) => c.calls.includes("get_usage"));
    assert.equal(usageClients.length, 1);
    assert.equal(usageClients[0]?.closed, 0);
    await r.service.stop();
  });

  test("the helper is replaced after an hour", async () => {
    const r = rig();
    r.service.setWatchers(1);
    await r.service.start();
    const first = r.clients.find((c) => c.calls.includes("get_usage"));
    await r.tickAfter(HOUR - MIN);
    assert.equal(first?.closed, 0, "still the same one just before the hour");
    await r.tickAfter(MIN);
    assert.equal(first?.closed, 1);
    const second = r.clients.filter((c) => c.calls.includes("get_usage"))[1];
    assert.ok(second?.isAlive());
    assert.equal(r.service.usage().error, null);
    await r.service.stop();
  });

  test("somebody starting to watch refreshes at once", async () => {
    const r = rig();
    await r.service.start();
    await r.tickAfter(2 * MIN);
    assert.equal(r.usageCalls(), 1);
    r.service.setWatchers(1);
    await settle();
    assert.equal(r.usageCalls(), 2);
    r.service.setWatchers(2);
    await settle();
    assert.equal(r.usageCalls(), 2, "a second watcher does not");
    r.service.setWatchers(-4);
    r.service.setWatchers(1);
    await settle();
    assert.equal(r.usageCalls(), 2, "due only after the interval");
    await r.service.stop();
  });

  test("an empty list is fetched again after a minute, until it works", async () => {
    const r = rig();
    r.state.initialize = new Error("not yet");
    await r.service.start();
    assert.equal(r.logs.length, 1);
    await r.tickAfter(59_999);
    assert.equal(r.logs.length, 1);
    await r.tickAfter(1);
    assert.equal(r.logs.length, 2);
    r.state.initialize = control("initialize.json");
    await r.tickAfter(MIN);
    assert.equal(r.service.info().models.length, 7);
    assert.equal(r.logs.length, 2);
    assert.equal(r.infoEvents.length, 1);
    await r.service.stop();
  });

  test("a good list is fetched again after a day, a failed refresh waits an hour", async () => {
    const r = rig();
    await r.service.start();
    assert.equal(r.infoFetches(), 1);
    await r.tickAfter(24 * HOUR - 1);
    assert.equal(r.infoFetches(), 1);
    await r.tickAfter(1);
    assert.equal(r.infoFetches(), 2);
    assert.equal(r.infoEvents.length, 1, "the same list is not announced again");

    r.state.initialize = new Error("down");
    await r.tickAfter(24 * HOUR);
    assert.equal(r.logs.length, 1);
    assert.equal(r.service.info().models.length, 7, "the old list stays");
    await r.tickAfter(HOUR - 1);
    assert.equal(r.logs.length, 1);
    await r.tickAfter(1);
    assert.equal(r.logs.length, 2);
    await r.service.stop();
  });

  test("a changed list is announced with the previous one", async () => {
    const r = rig();
    await r.service.start();
    const smaller = control("initialize.json");
    smaller.models = smaller.models.slice(0, 3);
    r.state.initialize = smaller;
    await r.service.refreshInfo();
    assert.equal(r.infoEvents.length, 2);
    assert.equal(r.infoEvents[1]?.[0].models.length, 2);
    assert.equal(r.infoEvents[1]?.[1].models.length, 7);
    await r.service.stop();
  });
});

describe("stop", () => {
  test("ends every helper and starts nothing afterwards", async () => {
    const r = rig();
    r.service.setWatchers(1);
    await r.service.start();
    await r.service.stop();
    assert.ok(r.clients.every((c) => !c.isAlive() && c.closed >= 1));
    assert.equal(r.timers.running, 0);
    const before = r.starts.length;
    await r.service.refreshUsage();
    await r.service.refreshInfo();
    await r.tickAfter(HOUR);
    assert.equal(r.starts.length, before);
    await r.service.stop();
  });

  test("a pending request is ended with its helper, without an error on the status", async () => {
    const r = rig();
    r.state.usage = undefined;
    const clock = r.clock;
    const clients = /** @type {ReturnType<typeof fakeClient>[]} */ ([]);
    const service = createClaudeService({
      helperDir: "/unused",
      env: () => ({}),
      clock,
      timers: r.timers,
      wanted: () => true,
      locate: () => "/bin/claude",
      isLoggedIn: async () => true,
      startClient() {
        // `get_usage` is never answered.
        const client = fakeClient({ startedAt: 0, answers: { initialize: {} } });
        clients.push(client);
        return client;
      },
    });
    const refreshing = service.refreshUsage();
    await settle();
    assert.deepEqual(clients[0]?.calls, ["initialize", "get_usage"]);
    await service.stop();
    const status = await refreshing;
    assert.equal(status.error, null);
    assert.equal(clients[0]?.isAlive(), false);
    assert.ok((clients[0]?.closed ?? 0) >= 1);
  });
});

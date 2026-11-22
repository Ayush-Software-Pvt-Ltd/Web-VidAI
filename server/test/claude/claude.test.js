import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { createClaudeModule } from "../../src/agents/claude/index.js";
import { isAlive } from "../../src/platform/process.js";
import {
  FAKE_CLAUDE,
  FAKE_RECORDER,
  POSIX_ONLY,
  control,
  fakeClock,
  fakeEnv,
  fakeTimers,
  logOf,
  startsIn,
  tempDir,
} from "../support/claudeControl.js";

/**
 * A module on fake timers and a fake clock, with a recording event bus, in its own folders.
 * @param {object} [options]
 * @param {Record<string, string>} [options.env] Added to the fake's environment.
 * @param {string} [options.setup]
 * @param {import("../../src/agents/claude/index.js").ClaudeDeps["opencodeUsage"]} [options.opencodeUsage]
 * @param {import("../../src/agents/claude/index.js").ClaudeDeps["onInfoChange"]} [options.onInfoChange]
 */
function build(options = {}) {
  const dir = tempDir();
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const clock = fakeClock();
  const timers = fakeTimers();
  /** @type {Array<Record<string, unknown>>} */
  const emitted = [];
  /** @type {string[]} */
  const warnings = [];
  return { dir, home, clock, timers, emitted, warnings, options };
}

/**
 * @param {ReturnType<typeof build>} rig
 * @param {Partial<import("../../src/agents/claude/index.js").ClaudeDeps>} [extra]
 */
function make(rig, extra = {}) {
  return createClaudeModule({
    events: /** @type {any} */ ({
      emit: (/** @type {Record<string, unknown>} */ e) => rig.emitted.push(e),
    }),
    dataDir: path.join(rig.dir, "data"),
    env: fakeEnv(rig.dir, { VIDAI_CLAUDE_BIN: FAKE_CLAUDE, ...rig.options.env }),
    home: rig.home,
    clock: rig.clock,
    timers: rig.timers,
    log: {
      info() {},
      warn: (message) => rig.warnings.push(message),
      error() {},
    },
    setupOf: () => /** @type {any} */ (rig.options.setup ?? "claudeSubscription"),
    opencodeUsage: rig.options.opencodeUsage,
    onInfoChange: rig.options.onInfoChange,
    exitGraceMs: 2000,
    ...extra,
  });
}

/** How often `claude auth status` ran. @param {string} dir */
const authChecks = (dir) =>
  logOf(dir)
    .split("\n")
    .filter((l) => /args=auth status/.test(l)).length;

describe("the getUsage function", () => {
  test("is registered for every signed-in user", () => {
    const claude = make(build());
    assert.deepEqual(
      claude.rpc.map((f) => [f.name, f.access]),
      [["getUsage", "user"]],
    );
    assert.equal(claude.name, "claude");
  });

  test(
    "without refresh it only reads the cache and starts nothing",
    { skip: POSIX_ONLY },
    async () => {
      const rig = build();
      const claude = make(rig);
      const handler = /** @type {any} */ (claude.rpc[0]).handler;
      assert.deepEqual(await handler(undefined), {
        claude: { available: false, limits: [], fetchedAt: null, error: null },
        opencode: null,
      });
      assert.deepEqual(await handler({}), await handler(null));
      assert.equal(logOf(rig.dir), "");
    },
  );

  test(
    "with refresh it asks Claude Code, then serves the cache",
    { skip: POSIX_ONLY },
    async () => {
      const rig = build();
      const claude = make(rig);
      const handler = /** @type {any} */ (claude.rpc[0]).handler;
      const fresh = await handler({ refresh: true });
      assert.equal(fresh.claude.available, true);
      assert.deepEqual(
        fresh.claude.limits.map((/** @type {{ key: string, usedPercent: number }} */ l) => [
          l.key,
          l.usedPercent,
        ]),
        [
          ["fiveHour", 20],
          ["weekly", 33],
          ["weeklyFable", 11],
        ],
      );
      assert.equal(fresh.opencode, null);
      const before = startsIn(rig.dir);
      assert.deepEqual((await handler({ refresh: false })).claude, fresh.claude);
      assert.equal(startsIn(rig.dir), before);
      await claude.stop();
    },
  );

  test("on OpenCode Go it adds the OpenCode quota and never starts Claude Code", async () => {
    const rig = build({
      setup: "opencodeGo",
      env: { VIDAI_CLAUDE_BIN: FAKE_RECORDER },
      opencodeUsage: async (refresh) => /** @type {any} */ ({ marker: "quota", refresh }),
    });
    const claude = make(rig);
    const handler = /** @type {any} */ (claude.rpc[0]).handler;
    const view = await handler({ refresh: true });
    assert.deepEqual(view.opencode, { marker: "quota", refresh: true });
    assert.equal(view.claude.available, false);
    assert.equal((await handler({})).opencode.refresh, false);
  });

  test("rejects input that is not an object with a boolean refresh", async () => {
    const claude = make(build());
    const handler = /** @type {any} */ (claude.rpc[0]).handler;
    for (const bad of [{ refresh: "yes" }, { refresh: 1 }, 5, "x", []]) {
      await assert.rejects(
        handler(bad),
        (e) => /** @type {any} */ (e).code === "invalidInput",
        String(bad),
      );
    }
  });
});

describe("a setup that is not the Claude subscription", { skip: POSIX_ONLY }, () => {
  for (const setup of ["opencodeGo", "anthropicApi", "openaiApi"]) {
    test(`${setup} never starts the program`, async () => {
      const rig = build({ setup, env: { VIDAI_CLAUDE_BIN: FAKE_RECORDER } });
      const claude = make(rig);
      await claude.start();
      claude.setWatchers(3);
      claude.setJobsRunning(true);
      await claude.refreshNow();
      await claude.refreshInfo();
      await claude.claudeModels();
      await /** @type {any} */ (claude.rpc[0]).handler({ refresh: true });
      rig.clock.advance(60 * 60_000);
      rig.timers.fire();
      await claude.stop();
      assert.equal(logOf(rig.dir), "", "the recording fake was never started");
      assert.deepEqual(claude.info().models, []);
      assert.equal(rig.emitted.length, 0);
    });
  }
});

describe("the Claude subscription with the fake Claude Code", { skip: POSIX_ONLY }, () => {
  test("start fetches the models and the usage, announces once, and stop leaves no process", async () => {
    const rig = build();
    /** @type {Array<{ previous: number | null, models: number }>} */
    const infoChanges = [];
    rig.options.onInfoChange = (info, previous) =>
      infoChanges.push({ previous: previous.fetchedAt, models: info.models.length });
    /** @type {number[]} */
    const pids = [];
    const { startControlClient } = await import("../../src/agents/claude/control.js");
    const claude = make(rig, {
      startClient: (options) => {
        const client = startControlClient(options);
        pids.push(client.pid);
        return client;
      },
    });
    await claude.start();
    const models = await claude.claudeModels();
    assert.equal(models.length, 7);
    assert.equal(claude.info().defaultModel, "fable");
    assert.equal(claude.info().subscriptionType, "Claude Team");
    assert.equal(claude.usage().limits.length, 3);
    assert.deepEqual(infoChanges, [{ previous: null, models: 7 }]);
    assert.deepEqual(rig.emitted, [
      { event: "usage-updated", payload: { claude: claude.usage() }, userId: null, admins: false },
    ]);
    assert.ok(pids.length >= 1);
    assert.ok(
      pids.some((pid) => isAlive(pid)),
      "the reused usage helper is running",
    );
    assert.ok(fs.existsSync(path.join(rig.dir, "data", "claude-helper")));
    await claude.stop();
    for (const pid of pids) assert.equal(isAlive(pid), false, `pid ${pid} is gone`);
    assert.equal(rig.timers.running, 0);
  });

  test("a rate_limit_event of a job updates the meter and is announced", async () => {
    const rig = build();
    const claude = make(rig);
    await claude.refreshNow();
    rig.emitted.length = 0;
    claude.recordRateLimitEvent(control("rate_limit_event.json").rate_limit_info);
    assert.equal(rig.emitted.length, 1);
    const payload = /** @type {any} */ (rig.emitted[0]).payload;
    assert.deepEqual(
      payload.claude.limits.map((/** @type {{ key: string, usedPercent: number }} */ l) => [
        l.key,
        l.usedPercent,
      ]),
      [
        ["fiveHour", 19],
        ["weekly", 32],
        ["weeklyFable", 11],
      ],
    );
    assert.equal(Object.keys(payload).join(), "claude");
    await claude.stop();
  });

  test("watchers and jobs drive the schedule through the module", async () => {
    const rig = build();
    const claude = make(rig);
    await claude.start();
    const asks = () =>
      logOf(rig.dir)
        .split("\n")
        .filter((l) => l === "request get_usage").length;
    assert.equal(asks(), 1);
    claude.setWatchers(1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(asks(), 1, "not due yet after the startup fetch");
    rig.clock.advance(60_000);
    rig.timers.fire();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(asks(), 2);
    await claude.stop();
  });
});

describe("login, locate and ensureReady", { skip: POSIX_ONLY }, () => {
  test("claudeLoggedIn: yes, cached for 120 seconds, forgotten on request", async () => {
    const rig = build();
    const claude = make(rig);
    assert.equal(await claude.claudeLoggedIn(), true);
    assert.equal(authChecks(rig.dir), 1);
    rig.clock.advance(119_000);
    assert.equal(await claude.claudeLoggedIn(), true);
    assert.equal(authChecks(rig.dir), 1);
    claude.forgetLogin();
    assert.equal(await claude.claudeLoggedIn(), true);
    assert.equal(authChecks(rig.dir), 2);
    rig.clock.advance(120_000);
    assert.equal(await claude.claudeLoggedIn(), true);
    assert.equal(authChecks(rig.dir), 3);
  });

  test("claudeLoggedIn: logged out is false and never cached", async () => {
    const rig = build({ env: { FAKE_CLAUDE_LOGGED_OUT: "1" } });
    const claude = make(rig);
    assert.equal(await claude.claudeLoggedIn(), false);
    assert.equal(await claude.claudeLoggedIn(), false);
    assert.equal(authChecks(rig.dir), 2);
  });

  test("claudeLoggedIn: not installed is false without running anything", async () => {
    const rig = build({ env: { VIDAI_CLAUDE_BIN: "/nonexistent/claude" } });
    const claude = make(rig);
    assert.equal(await claude.claudeLoggedIn(), false);
    assert.equal(logOf(rig.dir), "");
  });

  test("locate finds the program and its version", async () => {
    const claude = make(build());
    assert.deepEqual(await claude.locate(), { path: FAKE_CLAUDE, version: "2.1.319" });
    const missing = make(build({ env: { VIDAI_CLAUDE_BIN: "/nonexistent/claude" } }));
    assert.equal(await missing.locate(), null);
  });

  test("ensureReady returns the program, or says why not", async () => {
    assert.equal(await make(build()).ensureReady(), FAKE_CLAUDE);
    await assert.rejects(
      make(build({ env: { VIDAI_CLAUDE_BIN: "/nonexistent/claude" } })).ensureReady(),
      (e) => /** @type {any} */ (e).code === "notReady" && /not installed/.test(String(e)),
    );
    await assert.rejects(
      make(build({ env: { FAKE_CLAUDE_LOGGED_OUT: "1" } })).ensureReady(),
      (e) => /** @type {any} */ (e).code === "notReady" && /not logged in/.test(String(e)),
    );
  });
});

describe("routing", () => {
  /** @param {string} dir @param {unknown} settings */
  const writeSettings = (dir, settings) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  };

  test("the settings file of the temp home beats the environment", async () => {
    const rig = build({ env: { ANTHROPIC_BASE_URL: "https://env.example/v1" } });
    writeSettings(path.join(rig.home, ".claude"), {
      env: { ANTHROPIC_BASE_URL: "https://settings.example/v1" },
    });
    assert.deepEqual(await make(rig).routing(), {
      baseUrl: "https://settings.example/v1",
      source: "claudeSettings",
    });
  });

  test("the environment alone", async () => {
    const rig = build({ env: { ANTHROPIC_BASE_URL: "https://env.example/v1" } });
    assert.deepEqual(await make(rig).routing(), {
      baseUrl: "https://env.example/v1",
      source: "environment",
    });
  });

  test("nothing set is no routing, also with an unrelated settings file", async () => {
    const rig = build();
    assert.equal(await make(rig).routing(), null);
    writeSettings(path.join(rig.home, ".claude"), { env: { OTHER: "1" } });
    assert.equal(await make(rig).routing(), null);
  });

  test("CLAUDE_CONFIG_DIR replaces the home folder's .claude", async () => {
    const config = path.join(tempDir(), "config");
    const rig = build({ env: { CLAUDE_CONFIG_DIR: config } });
    writeSettings(path.join(rig.home, ".claude"), {
      env: { ANTHROPIC_BASE_URL: "https://home.example/v1" },
    });
    assert.equal(await make(rig).routing(), null);
    writeSettings(config, { env: { ANTHROPIC_BASE_URL: "https://config.example/v1" } });
    assert.deepEqual(await make(rig).routing(), {
      baseUrl: "https://config.example/v1",
      source: "claudeSettings",
    });
  });
});

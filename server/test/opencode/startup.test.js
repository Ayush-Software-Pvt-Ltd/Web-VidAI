// Starting the OpenCode 2 server against the fake: a slow start is waited for and
// said, a server that never gets ready or ends at once fails with what to do, a progress display
// without line ends is not lost, and the user's own configuration stays out.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DEFAULT_TIMINGS } from "../../src/agents/opencode/child.js";
import { editPrompt, makeWorld, untilDead } from "./engineSupport.js";

/** Short notice and limit timings. @param {number} limitMs */
const limits = (limitMs) => ({
  startLimitMs: limitMs,
  firstNoticeMs: 400,
  noticeEveryMs: 400,
  failureOutputWaitMs: 300,
  pollMs: 10,
});

test("the default limit is far beyond the old thirty seconds, and the notices are paced", () => {
  assert.ok(DEFAULT_TIMINGS.startLimitMs >= 120_000);
  assert.equal(DEFAULT_TIMINGS.firstNoticeMs, 8_000);
  assert.equal(DEFAULT_TIMINGS.noticeEveryMs, 15_000);
});

test("a slow start is waited for, and the log is told", async (t) => {
  const world = makeWorld(t, { FAKE_OPENCODE_START: "delay:2.5" });
  const session = await world.start({ timings: limits(20_000) });
  assert.ok(world.statuses.length > 0);
  for (const text of world.statuses) {
    assert.match(text, /^Still waiting for OpenCode to start \(\d+ s\)/);
  }
  await session.sendUser(editPrompt());
  await world.results(2);
});

test("a server that never gets ready fails actionably and is ended", async (t) => {
  const world = makeWorld(t, { FAKE_OPENCODE_START: "never" });
  await assert.rejects(
    world.start({ command: world.launcher, timings: limits(1_800) }),
    (error) => {
      const message = /** @type {Error} */ (error).message;
      assert.match(message, /did not become ready within [12] seconds/);
      assert.match(message, /it printed nothing/);
      assert.match(message, /serve" in Terminal/);
      return true;
    },
  );
  assert.equal(world.launched().length, 1);
  await untilDead(world.launched());
  assert.equal(world.events.length, 0);
});

test("a server that ends at once fails with what it printed", async (t) => {
  const world = makeWorld(t, { FAKE_OPENCODE_START: "exit:Error: cannot open the database" });
  await assert.rejects(world.start({ timings: limits(20_000) }), (error) => {
    const message = /** @type {Error} */ (error).message;
    assert.match(message, /ended before it was ready/);
    assert.match(message, /\(Error: cannot open the database\)/);
    return true;
  });
});

test("a progress display without line ends is not lost", async (t) => {
  const world = makeWorld(t, { FAKE_OPENCODE_START: "migrate:30" });
  await assert.rejects(world.start({ timings: limits(1_500) }), (error) => {
    const message = /** @type {Error} */ (error).message;
    assert.match(message, /did not become ready/);
    assert.match(message, /Migrating database/);
    assert.doesNotMatch(message, /it printed nothing/);
    return true;
  });
});

test("a migration that ends just after the first notice still starts the session", async (t) => {
  const world = makeWorld(t, { FAKE_OPENCODE_START: "migrate:2" });
  const session = await world.start({ timings: limits(20_000) });
  await session.sendUser(editPrompt());
  await world.results(2);
});

test("the user's own OpenCode configuration stays out of the server", async (t) => {
  const world = makeWorld(t);
  const poison = "THE-USERS-OWN-MCP-SERVER";
  const files = [
    path.join(world.home, ".config", "opencode", "opencode.json"),
    path.join(world.home, ".config", "opencode", "plugins", "own.js"),
    path.join(world.editing, "opencode.json"),
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, poison);
  }
  await world.start();
  const [call] = world.calls();
  assert.ok(call);
  assert.equal(call["OPENCODE_CONFIG_PROJECT_DISABLE"], "1");
  assert.equal(call["OPENCODE_CONFIG_DIR"], path.join(world.jobDir, "opencode2-config"));
  assert.equal(call["config_dir_files"], "", "the configuration folder the server reads is empty");
  assert.equal(call["OPENCODE_CONFIG"], "<unset>");
  assert.ok(!JSON.stringify(call).includes(poison));
});

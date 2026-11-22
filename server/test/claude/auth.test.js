import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { AppError } from "../../src/errors.js";
import { POSITIVE_TTL_MS, createLoginCheck, parseStatus } from "../../src/agents/claude/auth.js";
import {
  FAKE_CLAUDE,
  POSIX_ONLY,
  control,
  fakeClock,
  fakeEnv,
  tempDir,
} from "../support/claudeControl.js";

/** @param {string} stdout @returns {import("../../src/platform/process.js").HelperResult} */
const result = (stdout) => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false });

/**
 * A recording stand-in for `runHelper`.
 * @param {(call: number) => string | Error | "timeout"} answer
 */
function recorder(answer) {
  /** @type {Array<{ command: string, args?: readonly string[] }>} */
  const calls = [];
  /** @type {typeof import("../../src/platform/process.js").runHelper} */
  const run = async (options) => {
    calls.push({ command: options.command, args: options.args });
    const given = answer(calls.length);
    if (given instanceof Error) throw given;
    if (given === "timeout") return { ...result(""), timedOut: true, code: null };
    return result(given);
  };
  return { run, calls };
}

const IN = JSON.stringify({ loggedIn: true });
const OUT = JSON.stringify({ loggedIn: false });

describe("parseStatus", () => {
  test("reads the recorded outputs", () => {
    assert.equal(parseStatus(JSON.stringify(control("auth_status.json"))), true);
    assert.equal(parseStatus(JSON.stringify(control("auth_status_logged_out.json"))), false);
  });

  test("tolerates noise around the JSON", () => {
    assert.equal(parseStatus(`warming up...\n${IN}\nbye {not json}`), null);
    assert.equal(parseStatus(`warming up...\n${IN}\nbye`), true);
    assert.equal(parseStatus(`Update available\n${OUT}\n\n`), false);
    assert.equal(
      parseStatus(`noise {\n  "loggedIn": true,\n  "nested": { "a": 1 }\n}\nmore`),
      true,
    );
  });

  test("anything else is unknown", () => {
    for (const text of [
      "",
      "Not logged in",
      "{",
      "}{",
      "{}",
      "[1]",
      '{"loggedIn":"yes"}',
      '{"loggedIn":1}',
      "{broken json}",
    ]) {
      assert.equal(parseStatus(text), null, text);
    }
  });
});

describe("login cache", () => {
  const ENV = { PATH: "/bin" };

  test("a positive answer is trusted for 120 seconds", async () => {
    const clock = fakeClock();
    const { run, calls } = recorder(() => IN);
    const login = createLoginCheck({ clock, run });
    assert.equal(POSITIVE_TTL_MS, 120_000);
    assert.equal(await login.isLoggedIn("claude", ENV), true);
    assert.deepEqual(calls[0]?.args, ["auth", "status"]);
    clock.advance(119_999);
    assert.equal(await login.isLoggedIn("claude", ENV), true);
    assert.equal(calls.length, 1);
    clock.advance(1);
    assert.equal(await login.isLoggedIn("claude", ENV), true);
    assert.equal(calls.length, 2, "asked again at 120 s");
  });

  test("a negative answer is never cached", async () => {
    const clock = fakeClock();
    const { run, calls } = recorder((n) => (n < 3 ? OUT : IN));
    const login = createLoginCheck({ clock, run });
    assert.equal(await login.isLoggedIn("claude", ENV), false);
    assert.equal(await login.isLoggedIn("claude", ENV), false);
    assert.equal(await login.isLoggedIn("claude", ENV), true);
    assert.equal(calls.length, 3);
  });

  test("unreadable output counts as not logged in", async () => {
    const { run } = recorder(() => "Unknown command: auth");
    const login = createLoginCheck({ clock: fakeClock(), run });
    assert.equal(await login.isLoggedIn("claude", ENV), false);
  });

  test("a logged-out answer after a logged-in one drops the memory", async () => {
    const clock = fakeClock();
    const { run } = recorder((n) => (n === 1 ? IN : OUT));
    const login = createLoginCheck({ clock, run });
    assert.equal(await login.isLoggedIn("claude", ENV), true);
    assert.equal(await login.checkNow("claude", ENV), false);
    assert.equal(await login.isLoggedIn("claude", ENV), false);
  });

  test("forgetLogin makes the next check ask again", async () => {
    const { run, calls } = recorder(() => IN);
    const login = createLoginCheck({ clock: fakeClock(), run });
    await login.isLoggedIn("claude", ENV);
    await login.isLoggedIn("claude", ENV);
    assert.equal(calls.length, 1);
    login.forgetLogin();
    await login.isLoggedIn("claude", ENV);
    assert.equal(calls.length, 2);
  });

  test("a check that started before forgetLogin does not remember its answer", async () => {
    /** @type {(value: string) => void} */
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let n = 0;
    /** @type {typeof import("../../src/platform/process.js").runHelper} */
    const run = async () => {
      n += 1;
      if (n === 1) return result(/** @type {string} */ (await gate));
      return result(IN);
    };
    const login = createLoginCheck({ clock: fakeClock(), run });
    const first = login.isLoggedIn("claude", ENV);
    login.forgetLogin();
    release(IN);
    assert.equal(await first, true);
    await login.isLoggedIn("claude", ENV);
    assert.equal(n, 2, "the old answer was not remembered");
  });

  test("another program is checked on its own", async () => {
    const { run, calls } = recorder(() => IN);
    const login = createLoginCheck({ clock: fakeClock(), run });
    await login.isLoggedIn("/a/claude", ENV);
    await login.isLoggedIn("/b/claude", ENV);
    assert.deepEqual(
      calls.map((c) => c.command),
      ["/a/claude", "/b/claude"],
    );
  });

  test("concurrent callers share one process", async () => {
    const { run, calls } = recorder(() => IN);
    const login = createLoginCheck({ clock: fakeClock(), run });
    const all = await Promise.all([
      login.isLoggedIn("claude", ENV),
      login.isLoggedIn("claude", ENV),
      login.checkNow("claude", ENV),
    ]);
    assert.deepEqual(all, [true, true, true]);
    assert.equal(calls.length, 1);
  });

  test("a timeout or a start failure throws and is not cached", async () => {
    const { run } = recorder((n) =>
      n === 1 ? "timeout" : n === 2 ? new Error("spawn EACCES") : IN,
    );
    const login = createLoginCheck({ clock: fakeClock(), run, timeoutMs: 20_000 });
    await assert.rejects(login.isLoggedIn("claude", ENV), (error) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /no answer within 20 seconds/);
      return true;
    });
    await assert.rejects(
      login.isLoggedIn("claude", ENV),
      /Checking the Claude Code login failed: spawn EACCES/,
    );
    assert.equal(await login.isLoggedIn("claude", ENV), true);
  });
});

describe("with a real process", { skip: POSIX_ONLY }, () => {
  test("the fake answers logged in, then logged out", async () => {
    const dir = tempDir();
    const login = createLoginCheck({ clock: fakeClock() });
    assert.equal(await login.checkNow(FAKE_CLAUDE, fakeEnv(dir)), true);
    assert.equal(
      await login.checkNow(FAKE_CLAUDE, fakeEnv(dir, { FAKE_CLAUDE_LOGGED_OUT: "1" })),
      false,
    );
  });

  test("noise around the JSON is tolerated", async () => {
    const dir = tempDir();
    const script = path.join(dir, "noisy.sh");
    fs.writeFileSync(
      script,
      `#!/bin/sh\necho "a new version is available"\necho '${IN}'\necho "run claude update" >&2\nexit 0\n`,
      { mode: 0o755 },
    );
    const login = createLoginCheck({ clock: fakeClock() });
    assert.equal(await login.checkNow(script, fakeEnv(dir)), true);
  });

  test("a program that cannot start throws", async () => {
    const dir = tempDir();
    const login = createLoginCheck({ clock: fakeClock() });
    await assert.rejects(
      login.checkNow(path.join(dir, "missing"), fakeEnv(dir)),
      /Checking the Claude Code login failed/,
    );
  });
});

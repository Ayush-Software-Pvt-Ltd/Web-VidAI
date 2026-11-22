import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isEmptyResult, isInterrupted } from "../../src/agents/claude/protocol.js";
import {
  buildArgs,
  exitSuccess,
  lastStderrLine,
  LineSplitter,
  startSession,
} from "../../src/agents/claude/session.js";
import { endTree } from "../../src/platform/process.js";

const FAKE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "support",
  "fake-claude.sh",
);
const SKIP = process.platform === "win32" ? "needs a POSIX shell" : false;
const SESSION = "11111111-1111-4111-8111-111111111111";
const BASE =
  "-p --input-format stream-json --output-format stream-json --verbose --permission-mode bypassPermissions";

/** @type {string[]} */
const dirs = [];
/** @returns {string} */
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-session-"));
  dirs.push(dir);
  return dir;
}
after(() => {
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
    await sleep(10);
  }
}

/**
 * Starts a session and records its events.
 * @param {Partial<import("../../src/agents/claude/session.js").StartOptions> & { scenario?: string, state?: string, command?: string }} [options]
 */
function start(options = {}) {
  const state = options.state ?? tempDir();
  /** @type {import("../../src/agents/claude/session.js").SessionEvent[]} */
  const events = [];
  const session = startSession({
    command: options.command ?? FAKE,
    cwd: options.cwd ?? state,
    env: options.env ?? {
      PATH: "/usr/bin:/bin",
      FAKE_STATE: state,
      FAKE_SCENARIO: options.scenario ?? "no_output",
    },
    ...(options.resumeId === undefined ? { sessionId: options.sessionId ?? SESSION } : {}),
    ...options,
    onEvent: (event) => events.push(event),
  });
  const kinds = () => events.map((e) => (e.type === "line" ? `${e.event.type}` : "exited"));
  const exited = () =>
    /** @type {Extract<typeof events[number], { type: "exited" }> | undefined} */ (
      events.find((e) => e.type === "exited")
    );
  const results = () =>
    events.flatMap((e) => (e.type === "line" && e.event.type === "result" ? [e.event] : []));
  return { session, events, state, kinds, exited, results };
}

/** A script that stands in for claude. @param {string} body */
function script(body) {
  const dir = tempDir();
  const file = path.join(dir, "fake");
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { file, dir };
}

describe("arguments", () => {
  test("match the spec", () => {
    assert.equal(buildArgs({ sessionId: "s1" }).join(" "), `${BASE} --session-id s1`);
    assert.equal(
      buildArgs({ resumeId: "s2", model: "opus", effort: "high" }).join(" "),
      `${BASE} --model opus --effort high --resume s2`,
    );
    assert.equal(buildArgs({ resumeId: "s3", model: " " }).join(" "), `${BASE} --resume s3`);
    assert.equal(
      buildArgs({ sessionId: "s4", model: " opus ", effort: "" }).join(" "),
      `${BASE} --model opus --session-id s4`,
    );
    assert.ok(!buildArgs({ sessionId: "s5" }).includes("--continue"));
  });

  test("need exactly one of a new and an existing session", () => {
    assert.throws(() => buildArgs({}), TypeError);
    assert.throws(() => buildArgs({ sessionId: "a", resumeId: "b" }), TypeError);
  });
});

describe("exit helpers", () => {
  test("success and the last stderr line", () => {
    assert.equal(exitSuccess({ code: 0, signal: null, stderrTail: [] }), true);
    assert.equal(exitSuccess({ code: 1, signal: null, stderrTail: [] }), false);
    assert.equal(exitSuccess({ code: null, signal: "SIGTERM", stderrTail: [] }), false);
    assert.equal(
      lastStderrLine({ code: 1, signal: null, stderrTail: ["a", " b ", "", "  "] }),
      "b",
    );
    assert.equal(lastStderrLine({ code: 1, signal: null, stderrTail: [] }), null);
  });
});

describe("LineSplitter", () => {
  /**
   * @param {Buffer[]} chunks
   * @param {{ maxBytes: number, overflow: "skip" | "truncate" }} options
   */
  function split(chunks, options) {
    const splitter = new LineSplitter(options);
    /** @type {string[]} */
    const lines = [];
    const take = (/** @type {Buffer} */ line) => lines.push(line.toString("utf8"));
    for (const chunk of chunks) splitter.push(chunk, take);
    splitter.end(take);
    return lines;
  }
  const roomy = /** @type {const} */ ({ maxBytes: 1000, overflow: "skip" });

  test("splits lines, drops the carriage return and delivers a last line without newline", () => {
    assert.deepEqual(split([Buffer.from("short\r\nsecond\n\nlast")], roomy), [
      "short",
      "second",
      "",
      "last",
    ]);
    assert.deepEqual(split([Buffer.from("a\n")], roomy), ["a"]);
    assert.deepEqual(split([], roomy), []);
  });

  test("handles lines across every chunk size", () => {
    const text = Buffer.from("abcdef\r\nxy\n\nz");
    for (let size = 1; size <= text.length; size += 1) {
      /** @type {Buffer[]} */
      const chunks = [];
      for (let i = 0; i < text.length; i += size) chunks.push(text.subarray(i, i + size));
      assert.deepEqual(split(chunks, roomy), ["abcdef", "xy", "", "z"], `chunk size ${size}`);
    }
  });

  test("keeps a multi-byte character whole when a chunk edge cuts it", () => {
    const text = Buffer.from("héllo wörld 日本語 \u{1F600}\n", "utf8");
    for (let size = 1; size <= 5; size += 1) {
      /** @type {Buffer[]} */
      const chunks = [];
      for (let i = 0; i < text.length; i += size) chunks.push(text.subarray(i, i + size));
      assert.deepEqual(split(chunks, roomy), ["héllo wörld 日本語 \u{1F600}"], `size ${size}`);
    }
  });

  test("skips a line that is too long and goes on with the next", () => {
    const lines = split(
      [Buffer.from("short\r\nthis line is long\nlast"), Buffer.from("\nmore\n")],
      { maxBytes: 8, overflow: "skip" },
    );
    assert.deepEqual(lines, ["short", "last", "more"]);
  });

  test("a line of exactly the limit is kept", () => {
    assert.deepEqual(
      split([Buffer.from("12345678\n123456789\n")], { maxBytes: 8, overflow: "skip" }),
      ["12345678"],
    );
  });

  test("truncates a long line when asked to", () => {
    assert.deepEqual(
      split([Buffer.from("short\nthis line is long\nlast")], { maxBytes: 8, overflow: "truncate" }),
      ["short", "this lin", "last"],
    );
  });

  test("never holds more than the limit of a long line", () => {
    const splitter = new LineSplitter({ maxBytes: 1024, overflow: "skip" });
    /** @type {string[]} */
    const lines = [];
    // 25 MiB without a newline: nothing is delivered and at most the limit is held.
    for (let i = 0; i < 400; i += 1) {
      splitter.push(Buffer.alloc(64 * 1024, 0x61), () => lines.push("x"));
      assert.ok(splitter.bufferedBytes <= 1024);
    }
    assert.equal(lines.length, 0);
    splitter.push(Buffer.from("\nnext\n"), (line) => lines.push(line.toString()));
    assert.deepEqual(lines, ["next"]);
    assert.equal(splitter.bufferedBytes, 0);
  });
});

describe("a real process", { skip: SKIP }, () => {
  test("reports lines then the exit, and refuses writes after the exit", async () => {
    const body = `read -r line; printf '%s\\n' '{"type":"system","subtype":"init","session_id":"s"}'; printf 'oops\\n' >&2; printf '%s\\n' "$line" | grep -q '"text":"hi"' && exit 3; exit 4`;
    const { file, dir } = script(body);
    const { session, kinds, exited } = start({
      command: file,
      cwd: dir,
      env: { PATH: "/usr/bin:/bin" },
    });
    assert.ok(session.pid > 0);
    session.sendUser("hi");
    await until(() => exited() !== undefined, "the exit");
    assert.deepEqual(kinds(), ["system", "exited"]);
    assert.equal(exited()?.exit.code, 3);
    assert.equal(exited()?.exit.signal, null);
    assert.equal(lastStderrLine(/** @type {any} */ (exited()).exit), "oops");
    session.close();
    assert.throws(() => session.sendUser("again"), { code: "EPIPE" });
    assert.throws(() => session.interrupt(), { code: "EPIPE" });
  });

  test("a simple turn: init, text, result, and the process ends when stdin closes", async () => {
    const { session, state, events, kinds, exited, results } = start({ scenario: "no_output" });
    session.sendUser("hello");
    await until(() => results().length === 1, "the first result");
    assert.deepEqual(kinds(), ["system", "assistant", "result"]);
    assert.equal(results()[0]?.text, "I could not finish.");
    assert.ok(events.every((e) => typeof e.at === "number"));
    // A further message of the same process is answered too.
    session.sendUser("again");
    await until(() => results().length === 2, "the second result");
    session.close();
    await until(() => exited() !== undefined, "the exit");
    assert.equal(exited()?.exit.code, 0);
    assert.deepEqual(exited()?.exit.stderrTail, []);
    // The process was started with exactly the arguments of the spec.
    const call = fs
      .readdirSync(state)
      .filter((f) => f.startsWith("call."))
      .map((f) => fs.readFileSync(path.join(state, f), "utf8"))[0];
    assert.match(call ?? "", new RegExp(`args=${BASE} --session-id ${SESSION}\\n`));
    assert.match(call ?? "", new RegExp(`cwd=${fs.realpathSync(state)}\\n`));
  });

  test("a resumed session starts with an empty result that is not the answer", async () => {
    const { session, state, exited, results } = start({
      scenario: "live",
      resumeId: SESSION,
      model: "opus",
      effort: "high",
    });
    session.sendUser("MAIN_FOLDER = vid1\nCHANNEL_FOLDER = ch\n");
    await until(() => results().length === 1, "the empty result");
    const first = /** @type {any} */ (results()[0]);
    assert.ok(isEmptyResult(first));
    fs.writeFileSync(path.join(state, "release.vid1"), "");
    await until(() => results().length === 2, "the real result");
    const second = /** @type {any} */ (results()[1]);
    assert.ok(!isEmptyResult(second));
    assert.equal(second.text, "[OUTPUT COMPLETED]");
    session.close();
    await until(() => exited() !== undefined, "the exit");
    const call = fs
      .readdirSync(state)
      .filter((f) => f.startsWith("call."))
      .map((f) => fs.readFileSync(path.join(state, f), "utf8"))[0];
    assert.match(call ?? "", /mode=resume/);
    assert.match(call ?? "", new RegExp(`--model opus --effort high --resume ${SESSION}`));
  });

  test("an interrupt gets the id back in a control response and ends the turn", async () => {
    const { session, state, events, exited, results } = start({ scenario: "hold" });
    session.sendUser("MAIN_FOLDER = vid1\nCHANNEL_FOLDER = ch\n");
    await until(() => fs.existsSync(path.join(state, "started.vid1")), "the start");
    const id = session.interrupt();
    assert.equal(id, "vidai-interrupt-1");
    await until(() => results().length === 1, "the aborted result");
    const response = events.find((e) => e.type === "line" && e.event.type === "controlResponse");
    assert.ok(response?.type === "line" && response.event.type === "controlResponse");
    assert.equal(response.event.requestId, id);
    assert.equal(response.event.success, true);
    assert.ok(isInterrupted(/** @type {any} */ (results()[0])));
    session.close();
    await until(() => exited() !== undefined, "the exit");
    assert.equal(exited()?.exit.code, 0);
  });

  test("interrupt ids count up", async () => {
    const { session, state, exited } = start({ scenario: "hold" });
    session.sendUser("MAIN_FOLDER = vid1\nCHANNEL_FOLDER = ch\n");
    await until(() => fs.existsSync(path.join(state, "started.vid1")), "the start");
    assert.equal(session.interrupt(), "vidai-interrupt-1");
    assert.equal(session.interrupt(), "vidai-interrupt-2");
    session.close();
    await until(() => exited() !== undefined, "the exit");
  });

  test("close is idempotent and the exit comes exactly once", async () => {
    const { session, events, results, exited } = start({ scenario: "no_output" });
    session.sendUser("hello");
    await until(() => results().length === 1, "the result");
    session.close();
    session.close();
    session.closeStdin();
    await until(() => exited() !== undefined, "the exit");
    await sleep(400);
    assert.equal(events.filter((e) => e.type === "exited").length, 1);
    assert.equal(events.at(-1)?.type, "exited");
    // After close, writes fail.
    assert.throws(() => session.sendUser("late"), { code: "EPIPE" });
  });

  test("a crash reports the exit code and the tail of stderr", async () => {
    const { session, kinds, exited } = start({ scenario: "crash" });
    session.sendUser("hello");
    await until(() => exited() !== undefined, "the exit");
    assert.deepEqual(kinds(), ["system", "exited"]);
    const exit = /** @type {any} */ (exited()).exit;
    assert.equal(exit.code, 2);
    assert.equal(exitSuccess(exit), false);
    assert.deepEqual(exit.stderrTail, ["Error: boom"]);
    assert.equal(lastStderrLine(exit), "Error: boom");
    assert.throws(() => session.sendUser("after"), { code: "EPIPE" });
    assert.throws(() => session.interrupt(), { code: "EPIPE" });
    session.close();
  });

  test("a signal is reported by name", async () => {
    const { file, dir } = script("read -r line; kill -TERM $$; sleep 5");
    const { session, exited } = start({ command: file, cwd: dir, env: { PATH: "/usr/bin:/bin" } });
    session.sendUser("go");
    await until(() => exited() !== undefined, "the exit");
    assert.equal(exited()?.exit.code, null);
    assert.equal(exited()?.exit.signal, "SIGTERM");
  });

  test("keeps only the last 20 stderr lines, each cut at 2000 bytes", async () => {
    const { file, dir } = script(
      `i=1; while [ $i -le 30 ]; do echo "line $i" >&2; i=$((i+1)); done; head -c 5000 /dev/zero | tr '\\0' 'x' >&2; echo >&2; exit 1`,
    );
    const { session, exited } = start({ command: file, cwd: dir, env: { PATH: "/usr/bin:/bin" } });
    await until(() => exited() !== undefined, "the exit");
    const tail = /** @type {any} */ (exited()).exit.stderrTail;
    assert.equal(tail.length, 20);
    assert.equal(tail[0], "line 12");
    assert.equal(tail[18], "line 30");
    assert.equal(tail[19].length, 2000);
    session.close();
  });

  test("survives invalid JSON, invalid UTF-8, carriage returns and unknown lines", async () => {
    const { file, dir } = script(
      [
        "read -r line",
        `printf 'not json\\n'`,
        `printf '\\377\\376 broken \\200 bytes\\n'`,
        `printf '{"type":"system","subtype":"init","session_id":"s"}\\r\\n'`,
        `printf '{"type":"assistant","message":{"content":[{"type":"text","text":"h\\303\\251llo \\377 x"}]}}\\n'`,
        `printf '{"type":"stream_event"}\\n'`,
        `printf '[1,2]\\n\\n   \\n'`,
        `printf '{"type":"result","num_turns":1,"result":"done"}'`,
      ].join("\n"),
    );
    const { session, events, exited } = start({
      command: file,
      cwd: dir,
      env: { PATH: "/usr/bin:/bin" },
    });
    session.sendUser("go");
    await until(() => exited() !== undefined, "the exit");
    const types = events.flatMap((e) => (e.type === "line" ? [e.event.type] : []));
    // The last result has no newline and is still delivered at the end of the stream.
    assert.deepEqual(types, ["system", "assistant", "other", "result"]);
    const text = events.find((e) => e.type === "line" && e.event.type === "assistant");
    assert.ok(text?.type === "line" && text.event.type === "assistant");
    const block = text.event.content[0];
    assert.ok(block?.type === "text");
    assert.equal(block.text, "héllo � x");
  });

  test("skips a stdout line over 16 MiB without losing the lines around it", async () => {
    const { file, dir } = script(
      [
        "read -r line",
        `printf '{"type":"system","subtype":"init"}\\n'`,
        `head -c 17000000 /dev/zero | tr '\\0' 'a'; printf '\\n'`,
        `printf '{"type":"result","num_turns":1}\\n'`,
      ].join("\n"),
    );
    const { session, kinds, exited } = start({
      command: file,
      cwd: dir,
      env: { PATH: "/usr/bin:/bin" },
    });
    session.sendUser("go");
    await until(() => exited() !== undefined, "the exit", 60_000);
    assert.deepEqual(kinds(), ["system", "result", "exited"]);
  });

  test("a grandchild that holds the pipes open does not delay the exit for long", async () => {
    const { file, dir } = script(
      'read -r line; (sleep 30) & echo "{\\"type\\":\\"result\\"}"; exit 0',
    );
    const started = Date.now();
    const { session, exited } = start({
      command: file,
      cwd: dir,
      env: { PATH: "/usr/bin:/bin" },
      timings: { stdoutDrainMs: 300, stderrDrainMs: 100 },
    });
    session.sendUser("go");
    await until(() => exited() !== undefined, "the exit");
    const took = Date.now() - started;
    assert.ok(took >= 300 && took < 5000, `took ${took} ms`);
    assert.equal(exited()?.exit.code, 0);
    assert.equal(await endTree(session.pid, { graceMs: 200 }), true);
  });

  test("a process that never reads stdin makes writes fail, never crash the server", async () => {
    const { file, dir } = script("exit 0");
    const { session, exited } = start({ command: file, cwd: dir, env: { PATH: "/usr/bin:/bin" } });
    const big = "x".repeat(1024 * 1024);
    let failed = 0;
    for (let i = 0; i < 30 && failed === 0; i += 1) {
      try {
        session.sendUser(big);
      } catch {
        failed += 1;
      }
      await sleep(20);
    }
    await until(() => exited() !== undefined, "the exit");
    assert.throws(() => session.sendUser("again"), { code: "EPIPE" });
  });

  test("a throwing callback does not crash the server", async () => {
    const state = tempDir();
    let calls = 0;
    const session = startSession({
      command: FAKE,
      cwd: state,
      env: { PATH: "/usr/bin:/bin", FAKE_STATE: state, FAKE_SCENARIO: "crash" },
      sessionId: SESSION,
      onEvent: () => {
        calls += 1;
        throw new Error("bad callback");
      },
    });
    session.sendUser("hello");
    await until(() => calls >= 2, "both events");
  });

  test("a program that does not exist cannot be started", () => {
    assert.throws(
      () =>
        startSession({
          command: "/no/such/claude",
          cwd: tmpdirOnce(),
          env: { PATH: "/usr/bin:/bin" },
          sessionId: SESSION,
          onEvent: () => {},
        }),
      { code: "ENOENT" },
    );
  });
});

/** @returns {string} */
function tmpdirOnce() {
  return os.tmpdir();
}

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AppError } from "../../src/errors.js";
import {
  HELPER_ARGS,
  parseAnswer,
  parseControlLine,
  requestLine,
  startControlClient,
} from "../../src/agents/claude/control.js";
import { fetchInfo } from "../../src/agents/claude/info.js";
import { parseUsage } from "../../src/agents/claude/usage.js";
import { isAlive } from "../../src/platform/process.js";
import {
  FAKE_CLAUDE,
  FAKE_HANG,
  POSIX_ONLY,
  fakeEnv,
  logOf,
  tempDir,
} from "../support/claudeControl.js";

describe("requestLine", () => {
  test("is one JSON line with the id and the subtype", () => {
    for (const subtype of ["initialize", "get_settings", "get_usage"]) {
      const line = requestLine("vidai-1", subtype);
      assert.ok(line.endsWith("\n"));
      assert.equal(line.trimEnd().includes("\n"), false);
      const value = JSON.parse(line);
      assert.equal(value.type, "control_request");
      assert.equal(value.request_id, "vidai-1");
      assert.equal(value.request.subtype, subtype);
    }
  });
});

describe("parseControlLine and parseAnswer", () => {
  test("a success answer gives the inner response", () => {
    const answer = parseControlLine(
      '{"type":"control_response","response":{"subtype":"success","request_id":"a","response":{"x":1}}}',
    );
    assert.equal(answer?.["request_id"], "a");
    assert.deepEqual(answer && parseAnswer("initialize", answer), { x: 1 });
  });

  test("a success answer without a body is null", () => {
    const answer = parseControlLine(
      '{"type":"control_response","response":{"subtype":"success","request_id":"a"}}',
    );
    assert.equal(answer && parseAnswer("initialize", answer), null);
  });

  test("an error answer becomes a readable error", () => {
    const answer = parseControlLine(
      '{"type":"control_response","response":{"subtype":"error","request_id":"a","error":"Unsupported"}}',
    );
    assert.ok(answer);
    assert.throws(
      () => parseAnswer("get_usage", answer),
      (error) =>
        error instanceof AppError &&
        error.message === "Claude Code could not answer get_usage: Unsupported",
    );
    assert.throws(
      () => parseAnswer("get_usage", { subtype: "error", request_id: "a" }),
      /unknown error/,
    );
  });

  test("every other line is ignored", () => {
    for (const line of [
      "",
      "this line is not JSON",
      '{"type":"system","subtype":"status"}',
      '{"type":"control_response"}',
      '{"type":"control_response","response":{"subtype":"success"}}',
      '{"type":"control_response","response":{"request_id":7}}',
      "[1,2]",
      "null",
    ]) {
      assert.equal(parseControlLine(line), null, line);
    }
  });
});

test("the helper arguments keep MCP servers, hooks and sessions off", () => {
  const args = [...HELPER_ARGS];
  assert.deepEqual(args.slice(0, 8), [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
  ]);
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  const settings = JSON.parse(args[args.indexOf("--settings") + 1] ?? "");
  assert.deepEqual(settings, { disableAllHooks: true, remoteControlAtStartup: false });
  assert.ok(Object.isFrozen(HELPER_ARGS));
});

/**
 * Starts the fake helper.
 * @param {string} dir
 * @param {Record<string, string>} [extra]
 * @param {Partial<import("../../src/agents/claude/control.js").StartControlOptions>} [options]
 */
function start(dir, extra = {}, options = {}) {
  return startControlClient({
    command: FAKE_CLAUDE,
    env: fakeEnv(dir, extra),
    cwd: `${dir}/work`,
    ...options,
  });
}

describe("the helper process", { skip: POSIX_ONLY }, () => {
  test("answers info and usage (and never gets a model request)", async () => {
    const dir = tempDir();
    const client = start(dir);
    assert.ok(client.isAlive());
    assert.ok(client.pid > 0);
    const info = await fetchInfo(client, 1);
    assert.equal(info.models.length, 7);
    assert.equal(info.defaultModel, "fable");
    assert.equal(info.defaultEffort, "high");
    const usage = parseUsage(await client.request("get_usage", 10_000));
    assert.deepEqual(
      usage.limits.map((l) => [l.key, l.usedPercent]),
      [
        ["fiveHour", 20],
        ["weekly", 33],
        ["weeklyFable", 11],
      ],
    );
    await client.close();
    const log = logOf(dir);
    assert.match(log, /cwd=.*\/work args=-p --input-format stream-json/);
    assert.match(log, /--settings \{"disableAllHooks":true/);
    assert.doesNotMatch(log, /mcp_status/);
    assert.deepEqual(
      log
        .split("\n")
        .filter((l) => l.startsWith("request "))
        .map((l) => l.slice(8)),
      ["initialize", "get_settings", "get_usage"],
    );
  });

  test("the working folder is created and the environment is exactly what was given", async () => {
    const dir = tempDir();
    const client = start(dir, { VIDAI_PROBE: "1" });
    await client.request("initialize", 10_000);
    await client.close();
    assert.match(logOf(dir), /cwd=/);
  });

  test("mcp_status is never sent", async () => {
    const client = start(tempDir());
    assert.throws(() => client.request("mcp_status", 1000), /never sent/);
    await client.close();
  });

  test("an unsupported request is an error answer, the helper stays usable", async () => {
    const client = start(tempDir());
    await assert.rejects(client.request("bogus", 5000), /could not answer bogus: Unsupported/);
    assert.ok(client.isAlive());
    assert.ok((await client.request("initialize", 5000)) !== null);
    await client.close();
  });

  test("a timeout rejects that request only; the next one works", async () => {
    const dir = tempDir();
    const client = start(dir, { FAKE_CLAUDE_SILENT: "get_settings" });
    await assert.rejects(client.request("get_settings", 150), /did not answer within 1 seconds/);
    assert.ok(client.isAlive(), "a timeout does not kill or poison the helper");
    const init = await client.request("initialize", 5000);
    assert.ok(init);
    await assert.rejects(client.request("get_settings", 100), /did not answer/);
    assert.ok((await client.request("get_usage", 5000)) !== null);
    await client.close();
  });

  test("requests in flight together are matched by id", async () => {
    const client = start(tempDir());
    const [init, usage] = await Promise.all([
      client.request("initialize", 5000),
      client.request("get_usage", 5000),
    ]);
    assert.ok(init && typeof init === "object" && "models" in init);
    assert.ok(usage && typeof usage === "object" && "rate_limits" in usage);
    await client.close();
  });

  test("a helper that exits fails the request with the last stderr line", async () => {
    const client = start(tempDir(), { FAKE_CLAUDE_EXIT_ON: "initialize" });
    await assert.rejects(
      client.request("initialize", 10_000),
      (error) =>
        error instanceof AppError &&
        error.message ===
          "Claude Code stopped unexpectedly: Error: fake claude stopped on initialize",
    );
    assert.equal(client.isAlive(), false);
    await assert.rejects(client.request("initialize", 1000), /stopped unexpectedly/);
    await client.close();
  });

  test("close() leaves no process behind, and can be called twice", async () => {
    const client = start(tempDir());
    await client.request("initialize", 5000);
    const closing = client.close();
    assert.equal(client.close(), closing);
    await closing;
    assert.equal(isAlive(client.pid), false);
    assert.equal(client.isAlive(), false);
    await assert.rejects(client.request("initialize", 1000), /closed/);
  });

  test("close() with a pending request rejects it and ends the process", async () => {
    const client = start(tempDir(), { FAKE_CLAUDE_SILENT: "initialize" });
    const pending = client.request("initialize", 60_000);
    pending.catch(() => undefined);
    await client.close();
    await assert.rejects(pending, /closed/);
    assert.equal(isAlive(client.pid), false);
  });

  test("close() ends a helper that ignores stdin and SIGTERM", async () => {
    const dir = tempDir();
    const client = startControlClient({
      command: FAKE_HANG,
      env: fakeEnv(dir),
      cwd: `${dir}/work`,
      exitGraceMs: 100,
      killGraceMs: 100,
    });
    const pending = client.request("get_usage", 60_000);
    pending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(isAlive(client.pid), true);
    await client.close();
    await assert.rejects(pending, /closed/);
    assert.equal(isAlive(client.pid), false);
  });

  test("a program that cannot start is an error, not a crash", () => {
    const dir = tempDir();
    assert.throws(
      () =>
        startControlClient({
          command: `${dir}/missing`,
          env: fakeEnv(dir),
          cwd: `${dir}/work`,
        }),
      (error) => error instanceof AppError && /Could not start Claude Code/.test(error.message),
    );
  });
});

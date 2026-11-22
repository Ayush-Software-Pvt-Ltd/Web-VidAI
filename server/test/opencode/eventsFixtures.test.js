// The recordings of OpenCode 2.2.6 (`test/support/fixtures/opencode2-stream/`) replayed through
// the translator: what the translator must produce, plus the same events fed to the
// Claude `TurnTracker` (the job engine consumes them exactly that way) and checked against the
// key sets `protocol.js` produces.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  isEmptyResult,
  isInterrupted,
  isResumeNotFound,
  errorText,
  parseValue,
} from "../../src/agents/claude/protocol.js";
import { TurnTracker } from "../../src/agents/claude/turnTracker.js";
import { createTranslator } from "../../src/agents/opencode/events.js";

const DIR = "/Users/editor/Editing/work1";
const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "support",
  "fixtures",
  "opencode2-stream",
);

/** @typedef {import("../../src/agents/claude/protocol.js").StreamEvent} StreamEvent */
/** @typedef {import("../../src/agents/claude/protocol.js").TurnResult} TurnResult */
/** @typedef {import("../../src/agents/opencode/events.js").Translator} Translator */

/**
 * @param {string} name
 * @returns {Record<string, any>[]}
 */
function fixture(name) {
  return fs
    .readFileSync(path.join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * The main session of a recording: the first session created without a parent, or the first
 * session named at all.
 * @param {Record<string, any>[]} events
 * @returns {string}
 */
function mainSession(events) {
  const created = events.find(
    (e) =>
      e.type === "session.created" && (e.data.parentID === undefined || e.data.parentID === null),
  );
  const any = events.find((e) => typeof e.data?.sessionID === "string");
  return (created ?? any)?.data.sessionID;
}

/**
 * Replays a recording, sending a prompt where the recording shows VidAI's message queued for the
 * main session, and feeding every translated event to a TurnTracker.
 * @param {string} name
 * @param {{ model?: string, before?: (t: Translator, event: Record<string, any>) => void }} [options]
 */
function replay(name, options = {}) {
  const recording = fixture(name);
  const main = mainSession(recording);
  const t = createTranslator({
    sessionId: main,
    model: options.model ?? "opencode/big-pickle",
    directory: DIR,
  });
  const tracker = new TurnTracker(0);
  /** @type {StreamEvent[]} */
  const events = [];
  /** @type {import("../../src/agents/opencode/events.js").Action[]} */
  const actions = [];
  /** @type {import("../../src/agents/claude/turnTracker.js").Activity[]} */
  const afterResults = [];
  let now = 0;
  for (const event of recording) {
    now += 1;
    if (
      event.type === "session.inbox.enqueued" &&
      event.data.sessionID === main &&
      event.data.item?.type === "user"
    ) {
      t.promptSent();
      tracker.messageSent(now);
    }
    options.before?.(t, event);
    const out = t.translate(event);
    actions.push(...out.actions);
    for (const e of out.events) {
      events.push(e);
      tracker.observe(e, now);
      if (e.type === "result") afterResults.push(tracker.activity());
    }
  }
  return { events, actions, t, tracker, afterResults };
}

/** @param {StreamEvent[]} events @returns {TurnResult[]} */
const results = (events) => events.flatMap((e) => (e.type === "result" ? [e] : []));

/** @param {StreamEvent[]} events */
const tools = (events) =>
  events.flatMap((e) => {
    if (e.type !== "assistant") return [];
    const block = e.content.find((b) => b.type === "toolUse");
    return block?.type === "toolUse"
      ? [
          {
            name: block.name,
            input: /** @type {any} */ (block.input),
            nested: e.parentToolUseId !== null,
          },
        ]
      : [];
  });

/** @param {StreamEvent[]} events */
const texts = (events) =>
  events.flatMap((e) => {
    if (e.type !== "assistant") return [];
    const block = e.content.find((b) => b.type === "text");
    return block?.type === "text" ? [{ text: block.text, nested: e.parentToolUseId !== null }] : [];
  });

/** @param {StreamEvent[]} events */
const toolResults = (events) =>
  events.flatMap((e) => {
    if (e.type !== "user") return [];
    const block = e.content.find((b) => b.type === "toolResult");
    return block?.type === "toolResult" ? [{ text: block.text, isError: block.isError }] : [];
  });

describe("recorded streams", () => {
  test("01: two turns with files and commands", () => {
    const { events, actions } = replay("01_turns_with_tools.jsonl");
    assert.deepEqual(actions, []);
    const inits = events.flatMap((e) =>
      e.type === "system" && e.subtype === "init" ? [[e.sessionId, e.model]] : [],
    );
    assert.equal(inits.length, 2);
    assert.deepEqual(inits[0], ["ses_e204bd724ffenrgalf5N7ln7ys", "opencode/big-pickle"]);
    // The tools as Claude Code names them, each once, with Claude Code's input keys.
    const used = tools(events);
    assert.deepEqual(
      used.map((u) => u.name),
      ["Write", "Bash", "Read", "Edit", "Bash"],
    );
    assert.deepEqual(used[0]?.input, { file_path: "a.txt", content: "hello\n" });
    assert.deepEqual(used[1]?.input, { command: "ls -la" });
    assert.deepEqual(used[3]?.input, {
      file_path: "a.txt",
      old_string: "hello",
      new_string: "hello world",
    });
    assert.ok(used.every((u) => !u.nested));
    // Each tool has exactly one result.
    const done = toolResults(events);
    assert.equal(done.length, 5);
    assert.deepEqual(done[4], { text: "hello world\n", isError: false });
    // The project file's rule reached the model through the configured instructions.
    const said = texts(events);
    assert.equal(said.length, 3);
    assert.ok(said[1]?.text.endsWith("PINEAPPLE"));
    // Each turn ends with one successful result carrying its last text and the cost.
    const found = results(events);
    assert.equal(found.length, 2);
    assert.ok(found.every((r) => !r.isError && !isEmptyResult(r)));
    assert.equal(found[0]?.numTurns, 5);
    assert.ok(found[1]?.text?.includes("hello world"));
    assert.equal(found[1]?.totalCostUsd, 0);
  });

  test("02: an interrupt ends the turn as interrupted", () => {
    const { events, actions, t, afterResults } = replay("02_interrupt_during_shell.jsonl", {
      model: "m",
      before: (translator, event) => {
        // The interrupt was asked for just before the command failed.
        if (event.type === "session.tool.failed") translator.abortRequested();
      },
    });
    assert.deepEqual(actions, []);
    const found = results(events);
    assert.equal(found.length, 1);
    assert.ok(found[0]?.isError && isInterrupted(found[0]));
    // The cut command still reports its end.
    assert.deepEqual(toolResults(events), [{ text: "Tool execution interrupted", isError: true }]);
    assert.deepEqual(afterResults, [{ kind: "idle" }]);
    // From now on a busy period of the job is interrupted as soon as it starts.
    const out = t.translate({
      type: "session.execution.started",
      data: { sessionID: t.sessionId },
    });
    assert.deepEqual(out.actions, [{ type: "interrupt", session: t.sessionId }]);
  });

  test("03 and 04: errors are worded like Claude Code's", () => {
    const unknown = results(replay("03_unknown_model.jsonl").events);
    assert.equal(unknown.length, 1);
    const [first] = unknown;
    assert.ok(first?.isError && !isInterrupted(first) && !isResumeNotFound(first));
    assert.equal(errorText(first), "Model unavailable: opencode/no-such-model-xyz");

    const refused = results(replay("04_refused_key.jsonl").events);
    assert.equal(refused.length, 1, "one message, one result");
    assert.equal(refused[0]?.apiErrorStatus, 401);
    assert.equal(
      errorText(/** @type {TurnResult} */ (refused[0])),
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid credential"}}',
    );
  });

  test("05: a resumed session answers in a new server", () => {
    const found = results(replay("05_resume_in_new_server.jsonl").events);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.isError, false);
    assert.ok(found[0]?.text?.includes("hello world"));
  });

  test("06: background commands and sub-agents keep the job waiting", () => {
    const { events, afterResults } = replay("06_background_shell_and_subagent.jsonl");
    const used = tools(events);
    assert.deepEqual(
      used.map((u) => [u.name, u.nested]),
      [
        ["Bash", false],
        ["Agent", false],
        ["Bash", true],
      ],
    );
    assert.equal(used[0]?.input.run_in_background, true);
    assert.equal(used[1]?.input.subagent_type, "general");
    assert.equal(used[1]?.input.description, "Count files");
    const agentCall = "call_54bbeda0022a494fb6b46fcc";
    const child = "ses_e204b0562ffe0n9cr1L82NhFD8";
    const shell = "sh_1dfb4fa9e001pjrFR6z1ICD1EY";
    // The sub-agent's prompt, tool calls and answer are nested under its tool call.
    assert.ok(
      events.some(
        (e) =>
          e.type === "user" &&
          e.parentToolUseId === agentCall &&
          e.content[0]?.type === "text" &&
          e.content[0].text.startsWith("You are a subagent"),
      ),
    );
    assert.ok(
      events.some(
        (e) =>
          e.type === "assistant" &&
          e.parentToolUseId === agentCall &&
          e.content.length === 1 &&
          e.content[0]?.type === "text" &&
          e.content[0].text === "2\n\nPINEAPPLE",
      ),
    );
    // Both run in the background, and their reports are notifications.
    const tasks = events.flatMap((e) => {
      if (e.type !== "system") return [];
      if (e.subtype === "taskStarted" && e.backgrounded && e.taskType !== null) {
        return [`started ${e.taskType} ${e.taskId}`];
      }
      if (e.subtype === "taskNotification" && e.status !== null && e.summary !== null) {
        return [`${e.status} ${e.taskId}: ${e.summary}`];
      }
      return [];
    });
    assert.deepEqual(tasks, [
      `started local_bash ${shell}`,
      `started local_agent ${child}`,
      `completed ${child}: 2\n\nPINEAPPLE`,
      `completed ${shell}: bg-done`,
    ]);
    // Three busy periods of the main session: the message, and one per report; the sub-agent's
    // own busy period ends nothing of the main session.
    const found = results(events);
    assert.equal(found.length, 3);
    assert.ok(found.every((r) => !r.isError && !isEmptyResult(r)));
    assert.ok(found[2]?.text?.includes("bg-done"));
    // The engine's turn tracking: waiting for the two background tasks, then for one, then idle
    // only after the last report's turn.
    assert.deepEqual(afterResults, [
      { kind: "waitingForBackground", count: 2 },
      { kind: "waitingForBackground", count: 1 },
      { kind: "idle" },
    ]);
  });

  test("07 and 08: permission requests and questions are answered", () => {
    const permission = replay("07_permission_asked.jsonl");
    assert.deepEqual(permission.actions, [
      {
        type: "replyPermission",
        session: "ses_e204abf15ffeWnPwILo3GypQD2",
        id: "per_1dfb551ab001CBrWEBkddKKeFH",
      },
    ]);
    assert.equal(results(permission.events).length, 1);

    const question = replay("08_question_form.jsonl");
    assert.deepEqual(question.actions, [
      {
        type: "cancelForm",
        session: "ses_e204aa064ffegxrmHJ8zYn3OCE",
        id: "frm_1dfb56973001ikKX1Mhe9wCH0g",
      },
    ]);
    const found = results(question.events);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.isError, false, "the model went on without an answer");
  });
});

describe("recorded streams through the turn tracker", () => {
  /** The state each recording ends in: every finished turn leaves the job idle. */
  const idleAtTheEnd = [
    "01_turns_with_tools.jsonl",
    "02_interrupt_during_shell.jsonl",
    "03_unknown_model.jsonl",
    "04_refused_key.jsonl",
    "05_resume_in_new_server.jsonl",
    "06_background_shell_and_subagent.jsonl",
    "07_permission_asked.jsonl",
    "08_question_form.jsonl",
  ];
  for (const name of idleAtTheEnd) {
    test(`${name} ends idle with nothing open`, () => {
      const { tracker, t, afterResults } = replay(name, {
        before: (translator, event) => {
          if (event.type === "session.tool.failed") translator.abortRequested();
        },
      });
      assert.deepEqual(tracker.activity(), { kind: "idle" });
      assert.deepEqual(tracker.backgroundTasks(), []);
      assert.equal(t.inTurn(), false);
      assert.equal(t.waitingForBackground(), false);
      assert.deepEqual(t.backgroundIds(), []);
      assert.ok(afterResults.length >= 1);
    });
  }

  test("while background work is pending the tracker waits and the translator agrees", () => {
    const recording = fixture("06_background_shell_and_subagent.jsonl");
    const main = mainSession(recording);
    const t = createTranslator({ sessionId: main, model: "m", directory: DIR });
    const tracker = new TurnTracker(0);
    let sawWaiting = false;
    for (const event of recording) {
      if (
        event.type === "session.inbox.enqueued" &&
        event.data.sessionID === main &&
        event.data.item?.type === "user"
      ) {
        t.promptSent();
        tracker.messageSent(1);
      }
      for (const e of t.translate(event).events) {
        tracker.observe(e, 1);
        if (e.type === "result" && tracker.activity().kind === "waitingForBackground") {
          sawWaiting = true;
          assert.equal(t.waitingForBackground(), true);
          assert.ok(t.backgroundIds().length > 0);
        }
      }
    }
    assert.ok(sawWaiting);
  });
});

describe("the shapes of the emitted events", () => {
  /**
   * What `protocol.js` produces for a line of each kind, written with every field Claude Code
   * can put on it: the key set the translator's events must have exactly.
   * @type {Record<string, unknown>}
   */
  const samples = {
    "system/init": { type: "system", subtype: "init", session_id: "s", model: "m" },
    "system/taskStarted": {
      type: "system",
      subtype: "task_started",
      task_id: "t",
      description: "d",
      task_type: "local_bash",
      is_backgrounded: true,
    },
    "system/taskProgress": {
      type: "system",
      subtype: "task_progress",
      task_id: "t",
      description: "d",
    },
    "system/taskUpdated": {
      type: "system",
      subtype: "task_updated",
      task_id: "t",
      patch: { status: "completed" },
    },
    "system/taskNotification": {
      type: "system",
      subtype: "task_notification",
      task_id: "t",
      status: "completed",
      summary: "s",
    },
    "system/other": { type: "system", subtype: "api_retry" },
    assistant: { type: "assistant", parent_tool_use_id: null, message: { content: [] } },
    user: { type: "user", parent_tool_use_id: null, message: { content: [] } },
    result: {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      result: "r",
      errors: [],
      total_cost_usd: 0,
      session_id: "s",
      api_error_status: null,
      terminal_reason: "completed",
    },
    "block/text": { type: "text", text: "x" },
    "block/toolUse": { type: "tool_use", id: "i", name: "n", input: {} },
    "block/toolResult": { type: "tool_result", tool_use_id: "i", content: "c", is_error: false },
  };

  /** @param {string} key @returns {string[]} */
  function keysOf(key) {
    const raw = /** @type {any} */ (samples[key]);
    // A block is read inside a message, as the engine gets it.
    const event = parseValue(
      key.startsWith("block/")
        ? { type: "assistant", parent_tool_use_id: null, message: { content: [raw] } }
        : raw,
    );
    assert.ok(event, key);
    if (key.startsWith("block/")) {
      assert.equal(event.type, "assistant");
      const block = event.type === "assistant" ? event.content[0] : null;
      assert.ok(block, key);
      return Object.keys(block).sort();
    }
    return Object.keys(event).sort();
  }

  /** @param {StreamEvent} event @returns {string} */
  function kindOf(event) {
    return event.type === "system" ? `system/${event.subtype}` : event.type;
  }

  /** @param {unknown} value @returns {string[]} */
  const keys = (value) => Object.keys(/** @type {object} */ (value)).sort();

  test("every event of every recording has the key set of protocol.js for its kind", () => {
    const seen = new Set();
    const names = fs.readdirSync(FIXTURES).filter((n) => n.endsWith(".jsonl"));
    assert.equal(names.length, 8);
    for (const name of names) {
      for (const event of replay(name).events) {
        const kind = kindOf(event);
        seen.add(kind);
        assert.deepEqual(keys(event), keysOf(kind), `${name}: ${kind}`);
        if (event.type === "assistant" || event.type === "user") {
          for (const block of event.content) {
            seen.add(`block/${block.type}`);
            assert.deepEqual(keys(block), keysOf(`block/${block.type}`), `${name}: ${block.type}`);
          }
        }
      }
    }
    // The recordings cover every kind except `task_updated` and a plain retry (next test).
    for (const kind of [
      "system/init",
      "system/taskStarted",
      "system/taskProgress",
      "system/taskNotification",
      "assistant",
      "user",
      "result",
      "block/text",
      "block/toolUse",
      "block/toolResult",
    ]) {
      assert.ok(seen.has(kind), kind);
    }
  });

  test("the events no recording has (task_updated, a plain retry, error results) have them too", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    // A background command that vanished (twice missing from the server's list) is task_updated.
    for (const event of [
      { type: "session.tool.input.started", data: { sessionID: "ses_1", id: "c1", name: "shell" } },
      {
        type: "session.tool.called",
        data: { sessionID: "ses_1", id: "c1", input: { command: "sleep 9" } },
      },
      {
        type: "session.tool.success",
        data: { sessionID: "ses_1", id: "c1", metadata: { status: "running", shellID: "sh_1" } },
      },
    ]) {
      t.translate(event);
    }
    t.reconcile([]);
    const updated = t.reconcile([]);
    t.promptSent();
    t.translate({ type: "session.execution.started", data: { sessionID: "ses_1" } });
    const retry = t.translate({
      type: "session.retry.scheduled",
      data: { sessionID: "ses_1", error: { type: "provider.rate-limit" } },
    }).events;
    const refused = t.promptRefused("nope");
    const sample = [...updated, ...retry, ...refused];
    assert.deepEqual(sample.map(kindOf), ["system/taskUpdated", "system/other", "result"]);
    for (const event of sample) assert.deepEqual(keys(event), keysOf(kindOf(event)));
  });

  test("the reference key sets are the ones protocol.js really produces", () => {
    assert.deepEqual(keysOf("result"), [
      "apiErrorStatus",
      "errors",
      "isError",
      "numTurns",
      "sessionId",
      "subtype",
      "terminalReason",
      "text",
      "totalCostUsd",
      "type",
    ]);
    assert.deepEqual(keysOf("system/taskStarted"), [
      "backgrounded",
      "description",
      "subtype",
      "taskId",
      "taskType",
      "type",
    ]);
  });
});

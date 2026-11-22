import assert from "node:assert/strict";
import { test } from "node:test";
import {
  controlRequestLine,
  errorText,
  interruptLine,
  isEmptyResult,
  isInterrupted,
  isNested,
  isRateLimitRejected,
  isResumeNotFound,
  parseLine,
  userMessageLine,
} from "../../src/agents/claude/protocol.js";
import { fixture } from "../support/claudeFixtures.js";

/** @param {import("../../src/agents/claude/protocol.js").StreamEvent[]} events */
const results = (events) =>
  /** @type {import("../../src/agents/claude/protocol.js").TurnResult[]} */ (
    events.filter((e) => e.type === "result")
  );

test("builds stdin lines", () => {
  const line = userMessageLine('Hello "there"\nsecond line');
  assert.deepEqual(JSON.parse(line), {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: 'Hello "there"\nsecond line' }],
    },
    parent_tool_use_id: null,
    session_id: "",
  });
  assert.ok(!line.includes("\n"), "one line on the wire");
  assert.deepEqual(JSON.parse(interruptLine("int-1")), {
    type: "control_request",
    request_id: "int-1",
    request: { subtype: "interrupt" },
  });
  assert.equal(JSON.parse(controlRequestLine("u1", "get_usage")).request.subtype, "get_usage");
});

test("unknown and broken lines are ignored", () => {
  assert.equal(parseLine(""), null);
  assert.equal(parseLine("   "), null);
  assert.equal(parseLine("not json"), null);
  assert.equal(parseLine("[1,2]"), null);
  assert.equal(parseLine("42"), null);
  assert.deepEqual(parseLine('{"type":"stream_event","event":{}}'), {
    type: "other",
    kind: "stream_event",
  });
  assert.deepEqual(parseLine('{"type":"system","subtype":"something_new","x":1}'), {
    type: "system",
    subtype: "other",
    rawSubtype: "something_new",
  });
  // Missing fields never fail.
  const result = parseLine('{"type":"result"}');
  assert.equal(result?.type, "result");
  assert.equal(result?.type === "result" && result.numTurns, 0);
  assert.equal(result?.type === "result" && result.isError, false);
  const assistant = parseLine('{"type":"assistant"}');
  assert.deepEqual(assistant, { type: "assistant", parentToolUseId: null, content: [] });
});

test("background task recording", () => {
  const events = fixture("01_background_task.jsonl");
  // Two turns: the second one starts by itself when the background task reports back.
  const found = results(events);
  assert.equal(found.length, 2);
  assert.ok(found.every((r) => !r.isError && r.numTurns === 2));
  assert.equal(found[1]?.text, "[OUTPUT COMPLETED]");
  assert.equal(found[1]?.totalCostUsd, 0.00707391);

  const changes = events.flatMap((e) =>
    e.type === "system" && e.subtype === "backgroundTasksChanged" ? [e.tasks.length] : [],
  );
  assert.deepEqual(changes, [1, 0]);
  assert.ok(
    events.some(
      (e) =>
        e.type === "system" &&
        e.subtype === "taskStarted" &&
        e.backgrounded &&
        e.taskType === "local_bash",
    ),
  );
  assert.ok(
    events.some(
      (e) => e.type === "system" && e.subtype === "taskNotification" && e.status === "completed",
    ),
  );
  const inits = events.filter((e) => e.type === "system" && e.subtype === "init").length;
  assert.equal(inits, 2, "init is repeated at the start of the second turn");

  // The tool call carries a description, and thinking content is dropped.
  /** @type {{ name: string, input: any } | undefined} */
  let tool;
  for (const e of events) {
    if (e.type !== "assistant") continue;
    for (const b of e.content) if (b.type === "toolUse" && tool === undefined) tool = b;
  }
  assert.equal(tool?.name, "Bash");
  assert.equal(tool?.input.description, "Sleep 10 seconds then echo slept");
  assert.ok(
    events.some(
      (e) => e.type === "assistant" && e.content.length === 1 && e.content[0]?.type === "thinking",
    ),
  );
  const rate = events.find((e) => e.type === "rateLimit");
  assert.equal(rate?.type === "rateLimit" && rate.status, "allowed");
  assert.equal(rate?.type === "rateLimit" && isRateLimitRejected(rate), false);
  assert.equal(rate?.type === "rateLimit" && rate.resetsAt, 1794637200);
  assert.equal(
    rate?.type === "rateLimit" &&
      /** @type {any} */ (rate.raw).unifiedWindows.five_hour.utilization,
    0.19,
  );
});

test("sub-agent and interrupt recording", () => {
  const events = fixture("02_subagent_interrupt.jsonl");
  // Sub-agent messages carry the parent tool use id.
  assert.ok(events.some((e) => e.type === "user" && isNested(e)));
  assert.ok(events.some((e) => e.type === "assistant" && isNested(e)));
  assert.ok(
    events.some(
      (e) =>
        e.type === "system" &&
        e.subtype === "taskStarted" &&
        !e.backgrounded &&
        e.taskType === "local_agent",
    ),
  );
  assert.ok(
    events.some(
      (e) => e.type === "system" && e.subtype === "taskProgress" && e.description !== null,
    ),
  );
  // The interrupt is answered by a control_response, and the cut turn ends with an error
  // result marked as aborted.
  const response = events.find((e) => e.type === "controlResponse");
  assert.deepEqual(response, {
    type: "controlResponse",
    requestId: "req_int_1",
    success: true,
    error: null,
  });
  const found = results(events);
  assert.equal(found.length, 1);
  assert.ok(found[0]?.isError && isInterrupted(found[0]));
  assert.equal(found[0]?.numTurns, 3);
  assert.ok(
    events.some(
      (e) =>
        e.type === "user" &&
        e.content.length === 1 &&
        e.content[0]?.type === "text" &&
        e.content[0].text === "[Request interrupted by user]",
    ),
  );
  // Tool results arrive as text, with array content joined.
  assert.ok(
    events.some(
      (e) =>
        e.type === "user" &&
        e.content.some((b) => b.type === "toolResult" && b.text.includes("date output")),
    ),
  );
});

test("resume recordings", () => {
  const events = fixture("03_resume_after_interrupt.jsonl");
  const found = results(events);
  assert.equal(found.length, 1);
  assert.ok(!isEmptyResult(/** @type {any} */ (found[0])));

  // A pending task notification makes the resumed process emit an empty result first.
  const resumed = results(fixture("06_resume_empty_result.jsonl"));
  assert.equal(resumed.length, 2);
  assert.ok(isEmptyResult(/** @type {any} */ (resumed[0])));
  assert.ok(!isEmptyResult(/** @type {any} */ (resumed[1])));
  assert.equal(resumed[1]?.text, "HI");
});

test("resume of a missing session recording", () => {
  const found = results(fixture("04_resume_missing_session.jsonl"));
  assert.equal(found.length, 1);
  const r = /** @type {import("../../src/agents/claude/protocol.js").TurnResult} */ (found[0]);
  assert.ok(r.isError && r.numTurns === 0 && !isEmptyResult(r) && !isInterrupted(r));
  assert.equal(r.subtype, "error_during_execution");
  assert.ok(isResumeNotFound(r));
  assert.ok(errorText(r).startsWith("No conversation found with session ID"));
});

test("interrupt while idle recording", () => {
  const events = fixture("05_interrupt_idle_with_background_task.jsonl");
  const updates = events.flatMap((e) =>
    e.type === "system" && e.subtype === "taskUpdated" && e.status !== null ? [e.status] : [],
  );
  assert.deepEqual(updates, ["killed"]);
  assert.ok(events.some((e) => e.type === "controlResponse" && e.requestId === "int1"));
});

test("error text prefers the result text, then the errors", () => {
  /** @type {import("../../src/agents/claude/protocol.js").TurnResult} */
  const base = {
    type: "result",
    subtype: "error_during_execution",
    isError: true,
    numTurns: 0,
    text: null,
    errors: [],
    totalCostUsd: null,
    sessionId: null,
    apiErrorStatus: null,
    terminalReason: null,
  };
  assert.equal(errorText(base), "error_during_execution");
  const withErrors = { ...base, text: "API Error: 500", errors: ["boom"] };
  assert.equal(errorText(withErrors), "API Error: 500\nboom");
  assert.ok(!isResumeNotFound(withErrors));
});

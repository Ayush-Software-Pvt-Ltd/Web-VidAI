import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLine } from "../../src/agents/claude/protocol.js";
import { TurnTracker } from "../../src/agents/claude/turnTracker.js";
import { fixture, lines } from "../support/claudeFixtures.js";

const T0 = 1_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * @param {TurnTracker} tracker
 * @param {string} file
 * @param {number} now
 */
function feed(tracker, file, now) {
  return fixture(file)
    .map((e) => tracker.observe(e, now))
    .filter((o) => o.kind !== "nothing");
}

/** @param {unknown} value */
const event = (value) =>
  /** @type {import("../../src/agents/claude/protocol.js").StreamEvent} */ (
    parseLine(JSON.stringify(value))
  );

test("a tool call with a longer time limit is silent that long", () => {
  const t = new TurnTracker(T0);
  const base = 20 * MINUTE;
  assert.equal(t.stallLimit(base), base);
  /** @param {string} id @param {number} timeout */
  const call = (id, timeout) =>
    event({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id, name: "Bash", input: { command: "x", timeout } }],
      },
    });
  /** @param {string} id */
  const result = (id) =>
    event({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    });
  // An hour-long command: silent up to that hour and two minutes of grace.
  t.observe(call("a", 3_600_000), T0);
  assert.equal(t.stallLimit(base), 62 * MINUTE);
  // A short limit never lowers the base; the longest running limit counts.
  t.observe(call("b", 120_000), T0);
  assert.equal(t.stallLimit(base), 62 * MINUTE);
  t.observe(result("a"), T0);
  assert.equal(t.stallLimit(base), base);
  t.observe(result("b"), T0);
  assert.equal(t.stallLimit(base), base);
});

test("a background task keeps the job open after the first result", () => {
  const t = new TurnTracker(T0);
  t.messageSent(T0);
  let results = 0;
  for (const e of fixture("01_background_task.jsonl")) {
    if (t.observe(e, T0).kind === "turnEnded") {
      results += 1;
      if (results === 1) {
        assert.deepEqual(t.activity(), { kind: "waitingForBackground", count: 1 });
        assert.deepEqual(t.backgroundTasks(), ["Sleep 10 seconds then echo slept"]);
        assert.equal(t.isFinished(T0 + 3600 * SECOND, 0), false);
      }
    }
  }
  assert.equal(results, 2);
  assert.deepEqual(t.activity(), { kind: "idle" });
  const settle = 2 * SECOND;
  assert.equal(t.isFinished(T0 + SECOND, settle), false);
  assert.equal(t.isFinished(T0 + settle, settle), true);
  assert.equal(t.settleDeadline(settle), T0 + settle);
});

test("a notification between turns counts as work", () => {
  const t = new TurnTracker(T0);
  t.messageSent(T0);
  for (const e of lines(
    [
      '{"type":"system","subtype":"task_started","task_id":"b1","is_backgrounded":true,"description":"render"}',
      '{"type":"result","subtype":"success","num_turns":2,"is_error":false}',
      '{"type":"system","subtype":"task_notification","task_id":"b1","status":"completed"}',
    ].join("\n"),
  )) {
    t.observe(e, T0);
  }
  // The background task is gone, but its notification starts a new turn.
  assert.deepEqual(t.activity(), { kind: "working" });
  for (const e of lines('{"type":"result","subtype":"success","num_turns":1,"is_error":false}')) {
    t.observe(e, T0);
  }
  assert.deepEqual(t.activity(), { kind: "idle" });
});

test("the empty result after resume is not the answer", () => {
  const t = new TurnTracker(T0);
  t.messageSent(T0);
  const observed = feed(t, "06_resume_empty_result.jsonl", T0);
  assert.equal(observed[0]?.kind, "emptyResult");
  assert.ok(observed[1]?.kind === "turnEnded" && observed[1].result.text === "HI");
  assert.deepEqual(t.activity(), { kind: "idle" });

  // Stopping right after the empty result: still working on the message.
  const early = new TurnTracker(T0);
  early.messageSent(T0);
  for (const e of fixture("06_resume_empty_result.jsonl")) {
    if (early.observe(e, T0).kind === "emptyResult") break;
  }
  assert.deepEqual(early.activity(), { kind: "working" });
  assert.equal(early.answeredOnce(), false);
});

test("a missing session is an error result", () => {
  const t = new TurnTracker(T0);
  t.messageSent(T0);
  const observed = feed(t, "04_resume_missing_session.jsonl", T0);
  assert.equal(observed[0]?.kind, "error");
  assert.equal(t.answeredOnce(), true);
});

test("sub-agent output does not open a main turn", () => {
  const t = new TurnTracker(T0);
  for (const e of lines(
    [
      '{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a1","description":"Research"}]}',
      '{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"content":[{"type":"text","text":"working"}]}}',
    ].join("\n"),
  )) {
    t.observe(e, T0);
  }
  assert.deepEqual(t.activity(), { kind: "waitingForBackground", count: 1 });
  for (const e of lines('{"type":"system","subtype":"background_tasks_changed","tasks":[]}')) {
    t.observe(e, T0);
  }
  assert.deepEqual(t.activity(), { kind: "idle" });
});

test("the interrupt recording ends the turn with an aborted error", () => {
  const t = new TurnTracker(T0);
  t.messageSent(T0);
  const observed = feed(t, "02_subagent_interrupt.jsonl", T0);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.kind, "error");
  assert.deepEqual(t.activity(), { kind: "idle" });
});

test("terminal task updates end a background task and other updates do not", () => {
  const t = new TurnTracker(T0);
  for (const e of lines(
    '{"type":"system","subtype":"task_started","task_id":"b","is_backgrounded":true}',
  )) {
    t.observe(e, T0);
  }
  assert.deepEqual(t.backgroundTasks(), ["b"]);
  t.observe(
    event({ type: "system", subtype: "task_updated", task_id: "b", patch: { status: "running" } }),
    T0,
  );
  assert.deepEqual(t.activity(), { kind: "waitingForBackground", count: 1 });
  t.observe(
    event({ type: "system", subtype: "task_updated", task_id: "b", patch: { status: "killed" } }),
    T0,
  );
  assert.deepEqual(t.activity(), { kind: "idle" });
});

test("quiet time counts from the last line", () => {
  const t = new TurnTracker(T0);
  assert.equal(t.quietFor(T0 + 5 * SECOND), 5 * SECOND);
  t.messageSent(T0 + 10 * SECOND);
  assert.equal(t.quietFor(T0 + 12 * SECOND), 2 * SECOND);
  // A pending message means working: never finished, no settle deadline.
  assert.equal(t.settleDeadline(SECOND), null);
  assert.equal(t.isFinished(T0 + 3600 * SECOND, SECOND), false);
});

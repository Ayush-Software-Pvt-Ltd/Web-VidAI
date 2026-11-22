// The rules of the translator, with events written out (the recordings are in
// eventsFixtures.test.js).

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { errorText, isInterrupted, isResumeNotFound } from "../../src/agents/claude/protocol.js";
import { createTranslator } from "../../src/agents/opencode/events.js";
import {
  limitResult,
  resumeNotFound,
  turnError,
  turnErrorText,
} from "../../src/agents/opencode/eventsErrors.js";

/** @typedef {import("../../src/agents/claude/protocol.js").StreamEvent} StreamEvent */
/** @typedef {import("../../src/agents/claude/protocol.js").TurnResult} TurnResult */

const DIR = "/Users/editor/Editing/work1";

/**
 * An event of `ses_1` (or `session`) with `extra` in its data.
 * @param {string} type
 * @param {Record<string, unknown>} [extra]
 * @param {string} [session]
 */
const ev = (type, extra = {}, session = "ses_1") => ({
  type,
  data: { sessionID: session, ...extra },
});

/** @param {string} id */
const userMessage = (id) =>
  ev("session.inbox.enqueued", { inboxID: id, item: { type: "user", payload: { text: "x" } } });

/** @param {StreamEvent[]} events @returns {TurnResult[]} */
const results = (events) => events.flatMap((e) => (e.type === "result" ? [e] : []));

/**
 * A command that runs on in the background.
 * @param {string} callId
 * @param {string} shellId
 * @param {string} [session]
 */
const backgroundShell = (callId, shellId, session = "ses_1") => [
  ev("session.tool.input.started", { id: callId, name: "shell" }, session),
  ev("session.tool.called", { id: callId, input: { command: "sleep 99" } }, session),
  ev(
    "session.tool.success",
    { id: callId, metadata: { status: "running", shellID: shellId }, content: [] },
    session,
  ),
];

/**
 * @param {ReturnType<typeof createTranslator>} t
 * @param {unknown[]} events
 * @returns {StreamEvent[]}
 */
function feed(t, events) {
  return events.flatMap((e) => t.translate(e).events);
}

describe("busy periods and results", () => {
  test("a turn is open from the message until its result", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    assert.equal(t.inTurn(), false);
    t.promptSent();
    assert.equal(t.inTurn(), true);
    feed(t, [userMessage("msg_1"), ev("session.execution.started")]);
    assert.equal(t.inTurn(), true);
    feed(t, [ev("session.inbox.delivered", { inboxID: "msg_1" })]);
    const out = feed(t, [ev("session.execution.succeeded")]);
    assert.equal(results(out).length, 1);
    assert.equal(t.inTurn(), false);
  });

  test("steps count as turns and their costs add up", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    t.promptSent();
    const out = feed(t, [
      userMessage("msg_1"),
      ev("session.execution.started"),
      ev("session.inbox.delivered", { inboxID: "msg_1" }),
      ev("session.step.ended", { cost: 0.25 }),
      // A sub-agent's step costs too, but is not a turn of the main session.
      ev("session.created", { parentID: "ses_1" }, "ses_c"),
      ev("session.step.ended", { cost: 0.5 }, "ses_c"),
      ev("session.step.failed", { cost: 0.125 }),
      ev("session.step.ended", { cost: 0.125 }),
      ev("session.text.ended", { text: "done" }),
      ev("session.execution.succeeded"),
    ]);
    const [result] = results(out);
    assert.equal(result?.numTurns, 2);
    assert.equal(result?.totalCostUsd, 1);
    assert.equal(result?.text, "done");
    assert.equal(result?.terminalReason, "completed");
    assert.equal(result?.sessionId, "ses_1");
    assert.deepEqual(result?.errors, []);
    assert.equal(result?.apiErrorStatus, null);
  });

  test("a turn without steps still counts as one", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    t.promptSent();
    const out = feed(t, [
      userMessage("msg_1"),
      ev("session.execution.started"),
      ev("session.inbox.delivered", { inboxID: "msg_1" }),
      ev("session.execution.succeeded"),
    ]);
    assert.equal(results(out)[0]?.numTurns, 1);
    assert.equal(results(out)[0]?.text, null);
  });

  test("messages are answered by the busy period they joined", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    // Two messages that joined one busy period get two results.
    t.promptSent();
    t.translate(userMessage("msg_1"));
    t.translate(ev("session.execution.started"));
    t.translate(ev("session.inbox.delivered", { inboxID: "msg_1" }));
    t.promptSent();
    t.translate(userMessage("msg_2"));
    t.translate(ev("session.inbox.delivered", { inboxID: "msg_2" }));
    let out = t.translate(ev("session.execution.succeeded")).events;
    assert.equal(results(out).length, 2);
    assert.equal(t.inTurn(), false);
    // A busy period that ends before a message joined it answers nothing yet.
    t.translate(ev("session.execution.started"));
    t.promptSent();
    t.translate(userMessage("msg_3"));
    out = t.translate(ev("session.execution.succeeded")).events;
    const found = results(out);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.isError, false);
    assert.equal(found[0]?.numTurns, 0, "an empty result");
    assert.equal(t.inTurn(), true);
  });

  test("a busy period of its own (woken by a report) gets one result", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    t.translate(ev("session.execution.started"));
    const out = t.translate(ev("session.execution.succeeded")).events;
    assert.equal(results(out).length, 1);
    assert.equal(results(out)[0]?.numTurns, 1);
  });

  test("a refused message ends its turn with the reason", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    t.promptSent();
    const out = t.promptRefused("OpenCode refused the message (HTTP 400): bad");
    const [result] = results(out);
    assert.ok(result?.isError && errorText(result).includes("HTTP 400"));
    assert.equal(result?.numTurns, 0);
    assert.equal(t.inTurn(), false);
  });

  test("a failed busy period is an error result per message, worded like Claude's", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    t.promptSent();
    t.translate(userMessage("msg_1"));
    t.translate(ev("session.execution.started"));
    t.translate(ev("session.inbox.delivered", { inboxID: "msg_1" }));
    t.promptSent();
    t.translate(userMessage("msg_2"));
    t.translate(ev("session.inbox.delivered", { inboxID: "msg_2" }));
    const out = t.translate(
      ev("session.execution.failed", {
        error: {
          type: "provider.auth",
          message: "Unauthorized",
          status: 401,
          response: { body: '{"type":"error"}\n' },
        },
      }),
    ).events;
    const found = results(out);
    assert.equal(found.length, 2);
    for (const r of found) {
      assert.equal(r.isError, true);
      assert.equal(r.apiErrorStatus, 401);
      assert.equal(r.terminalReason, "error");
      assert.deepEqual(r.errors, ['API Error: 401 {"type":"error"}']);
    }
  });

  test("an error without status or body is its message, else its type", () => {
    assert.equal(turnErrorText(turnError({ type: "provider.no-route", message: "Gone" })), "Gone");
    assert.equal(turnErrorText(turnError({ type: "provider.no-route" })), "provider.no-route");
    assert.equal(turnErrorText(turnError(null)), "unknown");
    assert.equal(
      turnErrorText(turnError({ message: "m", status: 502, response: { body: "  " } })),
      "API Error: 502 m",
    );
    assert.equal(turnError({ status: 70000 }).status, null);
    assert.equal(turnError({ status: -1 }).status, null);
  });

  test("an interrupt nobody asked for is an error", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    t.promptSent();
    t.translate(ev("session.execution.started"));
    const out = t.translate(ev("session.execution.interrupted", { reason: "shutdown" })).events;
    const [result] = results(out);
    assert.ok(result?.isError && !isInterrupted(result));
    assert.equal(errorText(result), "OpenCode 2 stopped the turn (shutdown).");
  });

  test("an interrupt VidAI asked for ends as interrupted, one result per message", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    t.promptSent();
    t.translate(userMessage("msg_1"));
    t.translate(ev("session.execution.started"));
    t.translate(ev("session.inbox.delivered", { inboxID: "msg_1" }));
    t.abortRequested();
    const out = t.translate(ev("session.execution.interrupted", { reason: "user" })).events;
    const [result] = results(out);
    assert.equal(results(out).length, 1);
    assert.ok(result?.isError && isInterrupted(result));
    assert.deepEqual(result?.errors, ["Session interrupted: user"]);
  });

  test("after a halt every busy period of the job is interrupted as it starts", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    t.translate(ev("session.created", { parentID: "ses_1" }, "ses_c"));
    t.abortRequested();
    assert.deepEqual(t.translate(ev("session.execution.started")).actions, [
      { type: "interrupt", session: "ses_1" },
    ]);
    // A sub-agent's busy period, too, and it adds no event of its own.
    const child = t.translate(ev("session.execution.started", {}, "ses_c"));
    assert.deepEqual(child.actions, [{ type: "interrupt", session: "ses_c" }]);
    assert.deepEqual(child.events, []);
    // Another job's session is left alone.
    assert.deepEqual(t.translate(ev("session.execution.started", {}, "ses_other")).actions, []);
  });

  test("init names the session and the model", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "opencode/big-pickle" });
    assert.deepEqual(t.translate(ev("session.execution.started")).events, [
      { type: "system", subtype: "init", sessionId: "ses_1", model: "opencode/big-pickle" },
    ]);
  });
});

describe("usage limits and retries", () => {
  const body =
    '{"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit exceeded"},"metadata":{"limitName":"weekly"}}';
  /** @param {string} type */
  const retry = (type) =>
    ev("session.retry.scheduled", {
      assistantMessageID: "msg_2",
      attempt: 1,
      at: 1,
      error: {
        type,
        message: "OpenCode Go weekly usage limit reached.",
        status: 429,
        response: { body },
      },
    });

  test("a usage limit ends the turn at once, once", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "opencode-go/glm-5.3" });
    t.promptSent();
    feed(t, [
      userMessage("msg_1"),
      ev("session.execution.started"),
      ev("session.inbox.delivered", { inboxID: "msg_1" }),
    ]);
    const out = t.translate(retry("provider.go-limit")).events;
    const [result] = results(out);
    assert.equal(results(out).length, 1);
    assert.ok(result?.isError);
    assert.equal(result?.apiErrorStatus, 429);
    assert.deepEqual(result?.errors, [`API Error: 429 ${body}`]);
    // Reported once; the busy period's own end adds nothing.
    assert.deepEqual(t.translate(retry("provider.go-limit")).events, []);
    const failed = ev("session.execution.failed", { error: { type: "aborted", message: "x" } });
    assert.deepEqual(t.translate(failed).events, []);
    assert.equal(t.inTurn(), false);
    // Any other retry is only activity.
    t.translate(ev("session.execution.started"));
    assert.deepEqual(t.translate(retry("provider.rate-limit")).events, [
      { type: "system", subtype: "other", rawSubtype: "api_retry" },
    ]);
  });

  test("every limit type counts", () => {
    for (const type of [
      "provider.go-limit",
      "provider.free-limit",
      "provider.quota",
      "provider.budget-limit",
      "provider.model-budget-limit",
    ]) {
      const t = createTranslator({ sessionId: "ses_1", model: "m" });
      t.translate(ev("session.execution.started"));
      assert.equal(results(t.translate(retry(type)).events).length, 1, type);
    }
  });

  test("a retry of a sub-agent says nothing", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    t.translate(ev("session.created", { parentID: "ses_1" }, "ses_c"));
    const child = ev("session.retry.scheduled", { error: { type: "provider.go-limit" } }, "ses_c");
    assert.deepEqual(t.translate(child).events, []);
  });

  test("a limit result out of a rate-limit event, in the gateway's words", () => {
    /** @param {unknown} raw @returns {import("../../src/agents/claude/protocol.js").RateLimitEvent} */
    const info = (raw) => ({ type: "rateLimit", status: "rejected", resetsAt: null, raw });
    const go = limitResult(info({ message: "Weekly usage limit reached" }), "ses_1");
    assert.equal(go.apiErrorStatus, 429);
    assert.equal(go.sessionId, "ses_1");
    assert.equal(go.numTurns, 1);
    const [text] = go.errors;
    assert.ok(text?.startsWith("API Error: 429 "));
    const parsed = JSON.parse(text?.slice("API Error: 429 ".length) ?? "");
    assert.deepEqual(parsed, {
      type: "error",
      error: { type: "GoUsageLimitError", message: "Weekly usage limit reached" },
      metadata: { limitName: "Weekly" },
    });
    const bare = limitResult(info({ message: "Usage limit reached" }), "ses_1");
    assert.equal(JSON.parse((bare.errors[0] ?? "").slice(15)).metadata.limitName, null);
    const none = limitResult(info(null), "ses_1");
    assert.equal(JSON.parse((none.errors[0] ?? "").slice(15)).error.message, "Usage limit reached");
    const free = limitResult(
      info({ message: "m", action: { reason: "free_tier_limit" } }),
      "ses_1",
    );
    assert.deepEqual(JSON.parse((free.errors[0] ?? "").slice(15)), {
      type: "error",
      error: { type: "FreeUsageLimitError", message: "m" },
    });
  });

  test("a resume that finds no session reads as Claude Code's", () => {
    const result = resumeNotFound("ses_9");
    assert.ok(isResumeNotFound(result));
    assert.equal(result.numTurns, 0);
    assert.equal(result.sessionId, "ses_9");
    assert.equal(result.totalCostUsd, null);
  });
});

describe("background work", () => {
  test("a background command and a sub-agent are tasks until their reports or two missed checks", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    feed(t, backgroundShell("c1", "sh_1"));
    feed(t, [
      ev("session.tool.input.started", { id: "c2", name: "subagent" }),
      ev("session.tool.called", { id: "c2", input: { agent: "general", description: "Count" } }),
      ev("session.tool.success", {
        id: "c2",
        metadata: { status: "running", sessionID: "ses_c" },
        content: [],
      }),
    ]);
    assert.equal(t.waitingForBackground(), true);
    assert.deepEqual(t.backgroundIds(), ["ses_c", "sh_1"]);
    assert.deepEqual(t.reconcile(["sh_1"]), []);
    assert.deepEqual(t.reconcile(["sh_1"]), [
      { type: "system", subtype: "taskUpdated", taskId: "ses_c", status: "completed" },
    ]);
    assert.deepEqual(t.backgroundIds(), ["sh_1"]);
    // A check that finds it again starts the count over.
    assert.deepEqual(t.reconcile([]), []);
    assert.deepEqual(t.reconcile(["sh_1"]), []);
    assert.deepEqual(t.reconcile([]), []);
    assert.equal(t.reconcile([]).length, 1);
    assert.equal(t.waitingForBackground(), false);
  });

  test("while a turn runs the job is not 'waiting for background'", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    feed(t, backgroundShell("c1", "sh_1"));
    t.promptSent();
    assert.equal(t.waitingForBackground(), false);
  });

  test("the command's report is a notification and ends the task", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    feed(t, backgroundShell("c1", "sh_1"));
    const out = t.translate(
      ev("session.inbox.enqueued", {
        inboxID: "msg_9",
        item: {
          type: "synthetic",
          payload: {
            text: '<shell id="sh_1">\nbg-done\n</shell>',
            metadata: { source: "shell", shellID: "sh_1", state: "completed" },
          },
        },
      }),
    ).events;
    assert.deepEqual(out, [
      {
        type: "system",
        subtype: "taskNotification",
        taskId: "sh_1",
        status: "completed",
        summary: "bg-done",
      },
    ]);
    assert.deepEqual(t.backgroundIds(), []);
    // A report of something unknown (or already reported) is ignored.
    const again = t.translate(
      ev("session.inbox.enqueued", {
        item: { type: "synthetic", payload: { metadata: { source: "shell", jobID: "sh_1" } } },
      }),
    );
    assert.deepEqual(again.events, []);
  });

  test("a report queued for a sub-agent's session completes the task without a notification", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    t.translate(ev("session.created", { parentID: "ses_1" }, "ses_c"));
    feed(t, backgroundShell("c9", "sh_c", "ses_c"));
    const out = t.translate(
      ev(
        "session.inbox.enqueued",
        {
          item: {
            type: "synthetic",
            payload: { text: "<shell>\nx\n</shell>", metadata: { source: "shell", jobID: "sh_c" } },
          },
        },
        "ses_c",
      ),
    ).events;
    assert.deepEqual(out, [
      { type: "system", subtype: "taskUpdated", taskId: "sh_c", status: "completed" },
    ]);
  });

  test("a sub-agent's events are nested under its tool call", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    const out = feed(t, [
      ev("session.tool.input.started", { id: "call_a", name: "subagent" }),
      ev("session.tool.called", { id: "call_a", input: { agent: "general" } }),
      ev("session.created", { parentID: "ses_1" }, "ses_c"),
      ev("session.tool.progress", { id: "call_a", metadata: { sessionID: "ses_c" } }),
      ev(
        "session.inbox.enqueued",
        { item: { type: "user", payload: { text: "You are a subagent" } } },
        "ses_c",
      ),
      ev("session.text.ended", { text: "hi" }, "ses_c"),
    ]);
    const nested = out.flatMap((e) =>
      e.type === "assistant" || e.type === "user" ? [[e.type, e.parentToolUseId]] : [],
    );
    assert.deepEqual(nested, [
      ["assistant", null],
      ["user", "call_a"],
      ["assistant", "call_a"],
    ]);
  });

  test("a child that is not this job's (no known parent) is ignored", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    t.translate(ev("session.created", { parentID: "ses_other" }, "ses_x"));
    assert.deepEqual(t.translate(ev("session.text.ended", { text: "hi" }, "ses_x")).events, []);
  });

  test("progress of a running tool is activity; a finished or unknown one is not", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    assert.deepEqual(t.translate(ev("session.tool.progress", { id: "nope" })).events, []);
    feed(t, [
      ev("session.tool.input.started", { id: "c1", name: "shell" }),
      ev("session.tool.called", { id: "c1", input: { command: "ls" } }),
    ]);
    assert.deepEqual(t.translate(ev("session.tool.progress", { id: "c1" })).events, [
      { type: "system", subtype: "taskProgress", taskId: "c1", description: null },
    ]);
    t.translate(ev("session.tool.success", { id: "c1", content: [] }));
    assert.deepEqual(t.translate(ev("session.tool.progress", { id: "c1" })).events, []);
  });
});

describe("tool calls and results", () => {
  test("a tool is announced once, even when its result comes first", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    const out = feed(t, [
      ev("session.tool.input.started", { id: "c1", name: "read" }),
      ev("session.tool.called", { id: "c1", input: { path: "a" } }),
      ev("session.tool.called", { id: "c1", input: { path: "a" } }),
      ev("session.tool.success", { id: "c1", content: [{ type: "text", text: "A" }] }),
      ev("session.tool.success", { id: "c1", content: [{ type: "text", text: "A" }] }),
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], {
      type: "assistant",
      parentToolUseId: null,
      content: [{ type: "toolUse", id: "c1", name: "Read", input: { file_path: "a" } }],
    });
    assert.deepEqual(out[1], {
      type: "user",
      parentToolUseId: null,
      content: [{ type: "toolResult", toolUseId: "c1", text: "A", isError: false }],
    });
  });

  test("a failed tool's result carries its content and its error message", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    /** @param {string} id @param {unknown[]} content @param {Record<string, unknown>} error */
    const failed = (id, content, error) => [
      ev("session.tool.input.started", { id, name: "shell" }),
      ev("session.tool.called", { id, input: { command: "x" } }),
      ev("session.tool.failed", { id, content, error }),
    ];
    const texts = [
      failed("a", [{ type: "text", text: "out" }], { message: "exit 1" }),
      failed("b", [], { message: "Tool execution interrupted" }),
      failed("c", [], {}),
    ].map((events) => {
      const done = feed(t, events).find((e) => e.type === "user");
      const block = done?.type === "user" ? done.content[0] : null;
      return block?.type === "toolResult" ? [block.text, block.isError] : null;
    });
    assert.deepEqual(texts, [
      ["out\n\nexit 1", true],
      ["Tool execution interrupted", true],
      ["The tool failed", true],
    ]);
  });

  test("a failed command is no background task", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    feed(t, [
      ev("session.tool.input.started", { id: "c1", name: "shell" }),
      ev("session.tool.called", { id: "c1", input: { command: "x" } }),
      ev("session.tool.failed", {
        id: "c1",
        metadata: { status: "running", shellID: "sh_1" },
        error: { message: "no" },
      }),
    ]);
    assert.deepEqual(t.backgroundIds(), []);
  });

  test("a backgrounded command also starts a task, with its command as description", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    const out = feed(t, backgroundShell("c1", "sh_1"));
    assert.deepEqual(out[out.length - 1], {
      type: "system",
      subtype: "taskStarted",
      taskId: "sh_1",
      description: "sleep 99",
      taskType: "local_bash",
      backgrounded: true,
    });
  });

  test("empty and blank texts are dropped", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    assert.deepEqual(t.translate(ev("session.text.ended", { text: " \n" })).events, []);
    assert.deepEqual(t.translate(ev("session.text.ended", {})).events, []);
  });

  test("reasoning, deltas and catalog events are dropped, unknown ones ignored", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    for (const type of [
      "session.reasoning.started",
      "session.reasoning.ended",
      "session.text.delta",
      "session.tool.input.delta",
      "session.step.started",
      "session.instructions.updated",
      "session.shell.started",
      "model.catalog.updated",
      "something.new.in.2.9",
    ]) {
      assert.deepEqual(t.translate(ev(type, { text: "x", id: "i" })), { events: [], actions: [] });
    }
    assert.deepEqual(t.translate({ type: "server.connected", data: {} }), {
      events: [],
      actions: [],
    });
  });

  test("anything that is not an event object translates to nothing", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m" });
    for (const value of [null, 7, "text", [], {}, { type: 1, data: 2 }]) {
      assert.deepEqual(t.translate(value), { events: [], actions: [] });
    }
    assert.deepEqual(t.translateText("not json"), { events: [], actions: [] });
    assert.deepEqual(t.translateText("[1]"), { events: [], actions: [] });
    assert.equal(t.translateText(JSON.stringify(ev("session.execution.started"))).events.length, 1);
  });
});

describe("permissions and forms", () => {
  test("another job's requests are left alone; this job's are answered", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m", directory: DIR });
    const ask = (/** @type {string} */ session) => ({
      type: "permission.asked",
      data: { id: "per_1", sessionID: session, action: "read" },
    });
    assert.deepEqual(t.translate(ask("ses_other")).actions, []);
    assert.deepEqual(t.translate(ask("ses_1")).actions, [
      { type: "replyPermission", session: "ses_1", id: "per_1" },
    ]);
    // A sub-agent's request is this job's too.
    t.translate(ev("session.created", { parentID: "ses_1" }, "ses_c"));
    assert.deepEqual(t.translate(ask("ses_c")).actions, [
      { type: "replyPermission", session: "ses_c", id: "per_1" },
    ]);
    // A request without an id cannot be answered.
    assert.deepEqual(
      t.translate({ type: "permission.asked", data: { sessionID: "ses_1" } }).actions,
      [],
    );
  });

  test("a form of this job is cancelled, a global one when it is of this folder", () => {
    const t = createTranslator({ sessionId: "ses_1", model: "m", directory: DIR });
    /** @param {string} session @param {string | undefined} [dir] */
    const form = (session, dir) => ({
      type: "form.created",
      ...(dir === undefined ? {} : { location: { directory: dir } }),
      data: { form: { id: "frm_1", sessionID: session, title: "T" } },
    });
    assert.deepEqual(t.translate(form("ses_1")).actions, [
      { type: "cancelForm", session: "ses_1", id: "frm_1" },
    ]);
    assert.deepEqual(t.translate(form("ses_other")).actions, []);
    assert.deepEqual(t.translate(form("global", DIR)).actions, [
      { type: "cancelForm", session: "global", id: "frm_1" },
    ]);
    assert.deepEqual(t.translate(form("global", "/elsewhere")).actions, []);
    assert.deepEqual(t.translate(form("global")).actions, []);
    assert.deepEqual(t.translate({ type: "form.created", data: { form: {} } }).actions, []);
    // Forms add no event.
    assert.deepEqual(t.translate(form("ses_1")).events, []);
  });
});

// Retries after a model error, plus the counter rules of the driver.

import assert from "node:assert/strict";
import test from "node:test";
import {
  GAPS_MS,
  LATER_GAP_MS,
  classify,
  clockText,
  createRetryPlanner,
  gap,
  inWords,
  wait,
} from "../../src/jobs/retry.js";

/** @typedef {import("../../src/agents/claude/protocol.js").TurnResult} TurnResult */

const NOW = Date.UTC(2026, 10, 14, 10, 0, 0);
const HOUR = 3_600_000;

/**
 * @param {string} text
 * @param {number | null} [apiErrorStatus]
 * @returns {TurnResult}
 */
function error(text, apiErrorStatus = null) {
  return {
    type: "result",
    subtype: "success",
    isError: true,
    numTurns: 1,
    text,
    errors: [],
    totalCostUsd: null,
    sessionId: null,
    apiErrorStatus,
    terminalReason: null,
  };
}

/**
 * @param {string} text
 * @param {number | null} [status]
 * @returns {string | null}
 */
function what(text, status = null) {
  return classify(error(text, status))?.what ?? null;
}

test("the schedule is 30s, 1m, 2m, 5m, 10m, then 15m", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => gap(n) / 1000),
    [30, 60, 120, 300, 600, 900, 900, 900],
  );
  assert.equal(gap(0), GAPS_MS[0]);
  assert.equal(gap(2 ** 32 - 1), LATER_GAP_MS);
});

test("a later reset replaces the gap", () => {
  const sixty = 60_000;
  assert.equal(wait(sixty, null, NOW), sixty);
  assert.equal(wait(sixty, NOW + 20_000, NOW), sixty);
  assert.equal(wait(sixty, NOW + 2 * HOUR, NOW), 7200_000);
  assert.equal(wait(sixty, NOW - HOUR, NOW), sixty);
});

test("waits in words", () => {
  /** @param {number} s */
  const words = (s) => inWords(s * 1000);
  assert.equal(words(1), "1 second");
  assert.equal(words(30), "30 seconds");
  assert.equal(words(60), "1 minute");
  assert.equal(words(120), "2 minutes");
  assert.equal(words(61), "2 minutes");
  assert.equal(words(900), "15 minutes");
  assert.equal(words(3600), "1 hour");
  assert.equal(words(3900), "1 hour 5 minutes");
  assert.equal(words(7200), "2 hours");
});

test("clock names the date when it is not today", () => {
  const clock = { now: () => NOW };
  assert.equal(clockText(Date.UTC(2026, 10, 14, 16, 30, 0), clock, "UTC"), "4:30 PM");
  assert.equal(clockText(Date.UTC(2026, 10, 19, 9, 5, 0), clock, "UTC"), "Nov 19, 9:05 AM");
  // The zone decides what "today" is: 20:00 UTC is already tomorrow in India.
  assert.equal(
    clockText(Date.UTC(2026, 10, 14, 20, 0, 0), clock, "Asia/Kolkata"),
    "Nov 15, 1:30 AM",
  );
});

test("provider failures are retried", () => {
  assert.equal(what('API Error: 529 {"type":"overloaded_error"}', 529), "529 Overloaded");
  for (const status of [400, 408, 409, 425, 500, 502, 503, 504, 520, 529]) {
    assert.ok(what("API Error", status) !== null, String(status));
  }
  // Without a status field the text says it.
  assert.equal(what("API Error: 503 Service Unavailable"), "503 Service unavailable");
  assert.equal(what("Overloaded"), "Overloaded");
  assert.equal(what("API Error: Request timed out."), "Timeout");
  assert.equal(what("API Error: Unable to connect: ECONNRESET"), "Network error");
  assert.equal(what("API Error: 429 rate_limit_error", 429), "429 Rate limited");
  for (const [text, name] of [
    ["internal server error", "Server error"],
    ["Bad Gateway", "Bad gateway"],
    ["temporarily unavailable", "Service unavailable"],
    ["gateway timeout", "Gateway timeout"],
    ["ETIMEDOUT", "Timeout"],
    ["ECONNREFUSED", "Network error"],
    ["socket hang up", "Network error"],
    ["fetch failed", "Network error"],
    ["network error", "Network error"],
  ]) {
    assert.equal(what(text), name, text);
  }
});

test("a usage limit waits for its reset", () => {
  assert.deepEqual(classify(error("Claude AI usage limit reached|1794655200")), {
    what: "Usage limit",
    reset: 1794655200 * 1000,
  });
  assert.equal(classify(error("Overloaded"), { resetsAt: 1794655200 })?.reset, 1794655200 * 1000);
  assert.equal(classify(error("You've hit your limit"), { resetsAt: null })?.reset, null);
});

test("what waiting does not fix is not retried", () => {
  for (const [text, status] of /** @type {[string, number | null][]} */ ([
    ["Invalid API key · Please run /login", null],
    ["API Error: 401 authentication_error", 401],
    ["API Error: 403 Forbidden", 403],
    ["API Error: 404 model_not_found", 404],
    ["API Error: 402 Insufficient account funds", 402],
    ["Your credit balance is too low", 400],
    ["API Error: 429 GoUsageLimitError Go usage limit exceeded", 429],
    ["API Error: Upstream request failed: Policy budget exceeded", null],
    ["Something odd happened", null],
    ["API Error: 422 invalid", 422],
  ])) {
    assert.equal(what(text, status), null, text);
  }
});

/**
 * @param {{ max?: number, secondMs?: number }} [options]
 */
function planner({ max = 5, secondMs } = {}) {
  const state = { now: NOW, max };
  const clock = { now: () => state.now };
  return {
    state,
    planner: createRetryPlanner({
      maxRetries: () => state.max,
      clock,
      timeZone: "UTC",
      ...(secondMs === undefined ? {} : { secondMs }),
    }),
  };
}

const overloaded = { what: "529 Overloaded", reset: null };

test("the planner words each wait and counts the retries", () => {
  const { planner: p } = planner();
  const first = p.next(overloaded, "API Error: 529", 0);
  assert.deepEqual(first, {
    kind: "wait",
    retry: 1,
    max: 5,
    waitMs: 30_000,
    at: NOW + 30_000,
    logLine: "Model error (529 Overloaded). Retrying in 30 seconds (retry 1 of 5)",
    activity: "Model error. Retrying at 10:00 AM (retry 1 of 5)",
    resumeLine: "Retrying now (retry 1 of 5)",
    resumeActivity: "Retrying (retry 1 of 5)",
  });
  const second = p.next(overloaded, "API Error: 529", 0);
  assert.equal(second.kind === "wait" && second.logLine.includes("1 minute (retry 2 of 5)"), true);
  assert.equal(p.retries(), 2);
});

test("the planner gives up after the last retry with the used-up sentence", () => {
  const { planner: p } = planner({ max: 2 });
  assert.equal(p.next(overloaded, "Overloaded.", 0).kind, "wait");
  assert.equal(p.next(overloaded, "Overloaded.", 0).kind, "wait");
  assert.deepEqual(p.next(overloaded, "Overloaded.", 0), {
    kind: "fail",
    message: "Overloaded. VidAI retried 2 times without success.",
  });
});

test("with retries off the first failure fails with the plain message", () => {
  const { planner: p } = planner({ max: 0 });
  assert.deepEqual(p.next(overloaded, "Overloaded.", 0), { kind: "fail", message: "Overloaded." });
});

test("real progress starts the count over", () => {
  const { planner: p } = planner({ max: 2 });
  p.next(overloaded, "x", 3);
  p.next(overloaded, "x", 3);
  assert.equal(p.retries(), 2);
  // Work grew since the last failure: retry 1 again.
  const plan = p.next(overloaded, "x", 4);
  assert.equal(plan.kind === "wait" && plan.retry, 1);
});

test("a run that starts with work already shown does not count it as progress", () => {
  const state = { max: 1 };
  const p = createRetryPlanner({
    maxRetries: () => state.max,
    clock: { now: () => NOW },
    workShown: 5,
  });
  assert.equal(p.next(overloaded, "x", 5).kind, "wait");
  assert.equal(p.next(overloaded, "x", 5).kind, "fail");
});

test("the maximum is read at every failure and a reset later than the gap is waited for", () => {
  const { planner: p, state } = planner({ max: 1 });
  assert.equal(p.next({ what: "Usage limit", reset: NOW + 2 * HOUR }, "m", 0).kind, "wait");
  state.max = 3;
  const plan = p.next({ what: "Usage limit", reset: NOW + 2 * HOUR }, "m", 0);
  assert.equal(plan.kind === "wait" && plan.waitMs, 2 * HOUR);
  assert.equal(
    plan.kind === "wait" && plan.activity,
    "Model error. Retrying at 12:00 PM (retry 2 of 3)",
  );
  assert.equal(
    plan.kind === "wait" && plan.logLine,
    "Model error (Usage limit). Retrying in 2 hours (retry 2 of 3)",
  );
});

test("the schedule can be shortened for tests", () => {
  const { planner: p } = planner({ secondMs: 10 });
  const plan = p.next(overloaded, "m", 0);
  assert.equal(plan.kind === "wait" && plan.waitMs, 300);
});

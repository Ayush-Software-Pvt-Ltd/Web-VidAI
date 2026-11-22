// Port of the unit tests of src-tauri/src/jobs/errors.rs (job errors in words).

import assert from "node:assert/strict";
import test from "node:test";
import {
  apiErrorStatusIn,
  crashed,
  editingFolderMissing,
  epochSuffix,
  forApiResult,
  forErrorResult,
  loggedOut,
  looksLikeUsageLimit,
  looksLoggedOut,
  missingOutput,
  retriesUsedUp,
  spawnFailed,
  stalled,
  stuck,
  usageLimit,
  videoFolderMissing,
} from "../../src/jobs/errors.js";

/** @typedef {import("../../src/agents/claude/protocol.js").TurnResult} TurnResult */

const NOW = Date.UTC(2026, 10, 14, 10, 0, 0);
const clock = { now: () => NOW };

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
 * A stand-in for the service wording (the real one lives with the OpenCode code): it knows two
 * answers and says "unknown" for everything else.
 * @returns {import("../../src/jobs/errors.js").ServiceWording}
 */
function service() {
  return {
    unknownFailure: "The service reported an error.",
    failureText(status, text, model) {
      if (text.includes("Go usage limit")) return "The weekly limit of your plan is reached.";
      if (status === 401) return "The service did not accept the API key.";
      if (status === 403)
        return `The service does not allow ${model ?? "this model"} for this key.`;
      return "The service reported an error.";
    },
  };
}

test("usage limit wording", () => {
  const today = Date.UTC(2026, 10, 14, 16, 30, 0);
  assert.equal(usageLimit(today, clock, "UTC"), "Claude usage limit reached, resets at 4:30 PM");
  const later = Date.UTC(2026, 10, 19, 9, 5, 0);
  assert.equal(
    usageLimit(later, clock, "UTC"),
    "Claude usage limit reached, resets on Nov 19 at 9:05 AM",
  );
  assert.equal(
    usageLimit(null, clock, "UTC"),
    "Claude usage limit reached. Try again when the limit resets.",
  );
  // A reset in the past is not named.
  assert.equal(
    usageLimit(NOW - 1000, clock, "UTC"),
    "Claude usage limit reached. Try again when the limit resets.",
  );
});

test("usage limit wording follows the time zone", () => {
  // 16:30 UTC is 22:00 in India and already the next day there for 20:00 UTC.
  assert.equal(
    usageLimit(Date.UTC(2026, 10, 14, 16, 30, 0), clock, "Asia/Kolkata"),
    "Claude usage limit reached, resets at 10:00 PM",
  );
  assert.equal(
    usageLimit(Date.UTC(2026, 10, 14, 20, 0, 0), clock, "Asia/Kolkata"),
    "Claude usage limit reached, resets on Nov 15 at 1:30 AM",
  );
  // Noon and midnight use 12, not 0.
  assert.equal(
    usageLimit(Date.UTC(2026, 10, 14, 12, 0, 0), clock, "UTC"),
    "Claude usage limit reached, resets at 12:00 PM",
  );
  assert.equal(
    usageLimit(Date.UTC(2026, 10, 14, 23, 59, 0), clock, "UTC"),
    "Claude usage limit reached, resets at 11:59 PM",
  );
});

test("classifies error results", () => {
  assert.ok(
    forErrorResult(error("You've hit your limit · resets 4:30pm"), null, clock, "UTC").startsWith(
      "Claude usage limit reached",
    ),
  );
  const classic = forErrorResult(
    error("Claude AI usage limit reached|1794655200"),
    null,
    clock,
    "UTC",
  );
  assert.ok(classic.startsWith("Claude usage limit reached, resets"), classic);
  assert.ok(
    forErrorResult(error("Overloaded"), { resetsAt: 1794655200 }, clock, "UTC").startsWith(
      "Claude usage limit reached, resets",
    ),
  );
  assert.equal(
    forErrorResult(error("Invalid API key · Please run /login"), null, clock),
    loggedOut(),
  );
  assert.equal(
    forErrorResult(error("API Error: 500 Internal\nmore"), null, clock),
    "Claude Code reported an error: API Error: 500 Internal",
  );
  // A status of 429 or 401 alone decides, without any text pattern.
  assert.ok(
    forErrorResult(error("odd", 429), null, clock).startsWith("Claude usage limit reached"),
  );
  assert.equal(forErrorResult(error("odd", 401), null, clock), loggedOut());
});

test("a limit event without a reset time still reads as a usage limit", () => {
  assert.equal(
    forErrorResult(error("anything"), { resetsAt: null }, clock),
    "Claude usage limit reached. Try again when the limit resets.",
  );
});

test("api results say what the service answered", () => {
  const go = error('API Error: 429 {"error":{"message":"Go usage limit exceeded"}}');
  assert.equal(
    forApiResult(go, "glm-5.3", service(), "opencode2"),
    "The weekly limit of your plan is reached.",
  );
  assert.equal(
    forApiResult(error("Invalid API key · Please run /login"), null, service(), "claudeCode"),
    "The service did not accept the API key.",
  );
  assert.equal(
    forApiResult(error("API Error: 403 Forbidden", 403), "m1", service(), "claudeCode"),
    "The service does not allow m1 for this key.",
  );
  // What the service said nothing known about is the program's own report.
  assert.equal(
    forApiResult(error("Something odd\nmore"), null, service(), "claudeCode"),
    "Claude Code reported an error: Something odd",
  );
  assert.equal(
    forApiResult(error("Something odd\nmore"), null, service(), "opencode2"),
    "OpenCode 2 reported an error: Something odd",
  );
});

test("other messages", () => {
  assert.equal(
    crashed(2, null, "  Error: boom "),
    "Claude Code stopped unexpectedly (exit code 2): Error: boom",
  );
  assert.equal(crashed(null, 9, null), "Claude Code stopped unexpectedly (signal 9).");
  assert.equal(crashed(null, "SIGKILL", ""), "Claude Code stopped unexpectedly (signal SIGKILL).");
  assert.equal(crashed(null, null, "  "), "Claude Code stopped unexpectedly (unknown reason).");
  assert.equal(
    crashed(1, null, "boom", "opencode2"),
    "OpenCode 2 stopped unexpectedly (exit code 1): boom",
  );
  assert.equal(stalled(20), "Claude Code stopped responding (no activity for 20 minutes).");
  assert.equal(
    stalled(20, "opencode2"),
    "OpenCode 2 stopped responding (no activity for 20 minutes).",
  );
  assert.equal(spawnFailed("No such file"), "Claude Code could not be started: No such file");
  assert.equal(missingOutput("edit"), "Claude finished without creating the project.");
  assert.equal(missingOutput("reEdit"), "Claude finished without saving a new project version.");
  assert.equal(
    missingOutput("timelineEdit", "opencode2"),
    "OpenCode 2 finished without saving a new project version.",
  );
  assert.equal(missingOutput("render"), "Claude finished without creating a final render.");
  assert.equal(
    editingFolderMissing("/x/Edits"),
    "The Editing Folder is missing: /x/Edits. Reconnect the drive or choose the folder again in Settings.",
  );
  assert.equal(videoFolderMissing("/x/v"), "The video folder is missing: /x/v");
  assert.equal(
    stuck("edit", { kind: "idleTurns", count: 3 }),
    "The model stopped working on the edit: it ended 3 turns in a row without doing anything. Press Continue Editing to try again.",
  );
  assert.equal(
    stuck("reEdit", { kind: "noProgress", count: 8 }),
    "The model made no progress on the re-edit after being asked 8 times to keep going. Press Continue Editing to try again.",
  );
  assert.equal(
    stuck("render", { kind: "ceiling", count: 40 }),
    "The final render is still not finished after VidAI asked 40 times to keep going, the most it asks in one run. Press Continue Editing to go on.",
  );
  assert.equal(
    stuck("timelineEdit", { kind: "idleTurns", count: 3 }),
    "The model stopped working on the timeline edit: it ended 3 turns in a row without doing anything. Press Continue Editing to try again.",
  );
});

test("a stderr line is cut at 300 characters and scrubbed before it is cut", () => {
  const long = crashed(1, null, "x".repeat(500));
  assert.equal(long, `Claude Code stopped unexpectedly (exit code 1): ${"x".repeat(297)}...`);
  // A secret that straddles the cut must not leave a prefix behind.
  const secret = "sk-secret-0123456789";
  const line = `${"y".repeat(290)}${secret}`;
  const scrub = (/** @type {string} */ t) => t.replaceAll(secret, "[api key]");
  const message = crashed(1, null, line, "claudeCode", { scrub });
  assert.ok(!message.includes("sk-secret"), message);
  assert.ok(message.includes("[api key]"));
});

test("retries used up say how often", () => {
  assert.equal(
    retriesUsedUp("API Error: 529 Overloaded.", 5),
    "API Error: 529 Overloaded. VidAI retried 5 times without success.",
  );
  assert.equal(
    retriesUsedUp("Overloaded  \n", 1),
    "Overloaded. VidAI retried 1 time without success.",
  );
  assert.equal(retriesUsedUp("Boom...", 2), "Boom. VidAI retried 2 times without success.");
});

test("text patterns", () => {
  for (const text of [
    "Usage limit",
    "You hit your limit",
    "limit reached",
    "Rate limit",
    "limit will reset",
  ]) {
    assert.ok(looksLikeUsageLimit(text), text);
  }
  assert.ok(!looksLikeUsageLimit("Something odd"));
  for (const text of [
    "Please run /login",
    "Not logged in",
    "please log in",
    "Invalid API key",
    "OAuth token has expired",
    "authentication_error",
    "Authentication failed",
  ]) {
    assert.ok(looksLoggedOut(text), text);
  }
  assert.ok(!looksLoggedOut("Overloaded"));
});

test("the status and the reset are read from Claude Code's texts", () => {
  assert.equal(apiErrorStatusIn('API Error: 429 {"type":"error"}'), 429);
  assert.equal(apiErrorStatusIn("API Error: 529 overloaded"), 529);
  assert.equal(apiErrorStatusIn("API Error: 200 fine"), null);
  assert.equal(apiErrorStatusIn("API Error: 42"), null);
  assert.equal(apiErrorStatusIn("API Error: Unable to connect"), null);
  assert.equal(apiErrorStatusIn("no such text"), null);
  assert.equal(epochSuffix("Claude AI usage limit reached|1794655200"), 1794655200);
  assert.equal(epochSuffix("limit |  1794655200 \n"), 1794655200);
  assert.equal(epochSuffix("a|b|1794655200"), 1794655200);
  assert.equal(epochSuffix("limit reached|12345"), null);
  assert.equal(epochSuffix("limit reached|soon"), null);
  assert.equal(epochSuffix("no bar 1794655200"), null);
});

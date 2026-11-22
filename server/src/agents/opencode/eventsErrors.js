// The errors and error results of the OpenCode 2 translator (docs/SPEC.md section 5, "The
// OpenCode 2 program", Limits and errors). OpenCode 2's errors are worded like Claude Code's
// ("API Error: 401 {...}") so the readable texts of the job engine find the gateway's answer in
// them.

import { NO_CONVERSATION_FOUND } from "../claude/protocol.js";
import { at, strAt, turnResult } from "./eventsWire.js";

/** @typedef {import("../claude/protocol.js").TurnResult} TurnResult */
/** @typedef {import("../claude/protocol.js").RateLimitEvent} RateLimitEvent */

/**
 * Error types of a usage limit that waiting would not solve soon (`session-error` types of
 * OpenCode 2: a Go window, the free tier, a quota or budget).
 * @type {ReadonlySet<string>}
 */
export const LIMIT_TYPES = new Set([
  "provider.go-limit",
  "provider.free-limit",
  "provider.quota",
  "provider.budget-limit",
  "provider.model-budget-limit",
]);

/**
 * The error that ended a turn.
 * @typedef {object} TurnError
 * @property {string} name OpenCode's error type (`provider.auth`, ...), `unknown` when missing.
 * @property {string} message
 * @property {number | null} status The HTTP status, when the error has one.
 * @property {string | null} body The gateway's answer, when there is a non-blank one.
 */

/**
 * An error as OpenCode 2 sends it (`{"type","message","status","response":{"body"}}`).
 * @param {unknown} value
 * @returns {TurnError}
 */
export function turnError(value) {
  const status = at(value, "status");
  const body = strAt(value, "response", "body");
  return {
    name: strAt(value, "type") ?? "unknown",
    message: strAt(value, "message") ?? "",
    status:
      typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 65_535
        ? status
        : null,
    body: body !== null && body.trim() !== "" ? body : null,
  };
}

/**
 * The error as Claude Code words a refused request ("API Error: 401 {...}").
 * @param {TurnError} error
 * @returns {string}
 */
export function turnErrorText(error) {
  if (error.status !== null) {
    return `API Error: ${error.status} ${error.body !== null ? error.body.trim() : error.message}`;
  }
  return error.message === "" ? error.name : error.message;
}

/**
 * The error `result` of a turn.
 * @param {{ steps: number, cost: number, sessionId: string, error: TurnError }} turn
 * @returns {TurnResult}
 */
export function errorResult({ steps, cost, sessionId, error }) {
  return turnResult({
    subtype: "error_during_execution",
    isError: true,
    numTurns: steps,
    text: null,
    errors: [turnErrorText(error)],
    totalCostUsd: cost,
    sessionId,
    apiErrorStatus: error.status,
    terminalReason: "error",
  });
}

/**
 * The error `result` of a turn cut short by an interrupt VidAI asked for (`aborted` is what
 * `isInterrupted` of the Claude protocol looks for).
 * @param {{ steps: number, cost: number, sessionId: string, reason: string }} turn
 * @returns {TurnResult}
 */
export function interruptedResult({ steps, cost, sessionId, reason }) {
  return turnResult({
    subtype: "error_during_execution",
    isError: true,
    numTurns: steps,
    text: null,
    errors: [`Session interrupted: ${reason}`],
    totalCostUsd: cost,
    sessionId,
    apiErrorStatus: null,
    terminalReason: "aborted",
  });
}

/**
 * The `result` of a resume whose session OpenCode does not have, in Claude Code's words, so
 * `isResumeNotFound` of the Claude protocol recognizes it.
 * @param {string} sessionId
 * @returns {TurnResult}
 */
export function resumeNotFound(sessionId) {
  return turnResult({
    subtype: "error_during_execution",
    isError: true,
    numTurns: 0,
    text: null,
    errors: [`${NO_CONVERSATION_FOUND} with session ID: ${sessionId}`],
    totalCostUsd: null,
    sessionId,
    apiErrorStatus: null,
    terminalReason: "error",
  });
}

/**
 * The error a usage limit ends a job with, out of a `rateLimit` event Claude Code style (the
 * gateway's own limit message in `raw.message`). OpenCode itself would wait for the limit to
 * reset (possibly days), so the job ends instead, with the gateway's error in the shape the
 * readable texts read ("API Error: 429 {...}" with the limit's name).
 * @param {RateLimitEvent} info
 * @param {string} sessionId
 * @returns {TurnResult}
 */
export function limitResult(info, sessionId) {
  const message = strAt(info.raw, "message") ?? "Usage limit reached";
  const free = strAt(info.raw, "action", "reason") === "free_tier_limit";
  /** @type {Record<string, unknown>} */
  let body;
  if (free) {
    body = { type: "error", error: { type: "FreeUsageLimitError", message } };
  } else {
    const cut = message.indexOf(" usage limit");
    const name = cut < 0 ? "" : message.slice(0, cut).trim();
    body = {
      type: "error",
      error: { type: "GoUsageLimitError", message },
      metadata: { limitName: name !== "" && name.toLowerCase() !== "usage" ? name : null },
    };
  }
  return turnResult({
    subtype: "error_during_execution",
    isError: true,
    numTurns: 1,
    text: null,
    errors: [`API Error: 429 ${JSON.stringify(body)}`],
    totalCostUsd: null,
    sessionId,
    apiErrorStatus: 429,
    terminalReason: "error",
  });
}

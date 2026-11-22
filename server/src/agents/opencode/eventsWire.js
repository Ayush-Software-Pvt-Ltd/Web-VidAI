// Builders for the events the OpenCode 2 translator emits (docs/SPEC.md section 5, "The OpenCode 2
// program", the event table).
//
// Every event is made the way the job engine gets one from Claude Code: the line Claude Code
// would have printed (its stream-json shape) goes through `parseValue` of
// `agents/claude/protocol.js`. So the shapes (every field present, `null` when empty) can never
// drift from what the engine reads, and no look-alike object is built by hand here.

import { parseValue } from "../claude/protocol.js";

/** @typedef {import("../claude/protocol.js").StreamEvent} StreamEvent */
/** @typedef {import("../claude/protocol.js").TurnResult} TurnResult */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The value at `keys` below `value`, or `undefined` when any step is not an object or missing.
 * @param {unknown} value
 * @param {...string} keys
 * @returns {unknown}
 */
export function at(value, ...keys) {
  /** @type {unknown} */
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * The string at `keys` below `value`, or `null` when it is missing or not a string.
 * @param {unknown} value
 * @param {...string} keys
 * @returns {string | null}
 */
export function strAt(value, ...keys) {
  const found = at(value, ...keys);
  return typeof found === "string" ? found : null;
}

/**
 * @param {unknown} raw
 * @returns {StreamEvent}
 */
function parsed(raw) {
  const event = parseValue(raw);
  if (event === null) throw new TypeError("an event of the translator did not parse");
  return event;
}

/**
 * `system` `init`: the main session is busy.
 * @param {string} sessionId
 * @param {string} model
 * @returns {StreamEvent}
 */
export function initEvent(sessionId, model) {
  return parsed({ type: "system", subtype: "init", session_id: sessionId, model });
}

/**
 * An assistant message with one text block.
 * @param {string | null} parentToolUseId
 * @param {string} text
 * @returns {StreamEvent}
 */
export function assistantText(parentToolUseId, text) {
  return parsed({
    type: "assistant",
    parent_tool_use_id: parentToolUseId,
    message: { content: [{ type: "text", text }] },
  });
}

/**
 * A user message with one text block (a sub-agent's prompt).
 * @param {string | null} parentToolUseId
 * @param {string} text
 * @returns {StreamEvent}
 */
export function userText(parentToolUseId, text) {
  return parsed({
    type: "user",
    parent_tool_use_id: parentToolUseId,
    message: { content: [{ type: "text", text }] },
  });
}

/**
 * An assistant message with one `tool_use` block.
 * @param {string | null} parentToolUseId
 * @param {string} id
 * @param {string} name
 * @param {unknown} input
 * @returns {StreamEvent}
 */
export function toolUse(parentToolUseId, id, name, input) {
  return parsed({
    type: "assistant",
    parent_tool_use_id: parentToolUseId,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
}

/**
 * A user message with one `tool_result` block.
 * @param {string | null} parentToolUseId
 * @param {string} toolUseId
 * @param {string} text
 * @param {boolean} isError
 * @returns {StreamEvent}
 */
export function toolResult(parentToolUseId, toolUseId, text, isError) {
  return parsed({
    type: "user",
    parent_tool_use_id: parentToolUseId,
    message: {
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: text, is_error: isError }],
    },
  });
}

/**
 * A command or sub-agent that goes on in the background.
 * @param {{ taskId: string, description: string | null, taskType: string }} task
 * @returns {StreamEvent}
 */
export function taskStarted({ taskId, description, taskType }) {
  return parsed({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    description,
    task_type: taskType,
    is_backgrounded: true,
  });
}

/**
 * A running tool that reports something (activity, nothing to log).
 * @param {string} taskId
 * @returns {StreamEvent}
 */
export function taskProgress(taskId) {
  return parsed({ type: "system", subtype: "task_progress", task_id: taskId });
}

/**
 * @param {string} taskId
 * @param {string} status
 * @returns {StreamEvent}
 */
export function taskUpdated(taskId, status) {
  return parsed({ type: "system", subtype: "task_updated", task_id: taskId, patch: { status } });
}

/**
 * The report of a background command or sub-agent, queued for the main session.
 * @param {string} taskId
 * @param {string | null} status
 * @param {string} summary
 * @returns {StreamEvent}
 */
export function taskNotification(taskId, status, summary) {
  return parsed({
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    status,
    summary,
  });
}

/**
 * Any retry that is not a usage limit: activity, nothing else.
 * @returns {StreamEvent}
 */
export function apiRetry() {
  return parsed({ type: "system", subtype: "api_retry" });
}

/**
 * A `result` line.
 * @param {object} fields
 * @param {string} fields.subtype
 * @param {boolean} fields.isError
 * @param {number} fields.numTurns
 * @param {string | null} fields.text
 * @param {string[]} fields.errors
 * @param {number | null} fields.totalCostUsd
 * @param {string | null} fields.sessionId
 * @param {number | null} fields.apiErrorStatus
 * @param {string | null} fields.terminalReason
 * @returns {TurnResult}
 */
export function turnResult(fields) {
  const event = parsed({
    type: "result",
    subtype: fields.subtype,
    is_error: fields.isError,
    num_turns: fields.numTurns,
    result: fields.text,
    errors: fields.errors,
    total_cost_usd: fields.totalCostUsd,
    session_id: fields.sessionId,
    api_error_status: fields.apiErrorStatus,
    terminal_reason: fields.terminalReason,
  });
  if (event.type !== "result") throw new TypeError("a result did not parse as a result");
  return event;
}

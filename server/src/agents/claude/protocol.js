// The stream-json protocol of `claude -p --input-format stream-json --output-format stream-json`
// (docs/SPEC.md section 8, "Driving Claude Code", verified against Claude Code 2.1.319).
//
// - Build stdin lines: user messages (`userMessageLine`) and control requests (`interruptLine`,
//   `controlRequestLine` for `initialize`, `get_settings`, `get_usage`).
// - Parse stdout lines into the event model below (`parseLine`): `system` (`init`, `task_started`,
//   `task_progress`, `task_updated`, `task_notification`, `background_tasks_changed`, ...),
//   `assistant` (`text`, `thinking`, `tool_use`), `user` (tool results), `result`,
//   `rate_limit_event`, `control_response`.
//   Unknown types, subtypes and fields are ignored, never treated as errors: a line that is not
//   a JSON object yields `null`, an unknown `type` yields `{ type: "other" }`.
//
// Parsing is lenient on purpose (every field is optional on the wire), because Claude Code adds
// fields and subtypes between releases. Turning events into log lines lives in `jobs/`.
//
// The event model is the vocabulary the job engine speaks with every agent: the OpenCode 2
// translator produces exactly these shapes. Every field is always present (`null` when empty).

// ---------------------------------------------------------------------------------------------
// The event model
// ---------------------------------------------------------------------------------------------

/**
 * One parsed stdout line: a tagged union on `type`.
 * @typedef {SystemEvent | AssistantEvent | UserEvent | TurnResult | RateLimitEvent
 *   | ControlResponseEvent | OtherEvent} StreamEvent
 */

/**
 * `type: "system"`, tagged again on `subtype` (camelCase of the wire name).
 * @typedef {InitEvent | TaskStartedEvent | TaskProgressEvent | TaskUpdatedEvent
 *   | TaskNotificationEvent | BackgroundTasksChangedEvent | OtherSystemEvent} SystemEvent
 */

/**
 * Emitted when the process starts and again at the start of later turns.
 * @typedef {object} InitEvent
 * @property {"system"} type
 * @property {"init"} subtype
 * @property {string | null} sessionId
 * @property {string | null} model
 */

/**
 * @typedef {object} TaskStartedEvent
 * @property {"system"} type
 * @property {"taskStarted"} subtype
 * @property {string} taskId
 * @property {string | null} description
 * @property {string | null} taskType `local_bash`, `local_agent`, ...
 * @property {boolean} backgrounded
 */

/**
 * @typedef {object} TaskProgressEvent
 * @property {"system"} type
 * @property {"taskProgress"} subtype
 * @property {string} taskId
 * @property {string | null} description
 */

/**
 * @typedef {object} TaskUpdatedEvent
 * @property {"system"} type
 * @property {"taskUpdated"} subtype
 * @property {string} taskId
 * @property {string | null} status The `patch.status` of the update.
 */

/**
 * @typedef {object} TaskNotificationEvent
 * @property {"system"} type
 * @property {"taskNotification"} subtype
 * @property {string} taskId
 * @property {string | null} status
 * @property {string | null} summary
 */

/**
 * The full list of background tasks that are active right now.
 * @typedef {object} BackgroundTasksChangedEvent
 * @property {"system"} type
 * @property {"backgroundTasksChanged"} subtype
 * @property {BackgroundTask[]} tasks
 */

/**
 * @typedef {object} BackgroundTask
 * @property {string} taskId
 * @property {string | null} description
 * @property {string | null} taskType
 */

/**
 * Any other subtype (`hook_started`, `thinking_tokens`, `commands_changed`, ...).
 * @typedef {object} OtherSystemEvent
 * @property {"system"} type
 * @property {"other"} subtype
 * @property {string} rawSubtype The subtype as it came on the wire.
 */

/**
 * @typedef {object} AssistantEvent
 * @property {"assistant"} type
 * @property {string | null} parentToolUseId Set when the message belongs to a sub-agent (the
 *   `Agent` tool call it runs under).
 * @property {Block[]} content
 */

/**
 * Tool results, sub-agent prompts and notes such as "[Request interrupted by user]".
 * @typedef {object} UserEvent
 * @property {"user"} type
 * @property {string | null} parentToolUseId
 * @property {Block[]} content
 */

/**
 * A content block of an `assistant` or `user` message.
 * @typedef {TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | OtherBlock} Block
 */

/**
 * @typedef {object} TextBlock
 * @property {"text"} type
 * @property {string} text
 */

/**
 * Thinking is never logged; its content is dropped while parsing.
 * @typedef {object} ThinkingBlock
 * @property {"thinking"} type
 */

/**
 * @typedef {object} ToolUseBlock
 * @property {"toolUse"} type
 * @property {string} id
 * @property {string} name
 * @property {unknown} input The tool input as sent (`null` when missing).
 */

/**
 * @typedef {object} ToolResultBlock
 * @property {"toolResult"} type
 * @property {string} toolUseId
 * @property {string} text The text parts of the result joined by newlines (images and other
 *   parts dropped).
 * @property {boolean} isError
 */

/**
 * @typedef {object} OtherBlock
 * @property {"other"} type
 */

/**
 * A `result` line: the end of one turn (not of the job).
 * @typedef {object} TurnResult
 * @property {"result"} type
 * @property {string} subtype `success`, `error_during_execution`, `error_max_turns`, ...
 * @property {boolean} isError
 * @property {number} numTurns
 * @property {string | null} text The final text of the turn, when there is one.
 * @property {string[]} errors The `errors` list of error results (for example "No conversation
 *   found with ...").
 * @property {number | null} totalCostUsd Cumulative cost of the session so far, as Claude Code
 *   reports it.
 * @property {string | null} sessionId
 * @property {number | null} apiErrorStatus
 * @property {string | null} terminalReason For example `completed`, or `aborted_streaming` after
 *   an interrupt.
 */

/**
 * The `rate_limit_info` object of a `rate_limit_event` (passed on to the usage display).
 * @typedef {object} RateLimitEvent
 * @property {"rateLimit"} type
 * @property {string | null} status `allowed`, `allowed_warning`, `rejected`, ...
 * @property {number | null} resetsAt When the limit that applies resets, in epoch seconds.
 * @property {unknown} raw The whole `rate_limit_info` object (`null` when missing).
 */

/**
 * @typedef {object} ControlResponseEvent
 * @property {"controlResponse"} type
 * @property {string} requestId
 * @property {boolean} success
 * @property {string | null} error
 */

/**
 * A line with an unknown `type`.
 * @typedef {object} OtherEvent
 * @property {"other"} type
 * @property {string} kind The `type` as it came on the wire (empty when missing).
 */

/** The phrase Claude Code prints when `--resume` names a session it does not have. */
export const NO_CONVERSATION_FOUND = "No conversation found";

// ---------------------------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------------------------

/**
 * One user message as a stdin line (without the trailing newline).
 * @param {string} text
 * @returns {string}
 */
export function userMessageLine(text) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: "",
  });
}

/**
 * A control request such as `interrupt`, `initialize`, `get_settings` or `get_usage` (without
 * the trailing newline). Claude answers with a `control_response` carrying the same
 * `request_id`.
 * @param {string} requestId
 * @param {string} subtype
 * @returns {string}
 */
export function controlRequestLine(requestId, subtype) {
  return JSON.stringify({
    type: "control_request",
    request_id: requestId,
    request: { subtype },
  });
}

/**
 * Interrupts the current turn. Claude answers with a `control_response`.
 * @param {string} requestId
 * @returns {string}
 */
export function interruptLine(requestId) {
  return controlRequestLine(requestId, "interrupt");
}

// ---------------------------------------------------------------------------------------------
// stdout
// ---------------------------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The string at `key`, or `null` when missing or not a string.
 * @param {unknown} value
 * @param {string} key
 * @returns {string | null}
 */
function strOf(value, key) {
  if (!isRecord(value)) return null;
  const found = value[key];
  return typeof found === "string" ? found : null;
}

/**
 * A non-negative whole number (what serde's `as_u64` accepts), else `null`.
 * @param {unknown} value
 * @returns {number | null}
 */
function unsignedOf(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * A whole number (what serde's `as_i64` accepts), else `null`.
 * @param {unknown} value
 * @returns {number | null}
 */
function integerOf(value) {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * Parses one stdout line. Returns `null` for blank lines, lines that are not JSON and JSON that
 * is not an object.
 * @param {string} line
 * @returns {StreamEvent | null}
 */
export function parseLine(line) {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return parseValue(value);
}

/**
 * Parses one already decoded stdout object (see `parseLine`).
 * @param {unknown} value
 * @returns {StreamEvent | null}
 */
export function parseValue(value) {
  if (!isRecord(value)) return null;
  const kind = strOf(value, "type") ?? "";
  switch (kind) {
    case "system":
      return parseSystem(value);
    case "assistant":
      return { type: "assistant", ...parseMessage(value) };
    case "user":
      return { type: "user", ...parseMessage(value) };
    case "result":
      return parseResult(value);
    case "rate_limit_event": {
      const info = value["rate_limit_info"] ?? null;
      return {
        type: "rateLimit",
        status: strOf(info, "status"),
        resetsAt: isRecord(info) ? integerOf(info["resetsAt"]) : null,
        raw: info,
      };
    }
    case "control_response": {
      const response = value["response"] ?? null;
      return {
        type: "controlResponse",
        requestId: strOf(response, "request_id") ?? "",
        success: strOf(response, "subtype") === "success",
        error: strOf(response, "error"),
      };
    }
    default:
      return { type: "other", kind };
  }
}

/**
 * @param {Record<string, unknown>} v
 * @returns {SystemEvent}
 */
function parseSystem(v) {
  const subtype = strOf(v, "subtype") ?? "";
  const taskId = strOf(v, "task_id") ?? "";
  switch (subtype) {
    case "init":
      return {
        type: "system",
        subtype: "init",
        sessionId: strOf(v, "session_id"),
        model: strOf(v, "model"),
      };
    case "task_started":
      return {
        type: "system",
        subtype: "taskStarted",
        taskId,
        description: strOf(v, "description"),
        taskType: strOf(v, "task_type"),
        backgrounded: v["is_backgrounded"] === true,
      };
    case "task_progress":
      return {
        type: "system",
        subtype: "taskProgress",
        taskId,
        description: strOf(v, "description"),
      };
    case "task_updated":
      return {
        type: "system",
        subtype: "taskUpdated",
        taskId,
        status: strOf(v["patch"], "status"),
      };
    case "task_notification":
      return {
        type: "system",
        subtype: "taskNotification",
        taskId,
        status: strOf(v, "status"),
        summary: strOf(v, "summary"),
      };
    case "background_tasks_changed": {
      const raw = v["tasks"];
      /** @type {BackgroundTask[]} */
      const tasks = [];
      if (Array.isArray(raw)) {
        for (const task of raw) {
          const id = strOf(task, "task_id");
          if (id === null) continue;
          tasks.push({
            taskId: id,
            description: strOf(task, "description"),
            taskType: strOf(task, "task_type"),
          });
        }
      }
      return { type: "system", subtype: "backgroundTasksChanged", tasks };
    }
    default:
      return { type: "system", subtype: "other", rawSubtype: subtype };
  }
}

/**
 * @param {Record<string, unknown>} v
 * @returns {{ parentToolUseId: string | null, content: Block[] }}
 */
function parseMessage(v) {
  const message = v["message"];
  const raw = isRecord(message) ? message["content"] : undefined;
  /** @type {Block[]} */
  let content = [];
  if (typeof raw === "string") content = [{ type: "text", text: raw }];
  else if (Array.isArray(raw)) content = raw.map(parseBlock);
  return { parentToolUseId: strOf(v, "parent_tool_use_id"), content };
}

/**
 * @param {unknown} b
 * @returns {Block}
 */
function parseBlock(b) {
  switch (strOf(b, "type")) {
    case "text":
      return { type: "text", text: strOf(b, "text") ?? "" };
    case "thinking":
    case "redacted_thinking":
      return { type: "thinking" };
    case "tool_use":
      return {
        type: "toolUse",
        id: strOf(b, "id") ?? "",
        name: strOf(b, "name") ?? "",
        input: isRecord(b) ? (b["input"] ?? null) : null,
      };
    case "tool_result":
      return {
        type: "toolResult",
        toolUseId: strOf(b, "tool_use_id") ?? "",
        text: toolResultText(isRecord(b) ? b["content"] : undefined),
        isError: isRecord(b) && b["is_error"] === true,
      };
    default:
      return { type: "other" };
  }
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  /** @type {string[]} */
  const texts = [];
  for (const part of content) {
    if (strOf(part, "type") !== "text") continue;
    const text = strOf(part, "text");
    if (text !== null) texts.push(text);
  }
  return texts.join("\n");
}

/**
 * @param {Record<string, unknown>} v
 * @returns {TurnResult}
 */
function parseResult(v) {
  const errors = v["errors"];
  const cost = v["total_cost_usd"];
  return {
    type: "result",
    subtype: strOf(v, "subtype") ?? "",
    isError: v["is_error"] === true,
    numTurns: unsignedOf(v["num_turns"]) ?? 0,
    text: strOf(v, "result"),
    errors: Array.isArray(errors)
      ? errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
      : [],
    totalCostUsd: typeof cost === "number" ? cost : null,
    sessionId: strOf(v, "session_id"),
    apiErrorStatus: integerOf(v["api_error_status"]),
    terminalReason: strOf(v, "terminal_reason"),
  };
}

// ---------------------------------------------------------------------------------------------
// Questions about parsed events
// ---------------------------------------------------------------------------------------------

/**
 * Produced by a sub-agent rather than the main conversation.
 * @param {AssistantEvent | UserEvent} message
 * @returns {boolean}
 */
export function isNested(message) {
  return message.parentToolUseId !== null;
}

/**
 * The empty result Claude Code can emit right after `--resume` (or after a stale task
 * notification) before it handles the new message: no turns, no error. It never answers a
 * message.
 * @param {TurnResult} result
 * @returns {boolean}
 */
export function isEmptyResult(result) {
  return !result.isError && result.numTurns === 0;
}

/**
 * The error result that ends a turn cut short by an interrupt.
 * @param {TurnResult} result
 * @returns {boolean}
 */
export function isInterrupted(result) {
  return result.terminalReason !== null && result.terminalReason.startsWith("aborted");
}

/**
 * The error of a `--resume` whose session does not exist.
 * @param {TurnResult} result
 * @returns {boolean}
 */
export function isResumeNotFound(result) {
  if (!result.isError) return false;
  const texts = result.text === null ? result.errors : [...result.errors, result.text];
  return texts.some((e) => e.includes(NO_CONVERSATION_FOUND));
}

/**
 * Everything Claude said about the error, for classification and the log.
 * @param {TurnResult} result
 * @returns {string}
 */
export function errorText(result) {
  /** @type {string[]} */
  const parts = [];
  if (result.text !== null && result.text.trim() !== "") parts.push(result.text.trim());
  for (const error of result.errors) {
    const trimmed = error.trim();
    if (trimmed !== "") parts.push(trimmed);
  }
  return parts.length === 0 ? result.subtype : parts.join("\n");
}

/**
 * Claude Code refused to make more requests because a usage limit is reached.
 * @param {RateLimitEvent} info
 * @returns {boolean}
 */
export function isRateLimitRejected(info) {
  return info.status === "rejected";
}

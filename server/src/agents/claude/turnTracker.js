// The pure completion logic of docs/SPEC-desktop.md section 6 ("A `result` ends one turn, not the
// job"): Claude is finished only when every message sent has been answered, no turn is in
// progress, no background task is active, and nothing has happened for a settle time.
//
// Pure: it never reads a clock. Every method that needs the time gets `now` (milliseconds, any
// origin as long as it is the same one throughout) from the caller.

import { isEmptyResult, isNested } from "./protocol.js";

/** @typedef {import("./protocol.js").StreamEvent} StreamEvent */
/** @typedef {import("./protocol.js").TurnResult} TurnResult */

/**
 * What one observed line meant for the job.
 * - `nothing`: nothing that ends a turn.
 * - `turnEnded`: a `result` that answered a message (or ended a turn Claude started by itself).
 * - `emptyResult`: the empty `result` after `--resume` or a stale task notification; not an
 *   answer.
 * - `error`: a `result` reporting an error.
 * @typedef {{ kind: "nothing" }
 *   | { kind: "turnEnded", result: TurnResult }
 *   | { kind: "emptyResult" }
 *   | { kind: "error", result: TurnResult }} Observed
 */

/**
 * Where Claude stands, as far as the stream tells.
 * - `working`: a message is unanswered or a turn is in progress.
 * - `waitingForBackground`: the turn ended but background tasks still run; Claude will start a
 *   new turn by itself.
 * - `idle`: nothing is pending; finished once this has lasted for the settle time.
 * @typedef {{ kind: "working" }
 *   | { kind: "waitingForBackground", count: number }
 *   | { kind: "idle" }} Activity
 */

/** How long past its own time limit a tool call may stay silent before the job is stalled. */
export const TOOL_GRACE_MS = 120_000;

const TERMINAL_TASK_STATES = new Set(["completed", "failed", "killed", "stopped", "cancelled"]);

/** @param {string} a @param {string} b */
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export class TurnTracker {
  /** Messages sent and not yet answered by a counted result. */
  #unanswered = 0;
  /**
   * A top-level turn is in progress (assistant or user output, an init, or a task notification
   * that will start a new turn).
   */
  #inTurn = false;
  /** Active background tasks by id, with their description. @type {Map<string, string | null>} */
  #background = new Map();
  /** Every background task id seen in this process, active or not. @type {Set<string>} */
  #seenBackground = new Set();
  #lastLine;
  #answeredOnce = false;
  /**
   * Tool calls that were started with a time limit of their own and have no result yet, by tool
   * use id, in milliseconds: a command the model allowed an hour is silent for up to an hour.
   * @type {Map<string, number>}
   */
  #limitedTools = new Map();

  /** @param {number} now */
  constructor(now) {
    this.#lastLine = now;
  }

  /**
   * How long (ms) the process may stay silent before it counts as stalled: `baseMs`, or, while
   * a tool call runs that was given a longer time limit (the `timeout` of a `Bash` call, in
   * milliseconds), that limit and a short grace. The tool ends by its own limit, so a command
   * that is silent for half an hour (a transcription on a slow computer) is not a hang.
   * @param {number} baseMs
   * @returns {number}
   */
  stallLimit(baseMs) {
    let limit = baseMs;
    for (const ms of this.#limitedTools.values()) limit = Math.max(limit, ms + TOOL_GRACE_MS);
    return limit;
  }

  /**
   * A user message was written to stdin.
   * @param {number} now
   */
  messageSent(now) {
    this.#unanswered += 1;
    this.#lastLine = now;
  }

  /**
   * Feeds one stdout line.
   * @param {StreamEvent} event
   * @param {number} now
   * @returns {Observed}
   */
  observe(event, now) {
    this.#lastLine = now;
    switch (event.type) {
      case "assistant":
      case "user":
        if (!isNested(event)) this.#inTurn = true;
        for (const block of event.content) {
          if (block.type === "toolUse") {
            const input = block.input;
            const timeout =
              typeof input === "object" && input !== null
                ? /** @type {Record<string, unknown>} */ (input)["timeout"]
                : undefined;
            if (typeof timeout === "number" && Number.isInteger(timeout) && timeout >= 0) {
              this.#limitedTools.set(block.id, timeout);
            }
          } else if (block.type === "toolResult") {
            this.#limitedTools.delete(block.toolUseId);
          }
        }
        break;
      case "system":
        this.#observeSystem(event);
        break;
      case "result": {
        this.#inTurn = false;
        if (isEmptyResult(event)) return { kind: "emptyResult" };
        this.#unanswered = Math.max(0, this.#unanswered - 1);
        this.#answeredOnce = true;
        return event.isError
          ? { kind: "error", result: event }
          : { kind: "turnEnded", result: event };
      }
      default:
        break;
    }
    return { kind: "nothing" };
  }

  /** @param {import("./protocol.js").SystemEvent} event */
  #observeSystem(event) {
    switch (event.subtype) {
      case "init":
        this.#inTurn = true;
        break;
      case "taskStarted":
        if (event.backgrounded) {
          this.#seenBackground.add(event.taskId);
          this.#background.set(event.taskId, event.description);
        }
        break;
      case "taskUpdated":
        if (event.status !== null && TERMINAL_TASK_STATES.has(event.status)) {
          this.#background.delete(event.taskId);
        }
        break;
      case "taskNotification":
        // A finished background task makes Claude start a new turn by itself. (The task is
        // often already gone through `task_updated` at this point.)
        this.#background.delete(event.taskId);
        if (this.#seenBackground.has(event.taskId)) this.#inTurn = true;
        break;
      case "backgroundTasksChanged":
        for (const task of event.tasks) this.#seenBackground.add(task.taskId);
        this.#background = new Map(event.tasks.map((t) => [t.taskId, t.description]));
        break;
      default:
        break;
    }
  }

  /** @returns {Activity} */
  activity() {
    if (this.#unanswered > 0 || this.#inTurn) return { kind: "working" };
    if (this.#background.size > 0) {
      return { kind: "waitingForBackground", count: this.#background.size };
    }
    return { kind: "idle" };
  }

  /**
   * Descriptions of the active background tasks (the id when there is none), in id order.
   * @returns {string[]}
   */
  backgroundTasks() {
    return [...this.#background.keys()].sort(byId).map((id) => this.#background.get(id) ?? id);
  }

  /**
   * At least one counted result arrived since this process started.
   * @returns {boolean}
   */
  answeredOnce() {
    return this.#answeredOnce;
  }

  /**
   * Claude is finished: idle for at least `settleMs` since the last line.
   * @param {number} now
   * @param {number} settleMs
   * @returns {boolean}
   */
  isFinished(now, settleMs) {
    return this.activity().kind === "idle" && now - this.#lastLine >= settleMs;
  }

  /**
   * Time (ms) since the last line.
   * @param {number} now
   * @returns {number}
   */
  quietFor(now) {
    return now - this.#lastLine;
  }

  /**
   * When the finished check should run again (`null`: only a new line can change anything).
   * @param {number} settleMs
   * @returns {number | null}
   */
  settleDeadline(settleMs) {
    return this.activity().kind === "idle" ? this.#lastLine + settleMs : null;
  }
}

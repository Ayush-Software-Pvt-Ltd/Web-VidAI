// The event stream of an OpenCode 2 server (`GET /api/event`, server-sent events), translated
// into the vocabulary the job engine reads for Claude Code (`StreamEvent` of
// `agents/claude/protocol.js`). docs/SPEC.md section 5, "The OpenCode 2 program", has the table.
//
// What OpenCode 2 sends (recorded from 2.2.6, `test/support/fixtures/opencode2-stream/`): one JSON
// object per event, `{"id","created","type","location","data","durable"}`, for every session of
// the server. A message to a session is `session.inbox.enqueued` (item `user`), then the busy
// period: `session.execution.started`, `session.inbox.delivered` when the message joins it, per
// model step `session.step.started` ... `session.step.ended` (finish, tokens, cost) with text
// (`session.text.ended` carries the whole text), reasoning and tool calls
// (`session.tool.input.started` names the tool, `session.tool.called` carries its input,
// `session.tool.progress`, then `session.tool.success` or `session.tool.failed`), and exactly one
// terminal event: `session.execution.succeeded`, `.failed` (with the error) or `.interrupted`
// (with the reason). A message sent while a busy period runs joins it (one terminal for both).
//
// Background work: the `shell` tool moves a command that outlives its timeout (2 minutes by
// default) to the background, or starts it there (`background: true`); the `subagent` tool always
// runs its child session (`session.created` with `parentID`) in the background. Both answer at
// once with `metadata.status` `running`. When a command ends or a child goes idle, its report is
// queued for the session that started it (`session.inbox.enqueued`, item `synthetic` with
// `metadata.source` `shell` or `subagent`), which wakes that session for a new busy period.
//
// The translation (`Translator`):
//
// | OpenCode 2                                              | StreamEvent                          |
// | main session busy (`session.execution.started`)         | system `init`                        |
// | `session.text.ended`                                    | assistant text, nested in sub-agents |
// | a sub-agent's prompt (`inbox.enqueued`, `user`)         | nested user text                     |
// | `session.tool.called`                                   | assistant `tool_use`, Claude's names |
// | `session.tool.success` / `session.tool.failed`          | user `tool_result` (failed: error)   |
// | `session.tool.progress` of a running tool               | system `task_progress`               |
// | a command or sub-agent that runs on in the background   | also system `task_started`           |
// | its report queued for the main session                  | system `task_notification`           |
// | its report queued for a sub-agent's session             | system `task_updated` completed      |
// | main session's terminal event                           | one `result` per joined message      |
// | retry for a usage limit (`session.retry.scheduled`)     | an error `result` at once            |
// | any other retry                                         | system `api_retry` (subtype other)   |
// | `permission.asked`, `form.created`                      | no event; an `Action` answers it     |
//
// Reasoning, deltas, steps, usage, shells, instructions and catalog events are dropped; unknown
// events and fields are ignored, never errors. Costs are the sum of the steps' `cost`.
//
// The translator is pure: no I/O and no timers. Its owner (the server client of `server2`) sends
// the HTTP calls the returned `Action`s describe, and tells it what it did (`promptSent`,
// `promptRefused`, `abortRequested`, `reconcile`).

import { errorResult, interruptedResult, LIMIT_TYPES, turnError } from "./eventsErrors.js";
import { claudeTool, contentText, reportBody } from "./eventsTools.js";
import {
  apiRetry,
  assistantText,
  at,
  initEvent,
  strAt,
  taskNotification,
  taskProgress,
  taskStarted,
  taskUpdated,
  toolResult,
  toolUse,
  turnResult,
  userText,
} from "./eventsWire.js";

/** @typedef {import("../claude/protocol.js").StreamEvent} StreamEvent */
/** @typedef {import("./eventsErrors.js").TurnError} TurnError */

/**
 * What a question is answered with when the session's rules did not remove the question tool (a
 * plugin or the user's own agent can bring it back): the model goes on without an answer.
 */
export const QUESTION_CANCELLED =
  "VidAI runs this edit and nobody can answer questions, so the question was cancelled. Continue without an answer: make the best choice yourself and say which one you made.";

/**
 * Something the server must be told, found in the stream.
 * - `replyPermission`: `POST /api/session/<session>/permission/<id>/reply` with `once` (the
 *   session's rules allow everything, so a request that still comes, a plugin's, is allowed).
 * - `cancelForm`: `DELETE /api/session/<session>/form/<id>?message=<QUESTION_CANCELLED>` (nobody
 *   can fill in a form during an edit; `session` is `global` for a form of an MCP server of the
 *   Editing Folder).
 * - `interrupt`: `POST /api/session/<session>/interrupt` (a session of the job started working
 *   again after a pause or stop was asked for).
 * @typedef {{ type: "replyPermission", session: string, id: string }
 *   | { type: "cancelForm", session: string, id: string }
 *   | { type: "interrupt", session: string }} Action
 */

/**
 * What one OpenCode 2 event means.
 * @typedef {object} Translated
 * @property {StreamEvent[]} events
 * @property {Action[]} actions
 */

/**
 * One busy period of the main session.
 * @typedef {object} Execution
 * @property {number} steps
 * @property {string | null} lastText
 * @property {TurnError | null} error
 * @property {number} delivered VidAI's messages that joined this busy period.
 * @property {boolean} reported Its results were already reported (a usage limit ends the turn
 *   before OpenCode does).
 */

/**
 * @typedef {object} ToolCall
 * @property {string} name
 * @property {unknown} input
 * @property {boolean} started
 * @property {boolean} finished
 */

/**
 * @typedef {object} TranslatorOptions
 * @property {string} sessionId The job's session (the main session).
 * @property {string} model Names the model in the `init` events (`provider/model`).
 * @property {string | null} [directory] The Editing Folder, whose global forms (an MCP
 *   server's) belong to this job.
 */

/** @returns {Execution} */
function newExecution() {
  return { steps: 0, lastText: null, error: null, delivered: 0, reported: false };
}

/** Translates the events of one server for one main session (see the file comment). */
export class Translator {
  #main;
  #model;
  #directory;
  /**
   * Sub-agent sessions, with the `subagent` tool call that runs each (once known).
   * @type {Map<string, string | null>}
   */
  #children = new Map();
  /** @type {Map<string, ToolCall>} */
  #tools = new Map();
  /**
   * VidAI's messages that OpenCode queued and did not deliver yet.
   * @type {Set<string>}
   */
  #queued = new Set();
  /** VidAI's messages sent and not queued yet. */
  #unseen = 0;
  /** @type {Execution | null} */
  #execution = null;
  /** A pause or stop was asked for: every busy period of the job is interrupted from now on. */
  #halting = false;
  /**
   * Background commands and sub-agents by task id (shell id or child session id), with the
   * session that started them and how often the server's job list did not have them.
   * @type {Map<string, { session: string, missing: number }>}
   */
  #background = new Map();
  /** Cost of every step this server ran (main session and sub-agents), in dollars. */
  #cost = 0;

  /** @param {TranslatorOptions} options */
  constructor({ sessionId, model, directory = null }) {
    this.#main = sessionId;
    this.#model = model;
    this.#directory = directory;
  }

  /** The job's session. @returns {string} */
  get sessionId() {
    return this.#main;
  }

  /** A message is being sent to the main session. */
  promptSent() {
    this.#unseen += 1;
  }

  /**
   * The message just sent was refused: its turn ends at once with `message` as the error.
   * @param {string} message
   * @returns {StreamEvent[]}
   */
  promptRefused(message) {
    this.#unseen = Math.max(0, this.#unseen - 1);
    const error = { name: "UnknownError", message, status: null, body: null };
    return [this.#errorResult(0, error)];
  }

  /**
   * A pause or stop was asked for: the busy period that ends next ends as interrupted, and any
   * later one of the job's sessions is interrupted as soon as it starts.
   */
  abortRequested() {
    this.#halting = true;
  }

  /**
   * A turn is open (a message is unanswered or OpenCode is working).
   * @returns {boolean}
   */
  inTurn() {
    return this.#execution !== null || this.#unseen > 0 || this.#queued.size > 0;
  }

  /**
   * Nothing runs in the main session, but background work does.
   * @returns {boolean}
   */
  waitingForBackground() {
    return !this.inTurn() && this.#background.size > 0;
  }

  /**
   * The background work of the job, as the server's job list must show it while it runs.
   * @returns {string[]}
   */
  backgroundIds() {
    return [...this.#background.keys()].sort();
  }

  /**
   * Reconciles the background work with the server's list of running jobs (`running`, job ids).
   * A task that the list did not have twice in a row ended without a report reaching VidAI: it
   * is dropped (`task_updated` completed), so the job does not wait for it forever.
   * @param {readonly string[]} running
   * @returns {StreamEvent[]}
   */
  reconcile(running) {
    /** @type {string[]} */
    const gone = [];
    for (const [id, task] of this.#background) {
      if (running.includes(id)) {
        task.missing = 0;
      } else {
        task.missing += 1;
        if (task.missing >= 2) gone.push(id);
      }
    }
    gone.sort();
    /** @type {StreamEvent[]} */
    const events = [];
    for (const id of gone) {
      this.#background.delete(id);
      events.push(taskUpdated(id, "completed"));
    }
    return events;
  }

  /**
   * Translates one event's `data` text (a JSON object). Anything else translates to nothing.
   * @param {string} text
   * @returns {Translated}
   */
  translateText(text) {
    /** @type {unknown} */
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      return { events: [], actions: [] };
    }
    return this.translate(value);
  }

  /**
   * Translates one event (the decoded JSON object `{id, created, type, location, data}`).
   * @param {unknown} event
   * @returns {Translated}
   */
  translate(event) {
    /** @type {Translated} */
    const out = { events: [], actions: [] };
    const data = at(event, "data") ?? null;
    const kind = strAt(event, "type") ?? "";
    if (kind === "form.created") {
      this.#form(event, data, out);
      return out;
    }
    const session = strAt(data, "sessionID");
    if (session === null) return out;
    if (kind === "session.created") {
      const parent = strAt(data, "parentID");
      if (parent !== null && this.#inTree(parent) && !this.#children.has(session)) {
        this.#children.set(session, null);
      }
      return out;
    }
    const parent = this.#scope(session);
    if (parent === undefined) return out;
    const main = parent === null;
    switch (kind) {
      case "session.execution.started":
        if (this.#halting) out.actions.push({ type: "interrupt", session });
        if (main) {
          this.#execution = newExecution();
          out.events.push(initEvent(this.#main, this.#model));
        }
        break;
      case "session.execution.succeeded":
        if (main) this.#terminal(null, null, out);
        break;
      case "session.execution.failed":
        if (main) this.#terminal(turnError(at(data, "error")), null, out);
        break;
      case "session.execution.interrupted":
        if (main) this.#terminal(null, strAt(data, "reason") ?? "user", out);
        break;
      case "session.inbox.enqueued":
        this.#enqueued(session, parent, data, out);
        break;
      case "session.inbox.delivered": {
        const id = strAt(data, "inboxID");
        if (main && id !== null && this.#queued.delete(id)) {
          this.#execution ??= newExecution();
          this.#execution.delivered += 1;
        }
        break;
      }
      case "session.step.ended":
      case "session.step.failed": {
        const cost = at(data, "cost");
        if (typeof cost === "number") this.#cost += cost;
        if (main && kind === "session.step.ended" && this.#execution !== null) {
          this.#execution.steps += 1;
        }
        break;
      }
      case "session.text.ended": {
        const text = strAt(data, "text") ?? "";
        if (text.trim() !== "") {
          if (main && this.#execution !== null) this.#execution.lastText = text;
          out.events.push(assistantText(parent, text));
        }
        break;
      }
      case "session.tool.input.started": {
        const id = strAt(data, "id");
        if (id !== null) this.#tool(id).name = strAt(data, "name") ?? "";
        break;
      }
      case "session.tool.called": {
        const id = strAt(data, "id");
        if (id !== null) {
          this.#tool(id).input = at(data, "input") ?? null;
          this.#toolStarted(id, parent, out);
        }
        break;
      }
      case "session.tool.progress":
        this.#toolProgress(data, out);
        break;
      case "session.tool.success":
      case "session.tool.failed":
        this.#toolEnded(session, parent, data, kind === "session.tool.failed", out);
        break;
      case "session.retry.scheduled": {
        const error = at(data, "error");
        const type = strAt(error, "type");
        if (main && type !== null && LIMIT_TYPES.has(type)) {
          this.#limitReached(turnError(error), out);
        } else if (main) {
          out.events.push(apiRetry());
        }
        break;
      }
      case "permission.asked": {
        const id = strAt(data, "id");
        if (id !== null) out.actions.push({ type: "replyPermission", session, id });
        break;
      }
      default:
        break;
    }
    return out;
  }

  /**
   * @param {string} session
   * @returns {boolean}
   */
  #inTree(session) {
    return session === this.#main || this.#children.has(session);
  }

  /**
   * `undefined`: not this job's session; `null`: the main session; a string: a sub-agent session
   * run by that tool call (or named after itself until the call is known).
   * @param {string} session
   * @returns {string | null | undefined}
   */
  #scope(session) {
    if (session === this.#main) return null;
    if (!this.#children.has(session)) return undefined;
    return this.#children.get(session) ?? session;
  }

  /**
   * @param {string} id
   * @returns {ToolCall}
   */
  #tool(id) {
    let tool = this.#tools.get(id);
    if (tool === undefined) {
      tool = { name: "", input: null, started: false, finished: false };
      this.#tools.set(id, tool);
    }
    return tool;
  }

  /**
   * @param {unknown} event
   * @param {unknown} data
   * @param {Translated} out
   */
  #form(event, data, out) {
    const form = at(data, "form");
    const id = strAt(form, "id");
    const session = strAt(form, "sessionID");
    if (id === null || session === null) return;
    // An MCP server's form belongs to the folder it runs for; this server is the job's own. (A
    // translator without a folder and a form without one are equal, as in the Rust original.)
    const ours =
      session === "global"
        ? strAt(event, "location", "directory") === this.#directory
        : this.#inTree(session);
    if (ours) out.actions.push({ type: "cancelForm", session, id });
  }

  /**
   * @param {string} session
   * @param {string | null} parent
   * @param {unknown} data
   * @param {Translated} out
   */
  #enqueued(session, parent, data, out) {
    const item = at(data, "item");
    const payload = at(item, "payload");
    switch (strAt(item, "type")) {
      case "user": {
        if (parent === null) {
          // Only VidAI sends messages to the main session.
          const id = strAt(data, "inboxID");
          if (id !== null) {
            this.#queued.add(id);
            this.#unseen = Math.max(0, this.#unseen - 1);
          }
        } else {
          // A sub-agent's prompt is shown under its tool call.
          const text = strAt(payload, "text") ?? "";
          if (text.trim() !== "") out.events.push(userText(parent, text));
        }
        break;
      }
      case "synthetic": {
        const metadata = at(payload, "metadata");
        const source = strAt(metadata, "source");
        const task =
          source === "shell"
            ? (strAt(metadata, "shellID") ?? strAt(metadata, "jobID"))
            : source === "subagent"
              ? strAt(metadata, "childID")
              : null;
        if (task === null || !this.#background.delete(task)) return;
        if (session === this.#main) {
          out.events.push(
            taskNotification(
              task,
              strAt(metadata, "state"),
              reportBody(strAt(payload, "text") ?? ""),
            ),
          );
        } else {
          // A sub-agent's own background work: the sub-agent goes on, the main session waits for
          // the sub-agent.
          out.events.push(taskUpdated(task, "completed"));
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * @param {string} id
   * @param {string | null} parent
   * @param {Translated} out
   */
  #toolStarted(id, parent, out) {
    const tool = this.#tools.get(id);
    if (tool === undefined || tool.started) return;
    tool.started = true;
    const shaped = claudeTool(tool.name, tool.input);
    out.events.push(toolUse(parent, id, shaped.name, shaped.input));
  }

  /**
   * @param {unknown} data
   * @param {Translated} out
   */
  #toolProgress(data, out) {
    const id = strAt(data, "id");
    if (id === null) return;
    const tool = this.#tools.get(id);
    if (tool === undefined) return;
    if (tool.name === "subagent") {
      const child = strAt(data, "metadata", "sessionID");
      if (child !== null) this.#children.set(child, id);
    }
    if (tool.started && !tool.finished) {
      // A running tool that reports something: not silence, though nothing to log.
      out.events.push(taskProgress(id));
    }
  }

  /**
   * @param {string} session
   * @param {string | null} parent
   * @param {unknown} data
   * @param {boolean} failed
   * @param {Translated} out
   */
  #toolEnded(session, parent, data, failed, out) {
    const id = strAt(data, "id");
    if (id === null) return;
    this.#toolStarted(id, parent, out);
    const tool = this.#tools.get(id);
    if (tool === undefined || tool.finished) return;
    tool.finished = true;
    const content = contentText(at(data, "content"));
    let text = content;
    if (failed) {
      const message = strAt(data, "error", "message") ?? "The tool failed";
      text = content.trim() === "" ? message : `${content}\n\n${message}`;
    }
    out.events.push(toolResult(parent, id, text, failed));
    if (failed || strAt(data, "metadata", "status") !== "running") return;
    // It runs on in the background and reports when it ends.
    /** @type {string | null} */
    let task = null;
    /** @type {string | null} */
    let description = null;
    let taskType = "";
    if (tool.name === "shell") {
      task = strAt(data, "metadata", "shellID");
      description = strAt(tool.input, "command");
      taskType = "local_bash";
    } else if (tool.name === "subagent") {
      task = strAt(data, "metadata", "sessionID");
      description = strAt(tool.input, "description");
      taskType = "local_agent";
    }
    if (task === null) return;
    if (tool.name === "subagent") this.#children.set(task, id);
    this.#background.set(task, { session, missing: 0 });
    out.events.push(taskStarted({ taskId: task, description, taskType }));
  }

  /**
   * OpenCode 2 would retry (or the gateway would refuse until a window resets): the job ends
   * with the limit at once, in the gateway's words.
   * @param {TurnError} error
   * @param {Translated} out
   */
  #limitReached(error, out) {
    this.#execution ??= newExecution();
    const execution = this.#execution;
    if (execution.reported) return;
    execution.reported = true;
    execution.error ??= error;
    const count = this.#outstanding(execution.delivered);
    for (let i = 0; i < count; i += 1) {
      out.events.push(this.#errorResult(execution.steps, execution.error));
    }
  }

  /**
   * Messages a failed or interrupted busy period answers: those that joined it and those still
   * waiting (they will not run), at least one.
   * @param {number} delivered
   * @returns {number}
   */
  #outstanding(delivered) {
    const count = delivered + this.#unseen + this.#queued.size;
    this.#unseen = 0;
    this.#queued.clear();
    return Math.max(count, 1);
  }

  /**
   * The main session's busy period ended.
   * @param {TurnError | null} error
   * @param {string | null} interrupted The reason, when it ended as interrupted.
   * @param {Translated} out
   */
  #terminal(error, interrupted, out) {
    const execution = this.#execution ?? newExecution();
    this.#execution = null;
    if (execution.reported) return;
    const failure = error ?? execution.error;
    if (interrupted !== null) {
      const count = this.#outstanding(execution.delivered);
      for (let i = 0; i < count; i += 1) {
        out.events.push(
          this.#halting
            ? interruptedResult({
                steps: execution.steps,
                cost: this.#cost,
                sessionId: this.#main,
                reason: interrupted,
              })
            : // Nobody asked for it (OpenCode is shutting down): the turn did not finish.
              this.#errorResult(execution.steps, {
                name: "Interrupted",
                message: `OpenCode 2 stopped the turn (${interrupted}).`,
                status: null,
                body: null,
              }),
        );
      }
      return;
    }
    if (failure !== null) {
      const count = this.#outstanding(execution.delivered);
      for (let i = 0; i < count; i += 1) {
        out.events.push(this.#errorResult(execution.steps, failure));
      }
      return;
    }
    /** @param {number} numTurns */
    const success = (numTurns) =>
      turnResult({
        subtype: "success",
        isError: false,
        numTurns,
        text: execution.lastText,
        errors: [],
        totalCostUsd: this.#cost,
        sessionId: this.#main,
        apiErrorStatus: null,
        terminalReason: "completed",
      });
    if (execution.delivered > 0) {
      for (let i = 0; i < execution.delivered; i += 1) {
        out.events.push(success(Math.max(execution.steps, 1)));
      }
    } else if (this.#unseen > 0 || this.#queued.size > 0) {
      // A busy period that did not take VidAI's message (it runs in the next one): it ends a
      // turn but answers nothing.
      out.events.push(success(0));
    } else {
      // A busy period of its own, such as one woken by a background report.
      out.events.push(success(Math.max(execution.steps, 1)));
    }
  }

  /**
   * @param {number} steps
   * @param {TurnError} error
   * @returns {import("../claude/protocol.js").TurnResult}
   */
  #errorResult(steps, error) {
    return errorResult({ steps, cost: this.#cost, sessionId: this.#main, error });
  }
}

/**
 * A translator for one main session.
 * @param {TranslatorOptions} options
 * @returns {Translator}
 */
export function createTranslator(options) {
  return new Translator(options);
}

/**
 * The body of `POST /api/session` for a new session of a job.
 * @param {string} title
 * @param {unknown} model `{ providerID, id[, variant] }`.
 * @param {unknown} permissions The session's permission rules.
 * @param {string} directory The Editing Folder.
 * @returns {{ title: string, model: unknown, permissions: unknown, location: { directory: string } }}
 */
export function sessionBody(title, model, permissions, directory) {
  return { title, model, permissions, location: { directory } };
}

export { limitResult, resumeNotFound, turnError, turnErrorText } from "./eventsErrors.js";
export { claudeTool } from "./eventsTools.js";

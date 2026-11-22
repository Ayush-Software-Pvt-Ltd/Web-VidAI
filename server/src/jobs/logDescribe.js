// Turning the stream of an agent into job log entries (src-tauri/src/jobs/log.rs, `Describer`).
//
// Tool calls become one line ("Bash: Render graphics at 1080", using the tool's description when
// there is one) with the full input in `detail`, sub-agent output is marked `nested`, and
// thinking is never logged. Absolute paths in tool lines and tool results are shown relative to
// the video folder (`Paths`); `detail` keeps the original. Progress marker lines
// (`[VIDAI_PROGRESS transcribed]`) become compact status entries such as "Transcription done"
// instead of assistant text.
//
// The events are the vocabulary of `agents/claude/protocol.js`, the same for Claude Code and
// for OpenCode 2 (whose events are translated into it).

import {
  errorText,
  isInterrupted,
  isNested,
  isRateLimitRejected,
} from "../agents/claude/protocol.js";
import { programName } from "./errors.js";
import { noPaths } from "./logPaths.js";
import { LINE_CHARS, firstLine, truncateChars } from "./logText.js";

/** @typedef {import("../agents/claude/protocol.js").StreamEvent} StreamEvent */
/** @typedef {import("../agents/claude/protocol.js").AssistantEvent} AssistantEvent */
/** @typedef {import("../agents/claude/protocol.js").UserEvent} UserEvent */
/** @typedef {import("../agents/claude/protocol.js").SystemEvent} SystemEvent */
/** @typedef {import("../agents/harness.js").Harness} Harness */
/** @typedef {import("./logPaths.js").Paths} Paths */

/**
 * The kinds of a log entry, as the UI knows them (`LogKind` of `src/lib/bindings.ts`).
 * @typedef {"status" | "assistant" | "tool" | "toolResult" | "user" | "error"} LogKind
 */

/**
 * A log entry before it gets its `seq` and timestamp.
 * @typedef {object} Draft
 * @property {LogKind} kind
 * @property {string} text
 * @property {string | null} detail `null` when blank.
 * @property {boolean} nested
 */

/**
 * A draft of `kind`; `detail` is kept only when it is not blank.
 * @param {LogKind} kind
 * @param {string} text
 * @param {{ detail?: string | null, nested?: boolean }} [options]
 * @returns {Draft}
 */
export function draft(kind, text, { detail = null, nested = false } = {}) {
  return { kind, text, detail: detail !== null && detail.trim() !== "" ? detail : null, nested };
}

/**
 * @param {string} text
 * @param {{ detail?: string | null }} [options]
 * @returns {Draft}
 */
export const statusDraft = (text, options) => draft("status", text, options);

/**
 * @param {string} text
 * @param {{ detail?: string | null }} [options]
 * @returns {Draft}
 */
export const errorDraft = (text, options) => draft("error", text, options);

/**
 * What one stream event means for the log.
 * @typedef {object} Described
 * @property {Draft[]} entries
 * @property {string | null} activity A new "last activity" line, when the event says what the
 *   agent is doing now.
 */

/**
 * How progress marker lines are told apart from text (`splitMarkers` and `markerLogLine` of the
 * progress module).
 * @typedef {object} MarkerRules
 * @property {(text: string) => { text: string, markers: string[] }} split The text without its
 *   marker lines, and the names of the markers.
 * @property {(name: string) => string} logLine The status line of a marker ("Transcription done").
 */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * One line for a tool call: `<Tool>: <what it does>`, with paths shortened by `paths`.
 * @param {string} name
 * @param {unknown} input
 * @param {Paths} [paths]
 * @param {(text: string) => string} [scrub] Applied to every input text before it is cut.
 * @returns {string}
 */
export function toolLine(name, input, paths = noPaths(), scrub = (t) => t) {
  const object = asObject(input);
  /**
   * @param {string} key
   * @returns {string | null}
   */
  const get = (key) => {
    const value = object?.[key];
    if (typeof value !== "string") return null;
    const trimmed = scrub(value).trim();
    return trimmed === "" ? null : trimmed;
  };
  /** @param {string} text */
  const line = (text) => firstLine(paths.shorten(text));
  /** @param {string | null} text */
  const shortened = (text) => (text === null ? null : line(text));
  /** @param {string | null} text */
  const plain = (text) => (text === null ? null : firstLine(text));
  /** @returns {string | null} */
  const byName = () => {
    switch (name) {
      case "Bash":
        return shortened(get("command"));
      case "Read":
      case "Write":
      case "Edit":
      case "MultiEdit":
      case "NotebookEdit":
        return shortened(get("file_path") ?? get("notebook_path"));
      case "Glob":
      case "Grep":
        return shortened(get("pattern"));
      case "LS":
        return shortened(get("path"));
      case "WebFetch":
        return plain(get("url"));
      case "WebSearch":
        return plain(get("query"));
      case "TodoWrite":
        return "Update the task list";
      case "Skill":
        return plain(get("skill"));
      case "Agent":
      case "Task":
        return plain(get("subagent_type"));
      default:
        return null;
    }
  };
  const what = shortened(get("description")) ?? byName();
  const label = name === "" ? "Tool" : name;
  return what === null ? label : truncateChars(`${label}: ${what}`, LINE_CHARS);
}

/**
 * The full input of a tool call for `detail`: the command for Bash, pretty JSON otherwise.
 * @param {string} name
 * @param {unknown} input
 * @returns {string}
 */
export function toolDetail(name, input) {
  const command = asObject(input)?.command;
  if (name === "Bash" && typeof command === "string") return command;
  if (input === null || input === undefined) return "";
  return JSON.stringify(input, null, 2) ?? "";
}

/**
 * @typedef {object} Describer
 * @property {(event: StreamEvent) => Described} describe
 */

/**
 * Turns the stream of one agent process into log entries. Keeps a little state (whether the first
 * `init` was seen, what each task is) so repeated lines stay quiet.
 * @param {object} [options]
 * @param {Paths} [options.paths] Shortens paths inside the job's folders (default: as they are).
 * @param {Harness} [options.harness] The program whose stream this is (default Claude Code).
 * @param {(text: string) => string} [options.scrub] Replaces registered secrets; applied to every
 *   text of the stream before it is cut to a line, so no cut can leave half a secret behind.
 * @param {MarkerRules | null} [options.markers] Turns progress marker lines into status entries;
 *   without it every text stays assistant text.
 * @returns {Describer}
 */
export function createDescriber({
  paths = noPaths(),
  harness = "claudeCode",
  scrub = (t) => t,
  markers = null,
} = {}) {
  const program = programName(harness);
  let initSeen = false;
  /** Background tasks and sub-agents by task id. @type {Map<string, { desc: string, agent: boolean }>} */
  const tasks = new Map();

  /**
   * @param {AssistantEvent} message
   * @param {Described} out
   */
  function assistant(message, out) {
    const nested = isNested(message);
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim() !== "") {
        // Progress marker lines become compact status entries (sub-agents' are dropped: only the
        // main session's markers count).
        const raw = scrub(block.text);
        const split = markers === null ? { text: raw, markers: [] } : markers.split(raw);
        if (split.text !== "") {
          out.entries.push(draft("assistant", split.text.trim(), { nested }));
          if (!nested) out.activity = firstLine(split.text);
        }
        if (!nested && markers !== null) {
          for (const name of split.markers) {
            const line = markers.logLine(name);
            out.entries.push(statusDraft(line));
            out.activity = line;
          }
        }
      } else if (block.type === "toolUse") {
        const line = toolLine(block.name, block.input, paths, scrub);
        out.entries.push(
          draft("tool", line, { detail: toolDetail(block.name, block.input), nested }),
        );
        out.activity = line;
      }
    }
  }

  /**
   * @param {UserEvent} message
   * @param {Described} out
   */
  function user(message, out) {
    const nested = isNested(message);
    for (const block of message.content) {
      if (block.type === "toolResult") {
        const text = scrub(block.text);
        const shortened = paths.shorten(text);
        const first = firstLine(shortened);
        const line = block.isError
          ? first === ""
            ? "Error"
            : `Error: ${first}`
          : first === ""
            ? "(no output)"
            : first;
        // The full text goes to `detail` whenever the line does not show all of it.
        const trimmed = text.trim();
        const showsAll =
          trimmed.split(/\r?\n/).length <= 1 &&
          Array.from(trimmed).length <= LINE_CHARS &&
          shortened === text;
        out.entries.push(draft("toolResult", line, { detail: showsAll ? null : text, nested }));
      } else if (block.type === "text" && block.text.trim() !== "") {
        const text = scrub(block.text);
        const line = firstLine(text);
        out.entries.push(
          draft("user", line, { detail: text.trim() === line ? null : text, nested }),
        );
      }
    }
  }

  /**
   * @param {SystemEvent} event
   * @param {Described} out
   */
  function system(event, out) {
    switch (event.subtype) {
      case "init": {
        if (initSeen) return;
        initSeen = true;
        out.entries.push(
          statusDraft(
            event.model === null
              ? `${program} is running`
              : `${program} is running (model ${event.model})`,
          ),
        );
        return;
      }
      case "taskStarted": {
        const agent = event.taskType === "local_agent";
        if (!event.backgrounded && !agent) return;
        const desc = scrub(event.description ?? event.taskId);
        tasks.set(event.taskId, { desc, agent });
        const text = agent
          ? event.backgrounded
            ? `Sub-agent started in the background: ${desc}`
            : `Sub-agent started: ${desc}`
          : `Background task started: ${desc}`;
        out.entries.push(statusDraft(firstLine(text)));
        out.activity = firstLine(text);
        return;
      }
      case "taskProgress": {
        if (event.description !== null) out.activity = firstLine(scrub(event.description));
        return;
      }
      case "taskNotification": {
        const status = event.status ?? "finished";
        const summary = scrub(event.summary ?? "");
        const task = tasks.get(event.taskId);
        tasks.delete(event.taskId);
        let text;
        if (task !== undefined) {
          text = task.agent
            ? `Sub-agent ${status}: ${task.desc}`
            : `Background task ${status}: ${task.desc}`;
        } else if (summary === "") {
          // Foreground tasks are covered by their tool call already.
          return;
        } else {
          text = `Task ${status}: ${firstLine(summary)}`;
        }
        const multiline = summary.trim().split(/\r?\n/).length > 1;
        out.entries.push(statusDraft(firstLine(text), { detail: multiline ? summary : null }));
        return;
      }
      default:
        return;
    }
  }

  return {
    describe(event) {
      /** @type {Described} */
      const out = { entries: [], activity: null };
      switch (event.type) {
        case "assistant":
          assistant(event, out);
          break;
        case "user":
          user(event, out);
          break;
        case "system":
          system(event, out);
          break;
        case "result":
          if (event.isError && !isInterrupted(event)) {
            const text = scrub(errorText(event));
            out.entries.push(
              errorDraft(`${program} reported an error: ${firstLine(text)}`, { detail: text }),
            );
          }
          break;
        case "rateLimit":
          if (isRateLimitRejected(event)) {
            out.entries.push(
              errorDraft(
                harness === "claudeCode"
                  ? "Claude reports that a usage limit is reached."
                  : `${program} reports that a usage limit is reached.`,
              ),
            );
          }
          break;
        default:
          break;
      }
      return out;
    },
  };
}

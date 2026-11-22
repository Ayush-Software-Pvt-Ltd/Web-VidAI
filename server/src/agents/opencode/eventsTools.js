// OpenCode 2's tools as Claude Code names and shapes them (docs/SPEC.md section 5, "The OpenCode 2
// program", the event table), so the log lines and the progress evidence of the job engine read
// the same for both programs.

import { isRecord, strAt } from "./eventsWire.js";

/** OpenCode 1.x style names (and the ones 2.x kept) to Claude Code's. */
const CLAUDE_NAMES = new Map([
  ["bash", "Bash"],
  ["read", "Read"],
  ["write", "Write"],
  ["edit", "Edit"],
  ["multiedit", "MultiEdit"],
  ["apply_patch", "Patch"],
  ["patch", "Patch"],
  ["glob", "Glob"],
  ["grep", "Grep"],
  ["list", "LS"],
  ["webfetch", "WebFetch"],
  ["websearch", "WebSearch"],
  ["todowrite", "TodoWrite"],
  ["todoread", "TodoRead"],
  ["task", "Agent"],
  ["skill", "Skill"],
]);

/**
 * `camelCase` as `camel_case`: every ASCII capital becomes `_` plus its lowercase (none in front
 * of a first character), so `filePath` is `file_path` and `sessionID` is `session_i_d`.
 * @param {string} key
 * @returns {string}
 */
export function snakeCase(key) {
  let out = "";
  for (const c of key) {
    if (c >= "A" && c <= "Z") {
      if (out !== "") out += "_";
      out += c.toLowerCase();
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * The first step of `claudeTool`: a tool of OpenCode 1.x's names as Claude Code names it, with
 * the input keys in snake_case. An input that is not an object is kept as it is.
 * @param {string} tool
 * @param {unknown} input
 * @returns {{ name: string, fields: Map<string, unknown> | null, input: unknown }}
 */
function shapedTool(tool, input) {
  const name = CLAUDE_NAMES.get(tool) ?? tool;
  if (!isRecord(input)) return { name, fields: null, input };
  /** @type {Map<string, unknown>} */
  const fields = new Map();
  for (const [key, value] of Object.entries(input)) fields.set(snakeCase(key), value);
  if (name === "Skill" && fields.has("name")) {
    const skill = fields.get("name");
    fields.delete("name");
    fields.set("skill", skill);
  }
  return { name, fields, input };
}

/**
 * @param {Map<string, unknown>} fields
 * @param {string} from
 * @param {string} to
 */
function rename(fields, from, to) {
  if (!fields.has(from)) return;
  const value = fields.get(from);
  fields.delete(from);
  fields.set(to, value);
}

/**
 * OpenCode 2's tool name and input as Claude Code names and shapes them: `shell` is `Bash` with
 * `run_in_background`, `read`, `write` and `edit` are `Read`, `Write` and `Edit` with
 * `file_path`, `subagent` is `Agent` with `subagent_type`, and so on. Input keys become
 * snake_case. Tools Claude Code does not have keep their name.
 * @param {string} tool
 * @param {unknown} input
 * @returns {{ name: string, input: unknown }}
 */
export function claudeTool(tool, input) {
  const first =
    tool === "shell"
      ? shapedTool("bash", input)
      : tool === "subagent"
        ? shapedTool("task", input)
        : tool === "patch"
          ? shapedTool("apply_patch", input)
          : shapedTool(tool, input);
  const { name, fields } = first;
  if (fields === null) return { name, input: first.input };
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      rename(fields, "path", "file_path");
      break;
    case "Bash":
      rename(fields, "background", "run_in_background");
      break;
    case "Agent":
      rename(fields, "agent", "subagent_type");
      rename(fields, "session_i_d", "session_id");
      break;
    case "Skill":
      rename(fields, "id", "skill");
      break;
    default:
      break;
  }
  // `fromEntries` defines own properties, so a key such as `__proto__` stays a plain key.
  return { name, input: Object.fromEntries(fields) };
}

/**
 * The text of a tool's `content` (texts, and files by their address), parts separated by a blank
 * line.
 * @param {unknown} content
 * @returns {string}
 */
export function contentText(content) {
  if (!Array.isArray(content)) return "";
  /** @type {string[]} */
  const parts = [];
  for (const item of content) {
    const kind = strAt(item, "type");
    const text =
      kind === "text" ? strAt(item, "text") : kind === "file" ? strAt(item, "uri") : null;
    if (text !== null) parts.push(text);
  }
  return parts.join("\n\n");
}

/**
 * The body of a report (`<shell ...>\n<output>\n</shell>`, `<subagent ...>\n<text>\n</subagent>`):
 * between the opening tag's line and the last closing tag, trimmed. A text that is not shaped so
 * is returned trimmed as it is.
 * @param {string} text
 * @returns {string}
 */
export function reportBody(text) {
  const firstBreak = text.indexOf("\n");
  if (firstBreak < 0) return text.trim();
  const rest = text.slice(firstBreak + 1);
  const close = rest.lastIndexOf("\n</");
  return (close < 0 ? text : rest.slice(0, close)).trim();
}

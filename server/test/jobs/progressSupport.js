// Helpers of the progress tests: stream events as Claude Code writes them (parsed with the real
// protocol parser), engines with default pacing, and an in-memory history.

import { parseValue } from "../../src/agents/claude/protocol.js";
import { createProgress } from "../../src/jobs/progressEngine.js";
import { defaultPacing } from "../../src/jobs/progressPacing.js";

/** One minute in milliseconds. */
export const MIN = 60_000;

/**
 * @param {unknown} value
 * @returns {import("../../src/agents/claude/protocol.js").StreamEvent}
 */
export function event(value) {
  const parsed = parseValue(value);
  if (parsed === null) throw new Error("not an event");
  return parsed;
}

/** @param {string} t */
export const text = (t) =>
  event({ type: "assistant", message: { content: [{ type: "text", text: t }] } });

/** @param {string} t */
export const nestedText = (t) =>
  event({
    type: "assistant",
    parent_tool_use_id: "agent1",
    message: { content: [{ type: "text", text: t }] },
  });

/**
 * @param {string} name
 * @param {unknown} input
 * @param {string} [id]
 */
export const tool = (name, input, id = `tu-${name}`) =>
  event({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });

/**
 * @param {string} name
 * @param {unknown} input
 */
export const nestedTool = (name, input) =>
  event({
    type: "assistant",
    parent_tool_use_id: "agent1",
    message: { content: [{ type: "tool_use", id: "nested", name, input }] },
  });

/**
 * @param {string} id
 * @param {string} description
 * @param {string} taskType
 */
export const taskStarted = (id, description, taskType) =>
  event({
    type: "system",
    subtype: "task_started",
    task_id: id,
    description,
    task_type: taskType,
    is_backgrounded: true,
  });

/**
 * @param {string} id
 * @param {string} status
 */
export const taskDone = (id, status) =>
  event({
    type: "system",
    subtype: "task_notification",
    task_id: id,
    status,
    summary: "done",
  });

/** @param {string} id */
export const toolResult = (id) =>
  event({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  });

/**
 * @param {Partial<import("../../src/jobs/progressEngine.js").OutputEvidence>} [parts]
 * @returns {import("../../src/jobs/progressEngine.js").OutputEvidence}
 */
export const evidence = (parts = {}) => ({
  project: false,
  thumbnails: false,
  meta: false,
  ...parts,
});

/**
 * @param {Partial<import("../../src/jobs/workFiles.js").Kinds>} parts
 * @returns {import("../../src/jobs/workFiles.js").Kinds}
 */
export const kinds = (parts) => ({
  audio: false,
  transcript: false,
  plan: false,
  graphics: false,
  qualityCheck: false,
  ...parts,
});

/**
 * @param {import("../../src/jobs/progressModels.js").AgentKind} [kind]
 * @param {import("../../src/jobs/progressModels.js").VideoType} [videoType]
 */
export function engine(kind = "edit", videoType = "short") {
  return createProgress({ kind, pacing: defaultPacing(kind, videoType) });
}

/**
 * @param {ReturnType<typeof engine>} p
 * @param {number} at
 */
export const percent = (p, at) => p.current(at).percent;

/**
 * @param {ReturnType<typeof engine>} p
 * @param {number} at
 */
export const stage = (p, at) => p.current(at).stage;

/**
 * @param {number} percent
 * @param {string} stage
 * @returns {{ percent: number, stage: string, secondsLeft: number | null }}
 */
export const view = (percent, stage) => ({ percent, stage, secondsLeft: null });

/**
 * The view without the time left, for the tests that pin percent and stage.
 * @param {ReturnType<typeof engine>} p
 * @param {number} at
 */
export function shown(p, at) {
  const { percent: pc, stage: st } = p.current(at);
  return { percent: pc, stage: st };
}

/**
 * A history in memory, newest rows kept like the table does not (tests trim on their own).
 * @param {import("../../src/jobs/progressPacing.js").HistoryRow[]} [rows]
 * @returns {import("../../src/jobs/progressPacing.js").ProgressHistory & { rows: import("../../src/jobs/progressPacing.js").HistoryRow[] }}
 */
export function memoryHistory(rows = []) {
  return {
    rows,
    recent(kind, videoType, limit) {
      return rows
        .filter((r) => r.kind === kind && r.videoType === videoType)
        .sort((a, b) => b.finishedAt - a.finishedAt)
        .slice(0, limit);
    },
    add(row) {
      rows.push(row);
    },
  };
}

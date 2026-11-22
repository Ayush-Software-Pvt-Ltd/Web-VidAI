// The progress engine of one agent job (docs/SPEC.md section 8 "Progress", carried over from
// docs/SPEC-desktop.md section 6 and src-tauri/src/jobs/progress.rs).
//
// A job of each kind has a model (`progressModels.js`): a weighted checklist of milestones. The
// percent is the sum of the weights of the finished milestones plus an estimate from active time
// (`progressEstimate.js`), at most 99 until the job is `completed` (then the manager shows
// `completedProgress()`). Milestones may finish in any order (the step after the plan runs in
// parallel), and a finished milestone implies the ones that must come before it.
//
// Evidence, most reliable first:
// 1. Markers in the main session's text (`progressMarkers.js`).
// 2. Files of the project in `output/` (`observeOutput`, fed by `progressEvidence.js`).
// 3. Kinds of files in the working folder of the video (`observeWork`, from `work.js`).
// 4. The stream (`observe`): keywords in tool calls, background tasks and sub-agents.
// 5. Time (`current`).
//
// The engine is pure and clock-free: every call takes the job's active milliseconds, so it is
// tested without waiting. `progressTracker.js` wraps it with the clock and the probes.

import { isNested } from "../agents/claude/protocol.js";
import { kindsOfPath } from "./work.js";
import { estimate } from "./progressEstimate.js";
import { MAX_RUNNING_PERCENT, MILESTONE_NAMES, milestoneOf, modelOf } from "./progressModels.js";
import { splitMarkers } from "./progressMarkers.js";
import {
  TRANSCRIBING_COMMAND_WORDS,
  classify,
  containsAny,
  flag,
  inputStr,
  isSetup,
} from "./progressStream.js";

/** @typedef {import("../agents/claude/protocol.js").StreamEvent} StreamEvent */
/** @typedef {import("./progressModels.js").MilestoneName} MilestoneName */
/** @typedef {import("./progressEstimate.js").Mark} Mark */
/** @typedef {import("./progressStream.js").Group} Group */
/** @typedef {import("../../../src/lib/wire/progress.ts").JobProgress} JobProgress */

/** Setup spans kept for the estimate; older ones no longer matter. */
const MAX_SETUP_SPANS = 256;

/**
 * What to persist per video (`videos.progress_memory`) so a continued job goes on from here.
 * @typedef {object} ProgressMemory
 * @property {string} jobId
 * @property {Record<string, Mark>} done Finished milestones by name.
 * @property {number} percent
 */

/**
 * What the engine needs from the files of the project folder, as `progressEvidence.js` derives it.
 * @typedef {object} OutputEvidence
 * @property {boolean} project The project is saved (`index.html` of the `.hf` folder).
 * @property {boolean} thumbnails A thumbnail written since the job started.
 * @property {boolean} meta `meta.txt` written since the job started.
 */

/**
 * @typedef {object} Task
 * @property {Group} group
 * @property {boolean} done
 * @property {boolean} afterPlan Started after the edit plan was finished.
 * @property {boolean} endsWithResult A foreground sub-agent, finished when its tool result
 *   arrives. (A background one answers at once that it was launched; its `taskNotification` tells
 *   when it is finished.)
 * @property {boolean} agent A sub-agent, not a shell command. A command that starts the
 *   transcription in the background ends when it has started it, not when the transcript is
 *   written.
 */

/**
 * A lenient reading of a stored memory: milestones the kind's model does not know are dropped by
 * `createProgress`; anything malformed becomes `null`.
 * @param {unknown} value
 * @returns {ProgressMemory | null}
 */
export function parseMemory(value) {
  if (typeof value !== "object" || value === null) return null;
  const raw = /** @type {Record<string, unknown>} */ (value);
  if (typeof raw.jobId !== "string") return null;
  /** @type {Record<string, Mark>} */
  const done = {};
  const stored = raw.done;
  if (typeof stored === "object" && stored !== null) {
    for (const [name, mark] of Object.entries(stored)) {
      const m = /** @type {Record<string, unknown> | null} */ (mark);
      if (m === null || typeof m !== "object") continue;
      const atMs = typeof m.atMs === "number" && Number.isFinite(m.atMs) ? Math.max(m.atMs, 0) : 0;
      done[name] = { atMs, implied: m.implied === true };
    }
  }
  const percent = typeof raw.percent === "number" && Number.isFinite(raw.percent) ? raw.percent : 0;
  return { jobId: raw.jobId, done, percent: Math.min(Math.max(Math.round(percent), 0), 100) };
}

/**
 * The progress of one agent job. Pure: every call takes the job's active milliseconds.
 * @param {object} options
 * @param {import("./progressModels.js").AgentKind} options.kind
 * @param {import("./progressPacing.js").Pacing} options.pacing
 * @param {ProgressMemory | null} [options.memory] Goes on from a persisted memory (a continued
 *   job, also after a restart); the caller passes only the memory of this very job.
 * @param {number | null} [options.shown] The percent last shown, which stays the floor.
 */
export function createProgress({ kind, pacing, memory = null, shown = null }) {
  const model = modelOf(kind);
  /** Finished milestones. @type {Map<string, Mark>} */
  const done = new Map();
  /** The highest percent reported so far (progress never goes backwards). */
  let high = 0;
  /** Background tasks and sub-agents by task id (or tool use id for foreground sub-agents). @type {Map<string, Task>} */
  const tasks = new Map();
  /** Setup commands and tasks running now, by tool use or task id, with their start. @type {Map<string, number>} */
  const setupOpen = new Map();
  /** Setup commands and tasks that ended, as [start, end] in active milliseconds. @type {[number, number][]} */
  const setupSpans = [];
  /** Setup work was seen at least once. */
  let setupSeen = false;

  const has = (/** @type {string} */ name) => model.steps.some((s) => s.milestone === name);

  if (memory !== null) {
    for (const name of MILESTONE_NAMES) {
      const mark = memory.done[name];
      if (mark !== undefined && has(name))
        done.set(name, { atMs: mark.atMs, implied: mark.implied });
    }
    high = memory.percent;
  }
  high = Math.min(Math.max(high, shown ?? 0), MAX_RUNNING_PERCENT);

  /**
   * @param {string} name
   * @param {number} atMs
   * @param {boolean} implied
   * @returns {boolean}
   */
  function markInner(name, atMs, implied) {
    let changed = false;
    if (has(name) && !done.has(name)) {
      done.set(name, { atMs, implied });
      changed = true;
    }
    for (const before of milestoneOf(name)?.implies ?? []) {
      changed = markInner(before, atMs, true) || changed;
    }
    return changed;
  }

  /**
   * Marks a milestone finished at `atMs` (and what it implies). Milestones the model does not have
   * are ignored. Returns whether anything changed.
   * @param {MilestoneName} name
   * @param {number} atMs
   * @returns {boolean}
   */
  const mark = (name, atMs) => markInner(name, atMs, false);

  /**
   * Marks a milestone finished because the evidence of a later one needs it (the quality-check
   * output needs the graphics and the b-roll): like an implied milestone it is not seen, so it
   * never goes into the history.
   * @param {MilestoneName} name
   * @param {number} atMs
   */
  const markImplied = (name, atMs) => markInner(name, atMs, true);

  const isDone = (/** @type {string} */ name) => done.has(name);

  /**
   * What a file the main session or a sub-agent writes says by its name (`work.js`). The plan and
   * the graphics only count once the footage was looked at (a transcript or the start of
   * transcription): a plan file written before any transcript is not planning from one. `main`
   * is false inside a sub-agent, whose plan-like files are its own notes.
   * @param {Partial<import("./workFiles.js").Kinds>} kinds
   * @param {boolean} main
   * @param {number} atMs
   */
  function observeKinds(kinds, main, atMs) {
    if (model.kind !== "edit") return;
    if (kinds.audio === true) mark("inspected", atMs);
    if (kinds.transcript === true) mark("transcribed", atMs);
    if (((kinds.plan === true && main) || kinds.graphics === true) && isDone("inspected")) {
      // A plan (or graphics built from one) means the transcript is there.
      mark("planned", atMs);
    }
    if (kinds.qualityCheck === true) {
      // The quality check looks at the assembled picture with its graphics and b-roll.
      markImplied("graphics_built", atMs);
      markImplied("broll_ready", atMs);
      mark("assembled", atMs);
    }
  }

  /**
   * What starting a sub-agent or task of a group says on its own.
   * @param {Group} group
   * @param {number} atMs
   */
  function agentSignal(group, atMs) {
    if (model.kind !== "edit") return;
    // The graphics fan-out starts from the finished plan.
    if (group === "graphics") mark("planned", atMs);
    else if (group === "transcription") mark("inspected", atMs);
  }

  /**
   * @param {string} taskId
   * @param {string} description Lower case.
   * @param {boolean} endsWithResult
   * @param {boolean} agent
   * @param {number} atMs
   */
  function taskStarted(taskId, description, endsWithResult, agent, atMs) {
    const group = classify(description);
    if (group === "setup") {
      setupSeen = true;
      if (!setupOpen.has(taskId)) setupOpen.set(taskId, atMs);
    }
    agentSignal(group, atMs);
    if (!tasks.has(taskId)) {
      tasks.set(taskId, {
        group,
        done: false,
        afterPlan: isDone("planned"),
        endsWithResult,
        agent,
      });
    }
  }

  /**
   * A setup command or task ended (or a tool result came back for it).
   * @param {string} id
   * @param {number} atMs
   */
  function setupEnded(id, atMs) {
    const start = setupOpen.get(id);
    if (start === undefined) return;
    setupOpen.delete(id);
    setupSpans.push([start, Math.max(atMs, start)]);
    if (setupSpans.length > MAX_SETUP_SPANS) setupSpans.shift();
  }

  /**
   * The active milliseconds from `from` to `to` that went into setup.
   * @param {number} from
   * @param {number} to
   * @returns {number}
   */
  function setupMs(from, to) {
    const overlap = (/** @type {number} */ start, /** @type {number} */ end) =>
      Math.max(Math.min(end, to) - Math.max(start, from), 0);
    let total = 0;
    for (const [start, end] of setupSpans) total += overlap(start, end);
    for (const start of setupOpen.values()) total += overlap(start, to);
    return total;
  }

  /**
   * @param {string} taskId
   * @param {number} atMs
   */
  function taskFinished(taskId, atMs) {
    const task = tasks.get(taskId);
    if (task === undefined || task.done) return;
    task.done = true;
    const { group, agent } = task;
    /** Every task of the group (that counts) is finished. */
    const allDone = (/** @type {(t: Task) => boolean} */ counts) => {
      const counted = [...tasks.values()].filter((t) => t.group === group && counts(t));
      return counted.length > 0 && counted.every((t) => t.done);
    };
    if (model.kind !== "edit") return;
    if (group === "transcription" && agent && allDone((t) => t.agent)) {
      mark("transcribed", atMs);
    } else if (group === "graphics" && allDone((t) => t.afterPlan)) {
      mark("graphics_built", atMs);
    } else if (group === "broll" && allDone((t) => t.afterPlan)) {
      // Product and b-roll helpers started early (during transcription) are only a part.
      mark("broll_ready", atMs);
    } else if (group === "extras" && allDone(() => true)) {
      mark("extras_written", atMs);
    }
  }

  /**
   * @param {string} id
   * @param {string} name
   * @param {unknown} input
   * @param {boolean} nested
   * @param {number} atMs
   */
  function toolUse(id, name, input, nested, atMs) {
    switch (name) {
      case "Bash": {
        const text =
          `${inputStr(input, "command")} ${inputStr(input, "description")}`.toLowerCase();
        if (isSetup(text)) {
          setupSeen = true;
          if (!flag(input, "run_in_background") && !setupOpen.has(id)) setupOpen.set(id, atMs);
        } else if (containsAny(text, TRANSCRIBING_COMMAND_WORDS)) {
          // Transcribing has started, so the footage was looked at.
          mark("inspected", atMs);
        }
        break;
      }
      case "Write":
      case "Edit":
      case "MultiEdit":
        observeKinds(kindsOfPath(inputStr(input, "file_path")), !nested, atMs);
        break;
      case "Read":
        // A transcript is a data file; the script that makes one (transcribe.py) is not.
        if (
          !nested &&
          kindsOfPath(inputStr(input, "file_path")).transcript &&
          isDone("inspected")
        ) {
          mark("transcribed", atMs);
        }
        break;
      case "Agent":
      case "Task": {
        if (nested) break;
        const description =
          `${inputStr(input, "description")} ${inputStr(input, "subagent_type")}`.toLowerCase();
        if (flag(input, "run_in_background")) {
          // Its taskStarted / taskNotification tell when it runs and ends.
          agentSignal(classify(description), atMs);
        } else {
          taskStarted(id, description, true, true, atMs);
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    mark,

    /** @param {string} name @returns {boolean} */
    isDone,

    /** How many milestones are finished (seen or implied). @returns {number} */
    finished: () => done.size,

    /**
     * Reads one stream event: markers in the main session's text, and inference from tool calls,
     * background tasks and sub-agents.
     * @param {StreamEvent} event
     * @param {number} atMs The job's active milliseconds.
     */
    observe(event, atMs) {
      if (event.type === "assistant") {
        const nested = isNested(event);
        for (const block of event.content) {
          if (block.type === "text" && !nested) {
            for (const name of splitMarkers(block.text).markers) {
              const m = milestoneOf(name);
              if (m !== null) mark(m.name, atMs);
            }
          } else if (block.type === "toolUse") {
            toolUse(block.id, block.name, block.input, nested, atMs);
          }
        }
      } else if (event.type === "user") {
        for (const block of event.content) {
          if (block.type !== "toolResult") continue;
          setupEnded(block.toolUseId, atMs);
          if (tasks.get(block.toolUseId)?.endsWithResult === true) {
            taskFinished(block.toolUseId, atMs);
          }
        }
      } else if (event.type === "system" && event.subtype === "taskStarted") {
        const agent = event.taskType !== null && event.taskType.includes("agent");
        taskStarted(event.taskId, (event.description ?? "").toLowerCase(), false, agent, atMs);
      } else if (event.type === "system" && event.subtype === "taskNotification") {
        setupEnded(event.taskId, atMs);
        // Only a completed task counts: a stopped or failed one is done again later.
        if (event.status === null || event.status === "completed") taskFinished(event.taskId, atMs);
      }
    },

    /**
     * Reads what the working folder of the video shows (`work.js`, an edit only), in the order the
     * work goes so what one kind implies is in place for the next.
     * @param {import("./workFiles.js").Kinds} work
     * @param {number} atMs
     */
    observeWork(work, atMs) {
      observeKinds({ audio: work.audio }, true, atMs);
      observeKinds({ transcript: work.transcript }, true, atMs);
      observeKinds({ plan: work.plan, graphics: work.graphics }, true, atMs);
      observeKinds({ qualityCheck: work.qualityCheck }, true, atMs);
    },

    /**
     * Reads which files of the project are new since the job started.
     * @param {OutputEvidence} output
     * @param {number} atMs
     */
    observeOutput(output, atMs) {
      if (output.project) mark("project_saved", atMs);
      if (output.thumbnails && output.meta) mark("extras_written", atMs);
    },

    /**
     * The progress to show `nowMs` into the job. Never lower than anything returned before.
     * @param {number} nowMs The job's active milliseconds.
     * @returns {JobProgress}
     */
    current(nowMs) {
      const view = estimate(
        {
          model,
          pacing,
          done,
          shown: high,
          setupSeen,
          setupOpen: setupOpen.size > 0,
          setupMs,
        },
        nowMs,
      );
      high = view.percent;
      return { percent: view.percent, stage: view.stage, secondsLeft: view.secondsLeft };
    },

    /**
     * What to persist so a continued job goes on from here.
     * @param {string} jobId
     * @returns {ProgressMemory}
     */
    memory(jobId) {
      /** @type {Record<string, Mark>} */
      const marks = {};
      for (const name of MILESTONE_NAMES) {
        const m = done.get(name);
        if (m !== undefined) marks[name] = { atMs: m.atMs, implied: m.implied };
      }
      return { jobId, done: marks, percent: high };
    },

    /**
     * The milestones that were seen (not implied) with the active time they were finished at, for
     * the log and tests. What the files and the stream confirmed counts as seen, so a job whose
     * model never wrote a marker is still known by what it did.
     * @returns {Record<string, number>}
     */
    seen() {
      /** @type {Record<string, number>} */
      const out = {};
      for (const name of MILESTONE_NAMES) {
        const m = done.get(name);
        if (m !== undefined && !m.implied) out[name] = m.atMs;
      }
      return out;
    },
  };
}

/** @typedef {ReturnType<typeof createProgress>} ProgressEngine */

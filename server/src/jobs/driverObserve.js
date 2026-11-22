// What the driver makes of what its program says and does (`observe`, `exited_by_itself`,
// `error_end` and `check_output` of `driver.rs`): one line at a time into the turn tracker, the
// log and the progress, and the end of a program that ended without being asked to.

import { hasCompletionMarker } from "./keepgoing.js";
import {
  crashed,
  forApiResult,
  forErrorResult,
  loggedOut,
  missingOutput,
  usageLimit,
} from "./errors.js";
import { errorDraft } from "./logDescribe.js";
import { classify } from "./retry.js";
import {
  NO_CONVERSATION_FOUND,
  isInterrupted,
  isNested,
  isResumeNotFound,
} from "../agents/claude/protocol.js";
import { exitSuccess, lastStderrLine } from "../agents/claude/session.js";
import { limitResult } from "../agents/opencode/events.js";

/** @typedef {import("./driverState.js").DriverState} DriverState */
/** @typedef {import("../agents/claude/protocol.js").StreamEvent} StreamEvent */
/** @typedef {import("../agents/claude/protocol.js").TurnResult} TurnResult */
/** @typedef {import("../agents/claude/session.js").ExitInfo} ExitInfo */
/** @typedef {import("./retry.js").Failure} Failure */

/**
 * How one program ended.
 * @typedef {{ kind: "finished" }
 *   | { kind: "completed", file: string }
 *   | { kind: "resumeNotFound" }
 *   | { kind: "paused" }
 *   | { kind: "stopped" }
 *   | { kind: "failed", message: string }
 *   | { kind: "modelError", failure: Failure, message: string }} ProcessEnd
 */

/**
 * @param {string} text
 * @returns {string}
 */
export function firstLine(text) {
  return (text.split("\n")[0] ?? "").trim();
}

/** @param {DriverState} d */
function harnessOf(d) {
  return d.ctx.agent.harness;
}

/** @param {DriverState} d @param {string} text */
const scrub = (d, text) => (d.ctx.sink.scrub === undefined ? text : d.ctx.sink.scrub(text));

/**
 * The `error` of a job whose turn ended with `result`, in the words of its provider.
 * @param {DriverState} d
 * @param {TurnResult} result
 * @param {{ resetsAt: number | null } | null} limit
 * @returns {string}
 */
function errorMessage(d, result, limit) {
  const options = { scrub: (/** @type {string} */ text) => scrub(d, text) };
  if (d.ctx.job.setup === "claudeSubscription") {
    return forErrorResult(result, limit, d.clock, d.ctx.timeZone, options);
  }
  const wording = d.texts.serviceWording ?? {
    failureText: () => "",
    unknownFailure: "",
  };
  return forApiResult(result, d.ctx.agent.model ?? null, wording, harnessOf(d), options);
}

/**
 * How a program ends that reported an error result: a failure of the model provider that may
 * pass is retried, anything else fails the job.
 * @param {DriverState} d
 * @param {TurnResult} result
 * @param {{ resetsAt: number | null } | null} limit
 * @returns {ProcessEnd}
 */
export function errorEnd(d, result, limit) {
  const message = errorMessage(d, result, limit);
  const failure = classify(result, limit);
  return failure === null ? { kind: "failed", message } : { kind: "modelError", failure, message };
}

/**
 * Checks the expected output on disk: the job is complete when the deliverable exists.
 * @param {DriverState} d
 * @param {{ resetsAt: number | null } | null} limit A usage limit seen, named when nothing was made.
 * @returns {Promise<ProcessEnd>}
 */
export async function checkOutput(d, limit) {
  const file = await d.ctx.deliverable();
  if (file !== null) return { kind: "completed", file };
  return {
    kind: "failed",
    message:
      limit === null
        ? missingOutput(d.ctx.job.kind, harnessOf(d))
        : usageLimit(
            limit.resetsAt === null ? null : limit.resetsAt * 1000,
            d.clock,
            d.ctx.timeZone,
          ),
  };
}

/**
 * Feeds one line to the tracker, the log and the progress.
 * @param {DriverState} d
 * @param {import("./driverProcess.js").Proc} proc
 * @param {StreamEvent} event
 * @param {() => void} onTaskStarted Called when a background task starts (the tree is looked at).
 */
export function observe(d, proc, event, onTaskStarted) {
  const { tracker } = d.ctx;
  let observed = proc.tracker.observe(event, d.clock.now());
  tracker.observe(event);
  if (event.type === "assistant" && !isNested(event)) {
    for (const block of event.content) {
      if (block.type === "toolUse") d.turn.toolCalls += 1;
      else if (block.type === "text" && hasCompletionMarker(block.text)) d.turn.marker = true;
    }
  }
  // An API error that Claude Code ends a turn with, after its own retries, is a reason to stop
  // even when the result does not say it is an error; going on would only repeat it.
  if (
    observed.kind === "turnEnded" &&
    (observed.result.text ?? "").trimStart().startsWith("API Error")
  ) {
    observed = { kind: "error", result: { ...observed.result, isError: true } };
  }
  const described = proc.describer.describe(event);
  let entries = described.entries;
  if (proc.interrupting !== null) {
    // The aborted turn's error is the expected answer to our interrupt.
    entries = entries.filter(
      (e) => e.kind !== "error" || !(event.type === "result" && isInterrupted(event)),
    );
  }
  d.logAll(entries);
  if (described.activity !== null) d.activity = described.activity;

  if (event.type === "rateLimit") {
    const rejected = event.status === "rejected";
    if (d.ctx.job.setup === "claudeSubscription") {
      d.ctx.onRateLimit?.(event.raw);
      if (rejected) proc.limit = { resetsAt: event.resetsAt };
    } else if (harnessOf(d) === "opencode2" && rejected) {
      // OpenCode 2 would wait for the limit to reset (possibly days): the job ends with it.
      proc.error ??= limitResult(event, d.sessionId ?? "");
    }
  } else if (event.type === "result") {
    if (event.totalCostUsd !== null) {
      d.cost = event.totalCostUsd;
      d.lastCost = event.totalCostUsd;
    }
  } else if (event.type === "controlResponse") {
    if (proc.interrupting === event.requestId) proc.interruptAnswered = true;
  } else if (event.type === "system" && event.subtype === "taskStarted") {
    onTaskStarted();
  }

  if (observed.kind === "error") {
    if (!(proc.interrupting !== null && isInterrupted(observed.result))) {
      proc.error = observed.result;
    }
  } else if (observed.kind === "turnEnded") {
    const activity = proc.tracker.activity();
    if (activity.kind === "waitingForBackground") {
      const tasks = proc.tracker.backgroundTasks().join(", ");
      const line = firstLine(
        activity.count === 1
          ? `Waiting for a background task: ${tasks}`
          : `Waiting for ${activity.count} background tasks: ${tasks}`,
      );
      d.status(line);
      d.activity = line;
    }
  }
}

/**
 * The program ended without being asked to.
 * @param {DriverState} d
 * @param {import("./driverProcess.js").Proc} proc
 * @param {ExitInfo} exit
 * @param {boolean} resuming
 * @returns {ProcessEnd}
 */
export function exitedByItself(d, proc, exit, resuming) {
  const stderr = lastStderrLine(exit) ?? "";
  if (proc.error !== null) {
    const error = proc.error;
    proc.error = null;
    if (isResumeNotFound(error) && resuming) return { kind: "resumeNotFound" };
    return errorEnd(d, error, proc.limit);
  }
  if (resuming && stderr.includes(NO_CONVERSATION_FOUND)) return { kind: "resumeNotFound" };
  if (exitSuccess(exit) && proc.tracker.answeredOnce()) return { kind: "finished" };
  if (proc.limit !== null) {
    const reset = proc.limit.resetsAt === null ? null : proc.limit.resetsAt * 1000;
    return {
      kind: "modelError",
      failure: { what: "Usage limit", reset },
      message: usageLimit(reset, d.clock, d.ctx.timeZone),
    };
  }
  const lower = stderr.toLowerCase();
  if (lower.includes("/login") || lower.includes("not logged in")) {
    return {
      kind: "failed",
      message:
        d.ctx.job.setup === "claudeSubscription" ? loggedOut() : d.texts.loggedOutOnApi(stderr),
    };
  }
  if (stderr !== "") {
    d.log(errorDraft(firstLine(scrub(d, stderr)), { detail: exit.stderrTail.join("\n") }));
  }
  return {
    kind: "failed",
    message: crashed(exit.code, exit.signal, lastStderrLine(exit), harnessOf(d), {
      scrub: (text) => scrub(d, text),
    }),
  };
}

// The driver of one job (docs/SPEC.md section 9 and section 8, "Driving Claude Code",
// "Keeping a job going" and "Retrying after a model error"): `runAgentJob(ctx)` runs one job from the first message to its end and reports one
// outcome. The manager (queue, slots, start delay, database) decides when to call it and what to
// store; this file decides everything that happens in between:
//
// - starts the program (`agents/start.js`), sends the first message, reads its events into the
//   log and the progress;
// - decides when the model is finished (`jobs/keepgoing.js`): complete, continue with a message
//   of its own, stuck, or output missing; and checks the project (`ctx.verify`) before it calls a
//   job complete;
// - retries a failure of the model provider that may pass (`jobs/retry.js`), staying `running`
//   and keeping its slot meanwhile;
// - pauses and stops at any moment, and always ends with exactly one outcome and no process left.
//
// Every job keeps itself going (there is no mode where it ends when the model goes quiet); there
// is no session claim (one session belongs to one job), no machine lock and no backup of the
// output folder before a re-edit (a project version is a new file); a project that fails `verify`
// is sent back to the model twice.

import { createDriverState } from "./driverState.js";
import { checkOutput } from "./driverObserve.js";
import { runProcess } from "./driverProcess.js";
import { programName } from "./errors.js";
import { continueAfterError } from "./driverTexts.js";

/** @typedef {import("./keepgoing.js").JobKind} JobKind */
/** @typedef {import("./driverProcess.js").Launch} Launch */
/** @typedef {import("./driverObserve.js").ProcessEnd} ProcessEnd */
/** @typedef {import("./driverState.js").DriverState} DriverState */

/**
 * What the manager gives `runAgentJob`.
 * @typedef {object} AgentJobContext
 * @property {object} job Facts of the job.
 * @property {string} job.id
 * @property {JobKind} job.kind
 * @property {string} job.videoId
 * @property {string} job.videoDir The video's folder.
 * @property {string | null} job.sessionId The session to resume, `null` to start a new one.
 * @property {import("../agents/harness.js").Setup} job.setup The setup the job runs on.
 * @property {string} [job.serviceName] Named in the log for Claude Code on an API.
 * @property {number} [job.activeBeforeMs] The active time before this run (added to `activeMs`).
 * @property {import("../agents/start.js").AgentSpec extends infer S ? Omit<S & object, "onEvent" | "resumeId"> : never} agent
 *   What `startAgent` needs besides the session and the callbacks (`harness`, `command`, `cwd`,
 *   `env`, `model`, `effort`, and for OpenCode 2 `jobDir`, `option`, `key`, `baseUrl`, `title`,
 *   `secrets`, `timings`).
 * @property {string} firstMessage The first message: the follow-up when `job.sessionId` is set,
 *   otherwise the full instructions.
 * @property {string} [fullMessage] The full instructions, sent to a new session when the session
 *   cannot be resumed (default: `firstMessage`).
 * @property {string} [continueMessage] What a retry says to the continued session (default: the
 *   text of `driverTexts.js`).
 * @property {string} [sentLine] The log line when the first message is sent (default by kind).
 * @property {Partial<import("./driverTexts.js").Texts>} [texts]
 * @property {() => Promise<readonly string[]> | readonly string[]} [verify] Violations of the
 *   saved project, empty when it is fine; called after the marker and the end of the turn.
 * @property {() => Promise<string | null> | string | null} deliverable The file that proves the
 *   job did its work, if it is on disk now.
 * @property {ReturnType<typeof import("./progressTracker.js").createTracker>} tracker
 * @property {{ push: (videoId: string, jobId: string, drafts: readonly import("./logDescribe.js").Draft[]) => void, scrub?: (text: string) => string }} sink
 * @property {{ jobStarted(rootPid: number): void, jobEnded(): void, resumeAll(): void }} [limiter]
 *   Bound to this job by the manager.
 * @property {{ add(entry: { jobId: string, pid: number, startedAt?: number }): Promise<void>, remove(pid: number): Promise<void> }} [registry]
 * @property {(patch: JobPatch) => void} onUpdate
 * @property {{ now(): number }} [clock]
 * @property {import("./driverMailbox.js").Timers} [timers]
 * @property {Partial<import("./driverState.js").DriverTimings>} [timings]
 * @property {() => Promise<void> | void} [beforeChange] Awaited once, before the first message
 *   (before any program starts) of a job that may change a project.
 * @property {() => number} [maxRetries] Retries after a model error (read at each failure).
 * @property {Partial<import("./keepgoing.js").Limits>} [keepLimits]
 * @property {{ split: (text: string) => { text: string, markers: string[] }, logLine: (name: string) => string }} [describe]
 *   Extra options of the log describer (`paths`, `markers`).
 * @property {(raw: unknown) => void} [onRateLimit] A rate limit event of the Claude subscription.
 * @property {string} [timeZone]
 * @property {typeof import("../agents/start.js").startAgent} [startAgent] Test seam.
 * @property {ProcessOps} [process] Test seam: the system's process tree calls (`platform/process.js`).
 */

/**
 * @typedef {object} ProcessOps
 * @property {(root: number, known?: readonly number[]) => Promise<number[]>} listTree
 * @property {(root: number, options?: { graceMs?: number, knownPids?: readonly number[] }) => Promise<boolean>} endTree
 * @property {(pids: readonly number[]) => Promise<Map<number, number>>} cpuByPid
 */

/**
 * What the driver reports while the job runs (only the keys that changed).
 * @typedef {object} JobPatch
 * @property {string} [lastActivity]
 * @property {number} [costUsd] Cumulative cost as the program reports it.
 * @property {import("./progressTracker.js").ProgressUpdate} [progress]
 * @property {string} [sessionId] Once the program started: the session in use.
 */

/**
 * How the run ended.
 * @typedef {object} AgentOutcome
 * @property {"completed" | "paused" | "stopped" | "failed"} state
 * @property {{ code: string, message: string } | null} error `code` is `"failed"` for now.
 * @property {string | null} sessionId
 * @property {number | null} costUsd
 * @property {number} activeMs
 * @property {string | null} deliverable The file that proves a completed job.
 */

/**
 * @typedef {object} AgentJobHandle
 * @property {Promise<AgentOutcome>} done Resolves once, never rejects.
 * @property {() => void} pause Safe at any moment, also twice; after `stop` it does nothing.
 * @property {() => void} stop Safe at any moment, also twice; wins over `pause`.
 */

/**
 * The log line of the first message by kind (the words the creator sees in the log).
 * @param {JobKind} kind
 * @param {string} name
 * @returns {string}
 */
function sentLineOf(kind, name) {
  const who = name === "Claude Code" ? "Claude" : name;
  switch (kind) {
    case "edit":
      return `Sent the edit instructions to ${who}`;
    case "reEdit":
      return `Sent the re-edit request to ${who}`;
    case "timelineEdit":
      return `Sent the timeline edit request to ${who}`;
    case "render":
      return `Asked ${who} to render the final output`;
  }
}

/**
 * Checks the project of a finished program once (no fix can be asked of a program that is gone).
 * @param {DriverState} d
 * @param {ProcessEnd} end
 * @returns {Promise<ProcessEnd>}
 */
async function verified(d, end) {
  if (end.kind !== "completed" || d.ctx.verify === undefined) return end;
  try {
    const violations = await d.ctx.verify();
    if (violations.length === 0) return end;
    return { kind: "failed", message: d.texts.projectErrors(violations) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "failed", message: `The project could not be checked: ${message}` };
  }
}

/**
 * A program that only stopped after a usage limit on its event stream, with no error result and
 * no output, is retried like any other usage limit.
 * @param {DriverState} d
 * @param {ProcessEnd} end
 * @returns {Promise<ProcessEnd>}
 */
async function quietLimitRetry(d, end) {
  if (end.kind !== "finished" || d.limit === null) return end;
  const checked = await checkOutput(d, d.limit);
  if (checked.kind !== "failed") return end;
  const reset = d.limit.resetsAt === null ? null : d.limit.resetsAt * 1000;
  return {
    kind: "modelError",
    failure: { what: "Usage limit", reset },
    message: checked.message,
  };
}

/**
 * Waits before the next retry after a model error, or says how the job ends instead: retries used
 * up, a pause or a stop. The job stays `running` and keeps its slot meanwhile.
 * @param {DriverState} d
 * @param {import("./retry.js").Failure} failure
 * @param {string} message
 * @returns {Promise<ProcessEnd | null>} `null` once the wait is over.
 */
async function waitToRetry(d, failure, message) {
  const plan = d.planner.next(failure, message, d.ctx.tracker.workShown());
  if (plan.kind === "fail") return { kind: "failed", message: plan.message };
  d.status(plan.logLine);
  d.activity = null;
  d.update({ lastActivity: plan.activity });
  // On the wall clock with short waits: the time of a reset is a wall clock time, and a computer
  // that slept must not wait out the rest of a long wait.
  for (;;) {
    if (d.request !== null) return { kind: d.requestedEnd() };
    const left = plan.at - d.clock.now();
    if (left <= 0) break;
    await d.mailbox.recv(Math.min(left, 1000));
  }
  if (d.request !== null) return { kind: d.requestedEnd() };
  d.status(plan.resumeLine);
  d.activity = plan.resumeActivity;
  return null;
}

/**
 * Runs the program(s) of the job until it has an outcome.
 * @param {DriverState} d
 * @returns {Promise<ProcessEnd>}
 */
async function runLaunch(d) {
  const { ctx } = d;
  const name = programName(ctx.agent.harness);
  const full = ctx.fullMessage ?? ctx.firstMessage;
  /** @type {Launch} */
  let launch = {
    resumeId: ctx.job.sessionId,
    message: ctx.firstMessage,
    fullMessage: full,
    sentLine: ctx.sentLine ?? sentLineOf(ctx.job.kind, name),
  };
  let fellBack = false;
  for (;;) {
    const end = await quietLimitRetry(d, await runProcess(d, launch));
    switch (end.kind) {
      case "resumeNotFound":
        if (fellBack) {
          return { kind: "failed", message: `${name} could not resume or start the session.` };
        }
        fellBack = true;
        d.status(
          `${name} no longer has the earlier session, so a new session gets the full instructions.`,
        );
        launch = {
          ...launch,
          resumeId: null,
          message: launch.fullMessage,
          sentLine: "Sent the full instructions to the new session",
        };
        break;
      case "finished":
        // Quiet after its last answer: the deliverable decides.
        return verified(d, await checkOutput(d, d.limit));
      case "modelError": {
        const stop = await waitToRetry(d, end.failure, end.message);
        if (stop !== null) return stop;
        d.limit = null;
        // The same session goes on, like Continue Editing; a job that never got a session starts
        // its own request again.
        launch =
          d.sessionId === null
            ? { ...launch, resumeId: null, message: full }
            : {
                ...launch,
                resumeId: d.sessionId,
                message: ctx.continueMessage ?? continueAfterError(),
                sentLine: `Asked ${name === "Claude Code" ? "Claude" : name} to continue`,
              };
        fellBack = false;
        break;
      }
      default:
        return end;
    }
  }
}

/**
 * Starts a job and returns at once. Everything the job needs is in `ctx`.
 * @param {AgentJobContext} ctx
 * @returns {AgentJobHandle}
 */
export function runAgentJob(ctx) {
  const d = createDriverState(ctx);
  const done = (async () => {
    /** @type {ProcessEnd} */
    let end;
    try {
      end = await runLaunch(d);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      end = { kind: "failed", message: `The job could not be driven: ${message}` };
    }
    try {
      d.flushProgress(true);
      if (end.kind === "completed") ctx.tracker.recordCompletion();
    } catch {
      // Progress that cannot be saved must not change how the job ended.
    }
    if (d.limiterOn) {
      try {
        ctx.limiter?.jobEnded();
      } catch {
        // Same.
      }
    }
    d.finished = true;
    /** @type {AgentOutcome} */
    const outcome = {
      state:
        end.kind === "completed"
          ? "completed"
          : end.kind === "paused"
            ? "paused"
            : end.kind === "stopped"
              ? "stopped"
              : "failed",
      error:
        end.kind === "failed" || end.kind === "modelError"
          ? { code: "failed", message: end.message }
          : end.kind === "resumeNotFound" || end.kind === "finished"
            ? { code: "failed", message: "The job ended without a result." }
            : null,
      sessionId: d.sessionId,
      costUsd: d.lastCost,
      activeMs: (ctx.job.activeBeforeMs ?? 0) + Math.max(0, d.clock.now() - d.startedAt),
      deliverable: end.kind === "completed" ? end.file : null,
    };
    return outcome;
  })();
  return {
    done,
    pause: () => d.requestMade("pause"),
    stop: () => d.requestMade("stop"),
  };
}

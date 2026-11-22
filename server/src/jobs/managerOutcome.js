// What happens when a job's run ends (docs/SPEC.md section 8, "What a job keeps and puts back", and section 11,
// "Change requests"): revisions saved or restored, notes marked, the guarded transition, and the
// bookkeeping that follows. The order matters: the project is put right BEFORE the state changes,
// so nobody sees a failed job over a half-edited project.

import { fingerprint } from "../timeline/revisionFiles.js";
import { looksLoggedOut, programName } from "./errors.js";
import { requestOf } from "./managerTypes.js";

/** Revision labels by job kind (docs/SPEC.md section 10). */
const LABELS = {
  edit: "Edit",
  reEdit: "Re-Edit",
  timelineEdit: "Change request",
  render: "Render",
};

/** What a change request says when its job was stopped (a failed job's own sentence is used). */
export const NOTE_STOPPED = "The edit was stopped before it made this change.";

/** @param {import("./managerTypes.js").JobRecord} job */
const changesProject = (job) => job.kind === "reEdit" || job.kind === "timelineEdit";

/**
 * @param {import("./managerTypes.js").JobRecord} job
 * @param {"completed" | "failed" | "stopped" | "paused"} state
 * @param {string | null} error
 * @returns {{ event: import("./managerTypes.js").EditLogEntry["event"], message: string }}
 */
function editLogLine(job, state, error) {
  switch (state) {
    case "completed":
      // No agent program takes part in a render, so its line names none (like "Render started").
      return {
        event: "completed",
        message:
          job.kind === "render"
            ? "Render finished"
            : `Finished (${programName(job.harness ?? "claudeCode")})`,
      };
    case "failed":
      return { event: "failed", message: `Needs attention: ${error ?? "the job failed"}` };
    case "stopped":
      return { event: "stopped", message: "Stopped" };
    case "paused":
      return { event: "paused", message: "Paused" };
  }
}

/**
 * @param {import("./managerDeps.js").ManagerDeps} d
 */
export function createOutcomes(d) {
  const { jobs, videos, queues, limits, timeline, library, claude, runs, log } = d;

  /** @param {string} message @param {unknown} error */
  const warn = (message, error) =>
    log.warn?.(`${message}: ${error instanceof Error ? error.message : String(error)}`);

  /**
   * The project's index file when a project is there; for Re-Edit and change requests only when
   * it differs from the project before the job (an agent that changed nothing did not deliver).
   * @param {import("./managerTypes.js").JobRecord} job
   * @returns {Promise<string | null>}
   */
  async function deliverable(job) {
    if (!(await timeline.projectExists(job.videoKey))) return null;
    if (!changesProject(job)) return "index.html";
    const before = requestOf(jobs.get(job.id) ?? job).beforeFingerprint ?? null;
    const now = await fingerprint(await timeline.projectDir(job.videoKey));
    return before !== null && now === before ? null : "index.html";
  }

  /**
   * Puts the project back to the revision saved before a Re-Edit or change request, when the
   * job changed it, and marks its change requests as failed, each with the sentence of the job
   * (the page shows it under the request).
   * @param {import("./managerTypes.js").JobRecord} job
   * @param {string | null} [error] The sentence of a failed job; `null` for a stopped one.
   */
  async function revertEdits(job, error = null) {
    if (!changesProject(job)) return;
    const request = requestOf(jobs.get(job.id) ?? job);
    try {
      if (typeof request.beforeRevision === "number") {
        const now = await fingerprint(await timeline.projectDir(job.videoKey));
        if (now !== request.beforeFingerprint) {
          await timeline.restoreTo(job.videoKey, request.beforeRevision);
        }
      }
    } catch (error) {
      warn("Could not restore the project before the job", error);
    }
    if (job.kind === "timelineEdit") timeline.finishNotes(job.id, "failed", error ?? NOTE_STOPPED);
  }

  /**
   * Writes the edit log line of a job's end (SPEC section 16). It is called RIGHT AFTER the state
   * changed, with nothing awaited in between, and before the page is told: a page that reloads
   * the log on `job-updated` finds the line, and a Continue that follows at once cannot write
   * "Continued" ahead of the "Paused" line of the end it continues (the rescan below is slow).
   * @param {import("./managerTypes.js").JobRecord} job
   * @param {"completed" | "failed" | "stopped" | "paused"} state
   * @param {string | null} error
   */
  function logEnd(job, state, error) {
    try {
      d.editLog?.record({
        userId: job.userId,
        videoKey: job.videoKey,
        ...editLogLine(job, state, error),
      });
    } catch (e) {
      warn("Could not write the edit log", e);
    }
  }

  /**
   * The bookkeeping after a job left its running state (the edit log line is `logEnd`, written
   * earlier).
   * @param {import("./managerTypes.js").JobRecord} job
   * @param {"completed" | "failed" | "stopped" | "paused"} state
   * @param {string | null} error
   */
  async function afterEnd(job, state, error) {
    const owner = library.describeKey(job.videoKey);
    try {
      if (owner) await library.rescan(owner.userId);
    } catch (e) {
      warn("Could not rescan after a job", e);
    }
    try {
      if (!jobs.activeForVideo(job.videoKey)) await timeline.videoFreed(job.videoKey);
    } catch (e) {
      warn("Could not free the video after a job", e);
    }
    if (state === "failed" && job.setup === "claudeSubscription" && looksLoggedOut(error ?? "")) {
      claude.forgetLogin();
    }
  }

  /**
   * Handles the outcome of a run.
   * @param {import("./managerTypes.js").JobRecord} job
   * @param {import("./driver.js").AgentOutcome} outcome
   */
  async function finish(job, outcome) {
    const { state } = outcome;
    const message = outcome.error?.message ?? null;
    try {
      if (state === "completed" && job.kind !== "render") {
        await timeline.saveRevision(job.videoKey, {
          label: LABELS[job.kind],
          userId: null,
          jobId: job.id,
        });
        if (job.kind === "timelineEdit") timeline.finishNotes(job.id, "done");
      } else if (state === "failed" || state === "stopped") {
        await revertEdits(job, state === "failed" ? (message ?? "The job failed.") : null);
      }
    } catch (error) {
      warn("Could not save the revision of a finished job", error);
    }
    jobs.transition(job.id, ["running", "pausing", "stopping"], state, {
      error: state === "failed" ? (message ?? "The job failed.") : null,
      ...(typeof outcome.costUsd === "number" ? { costUsd: outcome.costUsd } : {}),
    });
    logEnd(job, state, message);
    if (outcome.sessionId && job.harness) {
      try {
        videos.setSession(job.videoKey, outcome.sessionId, job.harness);
      } catch (error) {
        warn("Could not remember the session", error);
      }
    }
    // A render counts itself with the limits module and the registry (render/runner.js).
    if (job.kind !== "render") limits.jobEnded(job.id);
    queues.released(job.id);
    await afterEnd(job, state, message);
    runs.get(job.id)?.end();
  }

  /**
   * Ends a job that has no run: a paused job that is stopped.
   * @param {import("./managerTypes.js").JobRecord} job
   */
  async function endPaused(job) {
    await revertEdits(job);
    if (!jobs.transition(job.id, ["paused"], "stopped", { error: null })) return;
    logEnd(job, "stopped", null);
    limits.jobEnded(job.id);
    queues.released(job.id);
    await afterEnd(job, "stopped", null);
  }

  return { finish, endPaused, revertEdits, afterEnd, logEnd, deliverable };
}

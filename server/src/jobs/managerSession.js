// Which setup and session a launch really uses (docs/SPEC-desktop.md section 6, "Setup and
// session of a launch", carried over by docs/SPEC.md section 8). A job keeps the setup it was
// created with; a session may only be resumed by the program that made it, and only while that
// setup can run now. Otherwise the job goes on in a new session on the current setup, which gets
// the full instructions, and the log says so.

import { SETUP_INFO } from "../agents/setups.js";
import { programName } from "./errors.js";

/**
 * @typedef {import("../agents/setupsService.js").Launch} LaunchChoice
 */

/**
 * @typedef {object} SessionDecision
 * @property {LaunchChoice} launch What the job really runs on.
 * @property {string | null} sessionId The session to resume, `null` for a new one.
 * @property {string | null} fallback The log sentence when the job left its setup, else `null`.
 */

/** @param {string} service @param {string | null} model */
const named = (service, model) => `${service}${model ? ` (${model})` : ""}`;

/** @param {unknown} error */
const reasonOf = (error) =>
  (error instanceof Error ? error.message : "it is not ready").replace(/\.+$/, "");

/**
 * @param {object} input
 * @param {import("./managerTypes.js").JobRecord} input.job
 * @param {{ sessionId: string | null, sessionHarness: string | null }} input.row The video's row.
 * @param {Pick<ReturnType<typeof import("../agents/index.js").createHarnessModule>, "launchFor" | "ensureReady">} input.harness
 * @returns {Promise<SessionDecision>}
 */
export async function decideSession({ job, row, harness }) {
  const candidate =
    row.sessionId !== null &&
    row.sessionHarness === job.harness &&
    (job.kind !== "edit" || job.resume)
      ? row.sessionId
      : null;
  const recorded = job.setup ?? undefined;
  const recordedLaunch = harness.launchFor(recorded);
  try {
    await harness.ensureReady({ setup: recordedLaunch.setup });
    // The job's own model and effort win over today's choice: they are part of the session.
    return {
      launch: {
        ...recordedLaunch,
        model: job.model ?? recordedLaunch.model,
        effort: job.effort ?? recordedLaunch.effort,
      },
      sessionId: candidate,
      fallback: null,
    };
  } catch (error) {
    const current = harness.launchFor();
    // The current setup must work, or the launch fails with its reason.
    await harness.ensureReady({ setup: current.setup });
    if (candidate === null) return { launch: current, sessionId: null, fallback: null };
    const was = job.setup === null ? "its earlier setup" : SETUP_INFO[job.setup].service;
    const now = SETUP_INFO[current.setup].service;
    return {
      launch: current,
      sessionId: null,
      fallback:
        `This video's session ran on ${named(was, job.model)}, which cannot continue it now ` +
        `(${reasonOf(error)}). A new session on ${programName(current.program)} with ` +
        `${named(now, current.model)} gets the full instructions.`,
    };
  }
}

/**
 * Whether a job can be launched at all now (a Continue is refused at the click otherwise):
 * its own setup, or else the current one.
 * @param {import("./managerTypes.js").JobRecord} job
 * @param {Pick<ReturnType<typeof import("../agents/index.js").createHarnessModule>, "ensureReady">} harness
 * @returns {Promise<void>}
 */
export async function ensureLaunchable(job, harness) {
  try {
    await harness.ensureReady(job.setup === null ? {} : { setup: job.setup });
  } catch {
    await harness.ensureReady({});
  }
}

// Which actions a video row offers (docs/SPEC.md section 8, "Kinds, queues and actions"). The server decides; the page only shows
// the buttons.
//
// The table. "latest job" is the newest job of the video; "active" means queued, running,
// pausing, paused or stopping. Rows are read top to bottom and the result is in this order.
//
//   latest job                              edited   actions
//   --------------------------------------  -------  ------------------------------------------
//   queued, startsAt set, viewer is admin   any      startNow, stop
//   queued, otherwise                       any      stop
//   running                                 any      pause, stop
//   pausing or stopping                     any      (none)
//   paused                                  any      continue, stop
//   failed                                  no       continue, startEdit
//   failed                                  yes      continue, reEdit, renderFinal
//   stopped, completed or none              no       startEdit
//   stopped, completed or none              yes      reEdit, renderFinal
//
// Then, independent of the table's rows:
//
//   review       a project exists (open the timeline), also while a job is active
//   upload       always
//   diskCleanup  no job is active and the working folder CLAUDE_VE holds files
//   archive      no job is active and the video is edited or its latest job failed
//
// Two facts remove `startEdit`: an upload into the video folder is not complete (SPEC section 6).
// An archived video offers only `unarchive`.
// `startNow` is for admins only, so a user's own queued edit never shows it to them.

/** @typedef {import("../../../src/lib/wire/library.ts").VideoAction} VideoAction */
/** @typedef {import("../../../src/lib/wire/jobs.ts").JobState} JobState */

/**
 * @typedef {object} ActionFacts
 * @property {{ state: JobState, startsAt: number | null } | null} job The video's latest job.
 * @property {boolean} edited A project exists.
 * @property {boolean} uploading An upload into the video folder is not complete.
 * @property {boolean} workingFiles `CLAUDE_VE` holds at least one file.
 * @property {boolean} admin The viewer is an admin.
 * @property {boolean} [archived] The video is archived.
 */

/** @type {readonly JobState[]} */
const ACTIVE_STATES = ["queued", "running", "pausing", "paused", "stopping"];

/**
 * Whether a job in this state counts as active: a video has at most one.
 * @param {JobState | null | undefined} state
 * @returns {boolean}
 */
export function isActiveState(state) {
  return state !== null && state !== undefined && ACTIVE_STATES.includes(state);
}

/**
 * @param {ActionFacts} facts
 * @returns {VideoAction[]}
 */
export function computeActions(facts) {
  if (facts.archived) return ["unarchive"];
  const state = facts.job?.state ?? null;
  const heldByDelay = facts.job?.startsAt !== null && facts.job?.startsAt !== undefined;
  const { edited } = facts;
  /** @type {VideoAction[]} */
  const actions = [];
  /** What a video with no active job offers to do with its project. @type {VideoAction[]} */
  const idle = edited ? ["reEdit", "renderFinal"] : ["startEdit"];

  switch (state) {
    case "queued":
      if (heldByDelay && facts.admin) actions.push("startNow");
      actions.push("stop");
      break;
    case "running":
      actions.push("pause", "stop");
      break;
    case "pausing":
    case "stopping":
      break;
    case "paused":
      actions.push("continue", "stop");
      break;
    case "failed":
      actions.push("continue", ...idle);
      break;
    default:
      actions.push(...idle);
  }

  const active = isActiveState(state);
  if (edited) actions.push("review");
  actions.push("upload");
  if (!active && facts.workingFiles) actions.push("diskCleanup");
  if (!active && (edited || state === "failed")) actions.push("archive");

  return facts.uploading ? actions.filter((action) => action !== "startEdit") : actions;
}

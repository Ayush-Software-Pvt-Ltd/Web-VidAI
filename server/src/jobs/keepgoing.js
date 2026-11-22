// Keeping a job going (docs/SPEC.md section 8, "Keeping a job going").
//
// Some models end a turn with a sentence that announces the next step, without doing it. A turn
// that ends before the job's work is done is not a failure: the server tells the model to go on,
// in the same live session, until the work is really done or there is a real reason to stop.
//
// This module is the pure decision, free of any harness type: whatever drives the model reports
// each moment it went idle as a `Turn` plus the `Evidence` it sees on disk and in the progress,
// and `Keeper.turnEnded` answers with a `Decision`: the job is complete, send the next message
// (`Nudge`, whose text lives in the prompt module), or stop because the model is stuck or the
// output is missing. The harness only has to say when the model is idle (no turn running, no
// background task, quiet for the settle time), count the tool calls of the main conversation,
// and notice the completion marker.

/**
 * What a job works on. `edit`, `reEdit` and `timelineEdit` are agent jobs; `render` runs
 * HyperFrames without an agent and never goes through this module, but the wording helpers
 * below still name it so a caller does not have to special-case it.
 * @typedef {"edit" | "reEdit" | "timelineEdit" | "render"} JobKind
 */

/** The line the instructions ask for when the work is fully done. */
export const COMPLETION_MARKER = "[OUTPUT COMPLETED]";

/**
 * Whether a message of the main conversation carries the completion marker (case does not
 * matter).
 * @param {string} text
 * @returns {boolean}
 */
export function hasCompletionMarker(text) {
  // ASCII-only upper-casing: the marker is ASCII and `toUpperCase` would also fold
  // characters such as the dotless i.
  return asciiUpper(text).includes(COMPLETION_MARKER);
}

/**
 * @param {string} text
 * @returns {string}
 */
function asciiUpper(text) {
  return text.replace(/[a-z]/g, (c) => c.toUpperCase());
}

/**
 * The thresholds of a keeper (docs/SPEC.md section 8, "Keeping a job going", gives the reasoning).
 * @typedef {object} Limits
 * @property {number} idleTurns Stuck after this many idle moments in a row whose turns made no
 *   tool call at all.
 * @property {number} withoutProgress Stuck after this many continuations in a row that brought
 *   no new progress milestone.
 * @property {number} ceiling The most continuations one run of a job sends (a run starts at a
 *   launch or a Continue).
 * @property {number} saveRequests How often the model is asked to save an output it said was
 *   done but is not there.
 */

/** @type {Readonly<Limits>} */
export const DEFAULT_LIMITS = Object.freeze({
  idleTurns: 3,
  withoutProgress: 8,
  ceiling: 40,
  saveRequests: 2,
});

/**
 * What the model did since the previous idle moment (since the job's message, or since the last
 * continuation): one or more turns.
 * @typedef {object} Turn
 * @property {number} toolCalls Tool calls of the main conversation (sub-agents not counted).
 * @property {boolean} marker The main conversation wrote `COMPLETION_MARKER`.
 */

/**
 * What the harness sees when the model went idle.
 * @typedef {object} Evidence
 * @property {string | null} deliverable The file or folder that proves the job did its work
 *   (the project of an edit, reEdit or timelineEdit; the final render of a render).
 * @property {string[]} extrasMissing Extras of the deliverable that are not written yet (for an
 *   edit, for example "thumbnails" and "meta.txt"); empty for every other case. Only named in
 *   the Finish nudge, never decided on.
 * @property {number} milestones How much the job has shown of its work (finished milestones and
 *   files written); only its growth counts.
 * @property {boolean} workersBusy The model's own commands are busy on the computer right now
 *   (processes of the job using CPU, for example a transcription started in the background of a
 *   shell): a model that ended its turn is waiting for them, not stuck.
 */

/**
 * Which message goes out next.
 * - `keepWorking`: nothing is delivered yet, keep working.
 * - `finish`: the deliverable exists but the marker was not written: finish what is left.
 * - `saveOutput`: the marker was written but the deliverable is not there: save it.
 * - `waitForWork`: nothing is delivered, but the model's commands are still busy: wait for them
 *   (the model ended its turn to wait, and only a message wakes it up).
 * @typedef {{ kind: "keepWorking" }
 *   | { kind: "finish", deliverable: string, extrasMissing: string[] }
 *   | { kind: "saveOutput" }
 *   | { kind: "waitForWork" }} Nudge
 */

/**
 * Why a job that is not done stops anyway: this many idle moments in a row without a single
 * tool call, this many continuations in a row without a new milestone, or the ceiling of
 * continuations per run.
 * @typedef {{ kind: "idleTurns" | "noProgress" | "ceiling", count: number }} Stuck
 */

/**
 * The answer to an idle moment.
 * - `complete`: the job is done.
 * - `continue`: send the message of `nudge`; `number` counts the continuations of this run from 1.
 * - `stuck`: not done, and going on would not help.
 * - `missingOutput`: the model kept saying it is done, but the deliverable is not there.
 * @typedef {{ kind: "complete", deliverable: string }
 *   | { kind: "continue", nudge: Nudge, number: number }
 *   | { kind: "stuck", reason: Stuck }
 *   | { kind: "missingOutput" }} Decision
 */

/**
 * @typedef {object} Keeper
 * @property {(turn: Turn, evidence: Evidence) => Decision} turnEnded The model went idle (no turn
 *   running, no background task, quiet for the settle time): decide whether the job is done,
 *   what to send next, or why to stop.
 *   - A deliverable with the marker (now or earlier in the run) is done. A deliverable without it
 *     gets one `finish` nudge; at the next idle moment it is done whatever the model wrote, so a
 *     model is never nagged once its real deliverable exists.
 *   - The marker without a deliverable gets `saveOutput` up to `limits.saveRequests` times, then
 *     `missingOutput`.
 *   - Otherwise the model ended early: `keepWorking`, unless it is stuck (idle turns in a row
 *     without a tool call, continuations without progress, or the ceiling).
 * @property {() => number} continuations Continuations sent in this run.
 */

/**
 * The state of one run of a job. A new run (a launch, or the owner's Continue) starts a new
 * keeper, so a manual Continue resets every counter.
 * @param {Readonly<Limits>} limits
 * @param {number} milestones The run starts with this many finished (a continued job keeps its
 *   progress; only new milestones count as progress).
 * @returns {Keeper}
 */
export function createKeeper(limits = DEFAULT_LIMITS, milestones = 0) {
  let sent = 0;
  let idleTurns = 0;
  let sinceProgress = 0;
  let known = milestones;
  let markerSeen = false;
  let finishSent = false;
  let saveSent = 0;

  /**
   * @param {Nudge} nudge
   * @returns {Decision}
   */
  function continueWith(nudge) {
    sent += 1;
    sinceProgress += 1;
    return { kind: "continue", nudge, number: sent };
  }

  return {
    continuations: () => sent,
    turnEnded(turn, evidence) {
      markerSeen ||= turn.marker;
      if (evidence.milestones > known) {
        known = evidence.milestones;
        sinceProgress = 0;
      }
      // A model that waits for its own busy commands is neither idle nor without progress.
      const waiting = evidence.workersBusy && evidence.deliverable === null && !turn.marker;
      idleTurns = waiting || turn.toolCalls > 0 ? 0 : idleTurns + 1;
      if (evidence.deliverable !== null) {
        const deliverable = evidence.deliverable;
        if (markerSeen || finishSent || sent >= limits.ceiling) {
          return { kind: "complete", deliverable };
        }
        finishSent = true;
        return continueWith({
          kind: "finish",
          deliverable,
          extrasMissing: [...evidence.extrasMissing],
        });
      }
      if (sent >= limits.ceiling) {
        return { kind: "stuck", reason: { kind: "ceiling", count: sent } };
      }
      if (turn.marker) {
        if (saveSent >= limits.saveRequests) return { kind: "missingOutput" };
        saveSent += 1;
        return continueWith({ kind: "saveOutput" });
      }
      if (waiting) {
        // Waiting messages count only toward the ceiling, not toward "without progress".
        sent += 1;
        return { kind: "continue", nudge: { kind: "waitForWork" }, number: sent };
      }
      if (idleTurns >= limits.idleTurns) {
        return { kind: "stuck", reason: { kind: "idleTurns", count: idleTurns } };
      }
      if (sinceProgress >= limits.withoutProgress) {
        return { kind: "stuck", reason: { kind: "noProgress", count: sinceProgress } };
      }
      return continueWith({ kind: "keepWorking" });
    },
  };
}

/**
 * What a job of `kind` works on, as the log and the errors say it.
 * @param {JobKind} kind
 * @returns {string}
 */
export function workNoun(kind) {
  switch (kind) {
    case "edit":
      return "edit";
    case "reEdit":
      return "re-edit";
    case "timelineEdit":
      return "timeline edit";
    case "render":
      return "final render";
  }
}

/**
 * The deliverable of a job of `kind` as a noun phrase ("the project").
 * @param {JobKind} kind
 * @returns {string}
 */
function deliverablePhrase(kind) {
  switch (kind) {
    case "edit":
      return "the project";
    case "reEdit":
    case "timelineEdit":
      return "the new project version";
    case "render":
      return "the final render";
  }
}

/**
 * The one status line of a continuation in the job's log (its `detail` is the message), also
 * the row's activity until the model writes something new.
 * @param {JobKind} kind
 * @param {Nudge} nudge
 * @param {number} number
 * @returns {string}
 */
export function statusLine(kind, nudge, number) {
  switch (nudge.kind) {
    case "keepWorking":
      return `Asked to keep going (${number}): the turn ended before the ${workNoun(kind)} was finished`;
    case "finish":
      return `Asked to finish the last steps (${number}): ${deliverablePhrase(kind)} is saved, [OUTPUT COMPLETED] is not written yet`;
    case "waitForWork":
      return `Asked to wait for the running commands (${number}): the computer is busy with your background work`;
    case "saveOutput":
      return `Asked to save ${deliverablePhrase(kind)} (${number}): [OUTPUT COMPLETED] was written, but it is not in the output folder`;
  }
}

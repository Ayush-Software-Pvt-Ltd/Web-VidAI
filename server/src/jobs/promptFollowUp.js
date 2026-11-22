// The messages that go to a session that already exists, and their fallback for a session that
// cannot be resumed (docs/SPEC.md section 8, "Kinds, queues and actions" and "Prompt"): Continue,
// Re-Edit and the request to fix a failed project check.
//
// A resumed session already has the header of its first message, so these refer to its names
// (PROJECT_FOLDER, CHECK_COMMAND). When the session is gone, `newSession` carries the input of
// the first message: the new session then gets the full instructions, the paragraph about the
// earlier work, and the follow-up (docs/SPEC.md section 8, "Prompt").

import { markerInstructions } from "./progressMarkers.js";
import { composeEdit } from "./promptEdit.js";
import { followUpOn, trimBlock } from "./promptHeader.js";
import {
  CONTINUE,
  CONTINUE_MARKERS,
  CONTINUE_OPENCODE,
  MISSING_OUTPUT,
  RE_EDIT_INTRO,
  RE_EDIT_RULES,
  earlierWork,
  profileFix,
} from "./promptTexts.js";

/** @typedef {import("./promptEdit.js").EditInput} EditInput */
/** @typedef {import("../agents/harness.js").Setup} Setup */
/** @typedef {import("../agents/harness.js").Harness} Harness */
/** @typedef {"edit" | "reEdit" | "timelineEdit"} AgentKind */

/**
 * What every follow-up message needs.
 * @typedef {object} FollowUpBase
 * @property {Setup} setup The job's setup: any setup but the Claude subscription also gets the
 *   keep-working paragraph.
 * @property {Harness} harness The job's program.
 * @property {EditInput | null} newSession `null` when the video's session is resumed. When the
 *   session cannot be resumed: the input of the first message, which then goes first.
 * @property {boolean} hasProject Whether a project exists in PROJECT_FOLDER (only read with
 *   `newSession`, for the paragraph about the earlier work).
 */

/**
 * Wraps a follow-up body: for a resumed session the body (plus the keep-working paragraph on an
 * API setup); for a new session the full first message, the earlier-work paragraph and the body
 * (the first message carries the keep-working paragraph already, so it is not added again).
 * @param {FollowUpBase} base
 * @param {string} body
 * @returns {string}
 */
export function wrapFollowUp(base, body) {
  if (base.newSession === null) return followUpOn(body, base.setup);
  return `${composeEdit(base.newSession)}\n\n${earlierWork(base.hasProject)}\n\n${body}`;
}

/**
 * @typedef {object} ContinueExtras
 * @property {AgentKind | null} afterFailure The kind of the job when the last attempt failed
 *   (the message then says what was missing); `null` after a pause.
 */

/**
 * Continue, after a pause or a failure.
 * @param {FollowUpBase & ContinueExtras} input
 * @returns {string}
 */
export function composeContinue(input) {
  const start = input.harness === "opencode2" ? CONTINUE_OPENCODE : CONTINUE;
  const body =
    input.afterFailure === null
      ? `${start}\n\n${CONTINUE_MARKERS}`
      : `${start} ${MISSING_OUTPUT[input.afterFailure]}\n\n${CONTINUE_MARKERS}`;
  return wrapFollowUp(input, body);
}

/**
 * @typedef {object} ReEditExtras
 * @property {string} changes The user's text.
 */

/**
 * Re-Edit with the user's text.
 * @param {FollowUpBase & ReEditExtras} input
 * @returns {string}
 */
export function composeReEdit(input) {
  const body = `${RE_EDIT_INTRO}\n\n${trimBlock(input.changes)}\n\n${RE_EDIT_RULES}\n\n${markerInstructions("reEdit")}`;
  return wrapFollowUp(input, body);
}

/**
 * The message after the completion marker when the server's project check failed: the errors, and
 * the request to fix them and write the marker again (the server asks at most
 * `PROFILE_FIX_ATTEMPTS` times).
 * @param {string[]} violations One sentence per error, as the check reports them.
 * @param {number} attempt 1 for the first request, 2 for the second.
 * @param {{ setup?: Setup }} [options] With a setup other than the Claude subscription the
 *   keep-working paragraph follows.
 * @returns {string}
 */
export function composeProfileFix(violations, attempt, options = {}) {
  const body = profileFix(violations, attempt);
  return options.setup === undefined ? body : followUpOn(body, options.setup);
}

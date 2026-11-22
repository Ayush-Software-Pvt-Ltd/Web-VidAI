// The words the driver says to the agent and about its own decisions (docs/SPEC-desktop.md section
// 6, "Keeping a job going"; `prompt.rs` `continuation_body_on` of the old core). Each can be
// replaced through `ctx.texts`; these are the old core's own sentences.

import { workNoun } from "./keepgoing.js";

/** @typedef {import("./keepgoing.js").JobKind} JobKind */
/** @typedef {import("./keepgoing.js").Nudge} Nudge */
/** @typedef {import("./errors.js").ServiceWording} ServiceWording */

/** The message that wakes a model that waits for its own busy commands. */
export const WAIT_FOR_WORK =
  "Your commands are still running and the computer is busy with them. Do not end your turn and do not poll in short loops: wait with one command that blocks until they finish (for example `wait`, or a loop that sleeps 30 seconds and checks the output, for up to 10 minutes), then go on with the next step. If a command shows no new output for 10 minutes, find out why and restart it.";

const GO_ON_OTHER =
  "Keep working now: do the next step with tool calls, and go on step by step until everything is done. Never end your turn after only announcing a step; do it in the same turn. Write each [VIDAI_PROGRESS <name>] marker as soon as its step is finished, in the message right after it, not several together at the end, and write [OUTPUT COMPLETED] in your last message once everything is done.";
const GO_ON =
  "Keep working now: do the next step with tool calls, and go on step by step until everything is done. Never end your turn after only announcing a step; do it in the same turn. Keep writing the [VIDAI_PROGRESS <name>] marker lines as steps finish, and write [OUTPUT COMPLETED] in your last message once everything is done.";

/**
 * The message sent when a turn ended before the work was done.
 * @param {JobKind} kind
 * @param {Nudge} nudge
 * @param {string} setup The job's setup (the Claude subscription gets its own wording).
 * @returns {string}
 */
export function continuation(kind, nudge, setup) {
  switch (nudge.kind) {
    case "keepWorking": {
      const missing =
        kind === "edit"
          ? "The edit is not finished yet: there is no review project in the output folder."
          : kind === "render"
            ? "The final render is not finished yet: there is no new final render in the output folder."
            : `The ${workNoun(kind)} is not finished yet: there is no new review project version in the output folder.`;
      return `${missing} ${setup === "claudeSubscription" ? GO_ON : GO_ON_OTHER}`;
    }
    case "finish": {
      const file = nudge.deliverable;
      if (kind === "edit") {
        return nudge.extrasMissing.length > 0
          ? `The review project output/${file} is saved, but [OUTPUT COMPLETED] is not written yet, and the thumbnails and meta.txt are missing. Finish every remaining step now with tool calls (the thumbnails, meta.txt and info.txt), then write [OUTPUT COMPLETED] in your last message.`
          : `The review project output/${file} is saved, but [OUTPUT COMPLETED] is not written yet. Finish any remaining step now with tool calls, then write [OUTPUT COMPLETED] in your last message.`;
      }
      if (kind === "render") {
        return `The final render output/${file} is in the output folder, but [OUTPUT COMPLETED] is not written yet. Finish any remaining step now with tool calls (check the file and update info.txt), then write [OUTPUT COMPLETED] in your last message.`;
      }
      return `The new review project version output/${file} is saved, but [OUTPUT COMPLETED] is not written yet. Finish any remaining step now with tool calls (info.txt, and the thumbnails and meta.txt if the changes affect them), then write [OUTPUT COMPLETED] in your last message.`;
    }
    case "waitForWork":
      return WAIT_FOR_WORK;
    case "saveOutput":
      return kind === "edit"
        ? "You wrote [OUTPUT COMPLETED], but there is no review project in the output folder in MAIN_FOLDER. Save the REVIEW_OUTPUT_SOFTWARE review project there now with tool calls (a .fcpxml file for Final Cut Pro, a .xml or .prproj file for Premiere Pro), then write [OUTPUT COMPLETED] again."
        : kind === "render"
          ? "You wrote [OUTPUT COMPLETED], but there is no new final render in the output folder in MAIN_FOLDER. Save the final render there now with tool calls, then write [OUTPUT COMPLETED] again."
          : "You wrote [OUTPUT COMPLETED], but there is no new review project version in the output folder in MAIN_FOLDER. Save it there now with tool calls (the next _vN number), then write [OUTPUT COMPLETED] again.";
  }
}

/**
 * @param {readonly string[]} violations
 * @returns {string}
 */
function list(violations) {
  return violations.map((v) => `- ${v}`).join("\n");
}

/**
 * Tells the agent what is wrong with the project it saved and asks for a fix (docs/SPEC.md
 * section 8, verify and repair).
 * @param {readonly string[]} violations
 * @param {number} attempt 1 or 2.
 * @returns {string}
 */
export function verifyFix(violations, attempt) {
  const again =
    attempt > 1 ? " This is the second check: the first fix did not remove every error." : "";
  return `The project you saved has errors that VidAI found when it checked it.${again} Fix every one of them now with tool calls, save the project again, then write [OUTPUT COMPLETED] in your last message.\n\n${list(violations)}`;
}

/**
 * The error a job ends with when the project still has errors after the allowed fixes.
 * @param {readonly string[]} violations
 * @returns {string}
 */
export function projectErrors(violations) {
  return `The project has errors: ${violations.join("; ")}`;
}

/**
 * What to say to a model that continues a session after a model error (a retry).
 * @returns {string}
 */
export function continueAfterError() {
  return "The earlier turn ended with an error from the model service. Continue the work where you stopped, with tool calls, until everything is done, then write [OUTPUT COMPLETED] in your last message.";
}

/**
 * @typedef {object} Texts
 * @property {typeof continuation} continuation
 * @property {typeof verifyFix} verifyFix
 * @property {typeof projectErrors} projectErrors
 * @property {ServiceWording | null} serviceWording What the service behind an API option answers,
 *   in words (`apiHttpFailure.js`); without it the error of an API option is the program's own.
 * @property {(stderr: string) => string} loggedOutOnApi The error of a program on an API option
 *   that says it is logged out (a refused key).
 */

/** @type {Texts} */
export const DEFAULT_TEXTS = Object.freeze({
  continuation,
  verifyFix,
  projectErrors,
  serviceWording: null,
  loggedOutOnApi: (stderr) =>
    `The service refused the key or the login${stderr === "" ? "." : `: ${stderr}`}`,
});

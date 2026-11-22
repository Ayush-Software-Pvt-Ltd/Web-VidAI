// User-readable job errors (`JobView.error`): short, human, no jargon, no em dash
// (src-tauri/src/jobs/errors.rs; docs/SPEC.md section 8 carries them over).
//
// "review file" became "the project" (a HyperFrames project folder, SPEC section 10). The program
// that did the editing is named from the job's harness ("Claude Code" or "OpenCode 2"); only the
// sentences about the Claude subscription (usage limit, logged out) always say Claude.

import { errorText } from "../agents/claude/protocol.js";
import { localTime } from "./errorsTime.js";
import { workNoun } from "./keepgoing.js";
import { firstLine, truncateChars } from "./logText.js";

/** @typedef {import("../agents/harness.js").Harness} Harness */
/** @typedef {import("../agents/claude/protocol.js").TurnResult} TurnResult */
/** @typedef {import("./keepgoing.js").JobKind} JobKind */
/** @typedef {import("./keepgoing.js").Stuck} Stuck */
/** @typedef {{ now(): number }} Clock */

/**
 * The reset time of a rejected `rate_limit_event` seen in this process, when there was one:
 * `resetsAt` in epoch seconds, or `null` when the event named none. Absent (`null` instead of
 * this object) when no such event was seen.
 * @typedef {{ resetsAt: number | null }} LimitSeen
 */

/**
 * What the service behind an API option answers, in words. The wording lives with the
 * OpenCode service code (`failure_text_for` and `unknown_failure` of `opencode/http.rs`); it is
 * passed in so this module stays free of it.
 * @typedef {object} ServiceWording
 * @property {(status: number | null, text: string, model: string | null) => string} failureText
 *   What the service answered, in words; `unknownFailure` when it says nothing known.
 * @property {string} unknownFailure The words of `failureText` for an answer it does not know.
 */

/**
 * Options of the functions that cut a line of what the program printed.
 * @typedef {object} ScrubOptions
 * @property {(text: string) => string} [scrub] Replaces registered secrets; applied BEFORE the
 *   text is cut, so a secret cut in half at the end of a line cannot leak as a prefix.
 */

/**
 * The program as the job's sentences name it.
 * @param {Harness} harness
 * @returns {string}
 */
export function programName(harness) {
  return harness === "opencode2" ? "OpenCode 2" : "Claude Code";
}

/**
 * "Claude finished without ..." for a job of `kind` ("OpenCode 2 finished ..." on OpenCode 2).
 * @param {JobKind} kind
 * @param {Harness} [harness]
 * @returns {string}
 */
export function missingOutput(kind, harness = "claudeCode") {
  const who = harness === "opencode2" ? "OpenCode 2" : "Claude";
  switch (kind) {
    case "edit":
      return `${who} finished without creating the project.`;
    case "reEdit":
    case "timelineEdit":
      return `${who} finished without saving a new project version.`;
    case "render":
      return `${who} finished without creating a final render.`;
  }
}

/**
 * "Claude usage limit reached, resets at 4:30 PM" (local time; "resets on Nov 19 at 9:05 AM"
 * when the reset is not today). A reset that is not in the future is not named.
 * @param {number | null} resetsAt Epoch milliseconds, when the provider named one.
 * @param {Clock} clock
 * @param {string} [timeZone] IANA zone; this computer's by default.
 * @returns {string}
 */
export function usageLimit(resetsAt, clock, timeZone) {
  const now = clock.now();
  if (resetsAt === null || resetsAt <= now) {
    return "Claude usage limit reached. Try again when the limit resets.";
  }
  const reset = localTime(resetsAt, timeZone);
  if (localTime(now, timeZone).day === reset.day) {
    return `Claude usage limit reached, resets at ${reset.time}`;
  }
  return `Claude usage limit reached, resets on ${reset.date} at ${reset.time}`;
}

/**
 * Claude Code is logged out (or its login expired) while a job ran or was about to start.
 * @returns {string}
 */
export function loggedOut() {
  return "Claude Code is logged out. Log in again (Settings, System), then press Continue Editing.";
}

/**
 * The agent ended unexpectedly.
 * @param {number | null} code Exit code, when it exited.
 * @param {number | string | null} signal The signal that ended it, when one did.
 * @param {string | null} lastStderr The last line it printed on stderr.
 * @param {Harness} [harness]
 * @param {ScrubOptions} [options]
 * @returns {string}
 */
export function crashed(code, signal, lastStderr, harness = "claudeCode", options = {}) {
  const how =
    code !== null ? `exit code ${code}` : signal !== null ? `signal ${signal}` : "unknown reason";
  const program = programName(harness);
  const line = (lastStderr === null ? "" : (options.scrub ?? identity)(lastStderr)).trim();
  return line !== ""
    ? `${program} stopped unexpectedly (${how}): ${truncateChars(line, 300)}`
    : `${program} stopped unexpectedly (${how}).`;
}

/**
 * The agent produced no output at all for a long time.
 * @param {number} minutes
 * @param {Harness} [harness]
 * @returns {string}
 */
export function stalled(minutes, harness = "claudeCode") {
  return `${programName(harness)} stopped responding (no activity for ${minutes} minutes).`;
}

/**
 * A job of `kind` that the server kept going stopped because its model is stuck
 * (`Stuck` of `keepgoing.js`). Provider-neutral: on an API option the model is not Claude.
 * @param {JobKind} kind
 * @param {Stuck} why
 * @returns {string}
 */
export function stuck(kind, why) {
  const work = workNoun(kind);
  switch (why.kind) {
    case "idleTurns":
      return `The model stopped working on the ${work}: it ended ${why.count} turns in a row without doing anything. Press Continue Editing to try again.`;
    case "noProgress":
      return `The model made no progress on the ${work} after being asked ${why.count} times to keep going. Press Continue Editing to try again.`;
    case "ceiling":
      return `The ${work} is still not finished after VidAI asked ${why.count} times to keep going, the most it asks in one run. Press Continue Editing to go on.`;
  }
}

/**
 * The agent process could not be started.
 * @param {string} reason What the system said (for example the message of the start error).
 * @param {Harness} [harness]
 * @returns {string}
 */
export function spawnFailed(reason, harness = "claudeCode") {
  return `${programName(harness)} could not be started: ${reason}`;
}

/**
 * The Editing Folder is gone.
 * @param {string} folder
 * @returns {string}
 */
export function editingFolderMissing(folder) {
  return `The Editing Folder is missing: ${folder}. Reconnect the drive or choose the folder again in Settings.`;
}

/**
 * The video folder is gone.
 * @param {string} folder
 * @returns {string}
 */
export function videoFolderMissing(folder) {
  return `The video folder is missing: ${folder}`;
}

/** @param {string} text */
function identity(text) {
  return text;
}

/**
 * Text patterns of a usage limit in a result or error message.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeUsageLimit(text) {
  const t = text.toLowerCase();
  return (
    t.includes("usage limit") ||
    t.includes("hit your limit") ||
    t.includes("limit reached") ||
    t.includes("rate limit") ||
    t.includes("limit will reset")
  );
}

/**
 * Text patterns of a lost login.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLoggedOut(text) {
  const t = text.toLowerCase();
  return (
    t.includes("/login") ||
    t.includes("not logged in") ||
    t.includes("please log in") ||
    t.includes("invalid api key") ||
    t.includes("oauth token") ||
    t.includes("authentication_error") ||
    t.includes("authentication failed")
  );
}

/**
 * The reset time Claude Code appends to its classic limit message: `...|1794637200`.
 * @param {string} text
 * @returns {number | null} Epoch seconds.
 */
export function epochSuffix(text) {
  const bar = text.lastIndexOf("|");
  if (bar < 0) return null;
  const tail = text.slice(bar + 1).trim();
  if (!/^[+-]?\d+$/.test(tail)) return null;
  const seconds = Number(tail);
  return Number.isSafeInteger(seconds) && seconds > 1_000_000_000 ? seconds : null;
}

/**
 * The `error` of a job that gave up retrying after a model error: `message` plus how often it
 * retried (docs/SPEC-desktop.md section 6, "Retrying after a model error").
 * @param {string} message
 * @param {number} retries
 * @returns {string}
 */
export function retriesUsedUp(message, retries) {
  const times = retries === 1 ? "1 time" : `${retries} times`;
  return `${message.trimEnd().replace(/\.+$/, "")}. VidAI retried ${times} without success.`;
}

/**
 * The HTTP status in Claude Code's "API Error: 429 {...}" text.
 * @param {string} text
 * @returns {number | null}
 */
export function apiErrorStatusIn(text) {
  const rest = text.split("API Error: ")[1];
  if (rest === undefined) return null;
  const digits = /^\d{3}/.exec(rest);
  if (digits === null) return null;
  const status = Number(digits[0]);
  return status >= 400 && status < 600 ? status : null;
}

/**
 * The reset of a limit as epoch milliseconds: the one the rate limit event named, else the one
 * at the end of the text.
 * @param {LimitSeen | null} limit
 * @param {string} text
 * @returns {number | null}
 */
export function resetOf(limit, text) {
  const seconds = limit?.resetsAt ?? epochSuffix(text);
  return seconds === null ? null : seconds * 1000;
}

/**
 * The message for an error result of a job on the Claude subscription.
 * @param {TurnResult} result
 * @param {LimitSeen | null} limit A rejected `rate_limit_event` seen in this process, if any.
 * @param {Clock} clock
 * @param {string} [timeZone]
 * @param {ScrubOptions} [options]
 * @returns {string}
 */
export function forErrorResult(result, limit, clock, timeZone, options = {}) {
  const text = errorText(result);
  const api429 = result.apiErrorStatus === 429;
  if (limit !== null || looksLikeUsageLimit(text) || api429) {
    return usageLimit(resetOf(limit, text), clock, timeZone);
  }
  if (looksLoggedOut(text) || result.apiErrorStatus === 401) return loggedOut();
  const scrub = options.scrub ?? identity;
  return `Claude Code reported an error: ${truncateChars(firstLine(scrub(text)), 300)}`;
}

/**
 * The message for an error result of a job on an API option: what the service answered, in
 * words. A refused key is the key's problem, never a lost Claude login, and a limit is the
 * service's, never the Claude plan's. What the service said nothing known about is reported as
 * the program's own error (`harness` names the program: Claude Code or OpenCode 2).
 * @param {TurnResult} result
 * @param {string | null} model
 * @param {ServiceWording} service
 * @param {Harness} harness
 * @param {ScrubOptions} [options]
 * @returns {string}
 */
export function forApiResult(result, model, service, harness, options = {}) {
  const text = errorText(result);
  let status = result.apiErrorStatus ?? apiErrorStatusIn(text);
  if (status === null && looksLoggedOut(text)) status = 401;
  const readable = service.failureText(status, text, model);
  if (readable !== service.unknownFailure) return readable;
  const scrub = options.scrub ?? identity;
  return `${programName(harness)} reported an error: ${truncateChars(firstLine(scrub(text)), 300)}`;
}

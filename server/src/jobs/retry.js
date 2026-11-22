// Automatic retries after the model provider failed (docs/SPEC-desktop.md section 6, "Retrying
// after a model error", carried over by docs/SPEC.md section 8): which failures are the
// provider's, how long to wait before each retry, how the counter runs, and the words of the
// wait. Pure, so it is tested without a process; the driver does the waiting.

import { errorText } from "../agents/claude/protocol.js";
import {
  apiErrorStatusIn,
  epochSuffix,
  looksLikeUsageLimit,
  looksLoggedOut,
  retriesUsedUp,
} from "./errors.js";
import { localTime } from "./errorsTime.js";

/** @typedef {import("../agents/claude/protocol.js").TurnResult} TurnResult */
/** @typedef {import("./errors.js").LimitSeen} LimitSeen */
/** @typedef {{ now(): number }} Clock */

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** How long to wait before retry 1, 2, 3, 4 and 5 (milliseconds); every later retry waits `LATER_GAP_MS`. */
export const GAPS_MS = Object.freeze([30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE]);
/** The wait before every retry after the fifth. */
export const LATER_GAP_MS = 15 * MINUTE;

/**
 * A failure of the model provider that may pass by itself.
 * @typedef {object} Failure
 * @property {string} what Short, for the log: "529 Overloaded", "Usage limit".
 * @property {number | null} reset When the provider said a usage limit resets (epoch ms).
 */

/** Text of answers that waiting does not fix: the plan, the balance, the key or the model. */
const NOT_TRANSIENT = [
  "gousagelimit",
  "go usage limit",
  "freeusagelimit",
  "budget exceeded",
  "budget policy",
  "budgetlimit",
  "insufficient account funds",
  "credit balance",
  "credit limit",
  "invoice is overdue",
  "model_not_found",
  "model not found",
];

/** Text of network and server trouble that carries no status, with the name it gets in the log. */
const TEXTS = /** @type {const} */ ([
  ["overloaded", "Overloaded"],
  ["rate limit", "Rate limit"],
  ["internal server error", "Server error"],
  ["bad gateway", "Bad gateway"],
  ["service unavailable", "Service unavailable"],
  ["temporarily unavailable", "Service unavailable"],
  ["gateway timeout", "Gateway timeout"],
  ["timed out", "Timeout"],
  ["etimedout", "Timeout"],
  ["econnreset", "Network error"],
  ["econnrefused", "Network error"],
  ["socket hang up", "Network error"],
  ["fetch failed", "Network error"],
  ["network error", "Network error"],
]);

/**
 * @param {number} status
 * @returns {string}
 */
function statusName(status) {
  switch (status) {
    case 400:
      return "Bad request";
    case 408:
      return "Request timeout";
    case 409:
      return "Conflict";
    case 425:
      return "Too early";
    case 429:
      return "Rate limited";
    case 500:
      return "Server error";
    case 502:
      return "Bad gateway";
    case 503:
      return "Service unavailable";
    case 504:
      return "Gateway timeout";
    case 529:
      return "Overloaded";
    default:
      return "Server error";
  }
}

/**
 * Whether an error result is the provider's failure that may pass: HTTP 400, 408, 409, 425, 429
 * and every 5xx (529 overloaded included), a usage limit, an overloaded or rate-limited provider,
 * and network trouble. Never a lost login, a refused key, a missing model or a plan limit that
 * only a person fixes.
 * @param {TurnResult} result
 * @param {LimitSeen | null} [limit] A rejected `rate_limit_event` seen in this process, if any.
 * @returns {Failure | null} `null` when waiting would not help.
 */
export function classify(result, limit = null) {
  const text = errorText(result);
  const lower = text.toLowerCase();
  const status = validStatus(result.apiErrorStatus) ?? apiErrorStatusIn(text);
  if (
    looksLoggedOut(text) ||
    (status !== null && status >= 401 && status <= 404) ||
    NOT_TRANSIENT.some((p) => lower.includes(p))
  ) {
    return null;
  }
  if (limit !== null || looksLikeUsageLimit(text) || status === 429) {
    const seconds = limit?.resetsAt ?? epochSuffix(text);
    return {
      what: status === null ? "Usage limit" : `${status} ${statusName(status)}`,
      reset: seconds === null ? null : seconds * 1000,
    };
  }
  if (status !== null) {
    const retried = status === 400 || status === 408 || status === 409 || status === 425;
    if (!retried && !(status >= 500 && status <= 599)) return null;
    return { what: `${status} ${statusName(status)}`, reset: null };
  }
  const found = TEXTS.find(([pattern]) => lower.includes(pattern));
  return found === undefined ? null : { what: found[1], reset: null };
}

/**
 * A status as the Rust takes it (`u16`): a whole number from 0 to 65535.
 * @param {number | null} status
 * @returns {number | null}
 */
function validStatus(status) {
  return status !== null && Number.isInteger(status) && status >= 0 && status <= 65535
    ? status
    : null;
}

/**
 * The scheduled wait before retry number `retry` (1 is the first), in milliseconds.
 * @param {number} retry
 * @returns {number}
 */
export function gap(retry) {
  const index = Math.max(0, retry - 1);
  return GAPS_MS[index] ?? LATER_GAP_MS;
}

/**
 * The wait before a retry: the scheduled `gapMs`, or until the provider's `reset` when that is
 * later.
 * @param {number} gapMs
 * @param {number | null} reset Epoch ms.
 * @param {number} now Epoch ms.
 * @returns {number} Milliseconds.
 */
export function wait(gapMs, reset, now) {
  const untilReset = reset === null ? 0 : Math.max(0, reset - now);
  return Math.max(gapMs, untilReset);
}

/**
 * "30 seconds", "2 minutes", "1 hour 5 minutes" (whole minutes from a minute on, rounded up).
 * @param {number} waitMs
 * @returns {string}
 */
export function inWords(waitMs) {
  const secs = Math.floor(waitMs / SECOND);
  if (secs < 60) return secs === 1 ? "1 second" : `${secs} seconds`;
  const total = Math.ceil(secs / 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  /**
   * @param {number} n
   * @param {string} unit
   */
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (hours === 0) return plural(minutes, "minute");
  if (minutes === 0) return plural(hours, "hour");
  return `${plural(hours, "hour")} ${plural(minutes, "minute")}`;
}

/**
 * The local clock time of `at` ("4:30 PM"), with the date when it is not today ("Nov 19, 9:05 AM").
 * @param {number} at Epoch ms.
 * @param {Clock} clock
 * @param {string} [timeZone] IANA zone; this computer's by default.
 * @returns {string}
 */
export function clockText(at, clock, timeZone) {
  const local = localTime(at, timeZone);
  return localTime(clock.now(), timeZone).day === local.day
    ? local.time
    : `${local.date}, ${local.time}`;
}

/**
 * What to do after a model error.
 * - `fail`: the job fails with `message` (retries off, or used up).
 * - `wait`: log `logLine`, show `activity`, wait until `at` (epoch ms, wall clock, so a computer
 *   that slept does not wait longer), then log `resumeLine` and show `resumeActivity`.
 * @typedef {{ kind: "fail", message: string }
 *   | { kind: "wait", retry: number, max: number, waitMs: number, at: number, logLine: string,
 *       activity: string, resumeLine: string, resumeActivity: string }} RetryPlan
 */

/**
 * @typedef {object} RetryPlanner
 * @property {(failure: Failure, message: string, workShown: number) => RetryPlan} next What to do
 *   after a model error: `message` is the readable error, `workShown` how much the job has shown
 *   of its work (finished milestones and files written). The count of retries in a row starts
 *   over when that grew since the last failure.
 * @property {() => number} retries Retries in a row so far.
 */

/**
 * The counter rules of one run of a job (a new run, at a launch or the owner's Continue, makes a
 * new planner, so a manual Continue starts at 0). `maxRetries` is read at every failure, so a
 * change of the setting applies to running jobs as well; 0 turns retrying off.
 * @param {object} options
 * @param {() => number} options.maxRetries
 * @param {Clock} options.clock
 * @param {number} [options.workShown] How much work the run starts with.
 * @param {number} [options.secondMs] One "second" of the schedule in milliseconds (tests shorten
 *   it, as `VIDAI_E2E_RETRY_SECOND_MS` did; the wait for a provider's reset time is not scaled).
 * @param {string} [options.timeZone]
 * @returns {RetryPlanner}
 */
export function createRetryPlanner({
  maxRetries,
  clock,
  workShown: startWork = 0,
  secondMs = SECOND,
  timeZone,
}) {
  let retries = 0;
  let seenWork = startWork;
  return {
    retries: () => retries,
    next(failure, message, workShown) {
      const max = maxRetries();
      if (workShown > seenWork) retries = 0;
      seenWork = workShown;
      if (retries >= max) {
        return {
          kind: "fail",
          message: retries === 0 ? message : retriesUsedUp(message, retries),
        };
      }
      retries += 1;
      const now = clock.now();
      const scheduled = gap(retries) * (secondMs / SECOND);
      const waitMs = wait(scheduled, failure.reset, now);
      const at = now + waitMs;
      const count = `retry ${retries} of ${max}`;
      return {
        kind: "wait",
        retry: retries,
        max,
        waitMs,
        at,
        logLine: `Model error (${failure.what}). Retrying in ${inWords(waitMs)} (${count})`,
        activity: `Model error. Retrying at ${clockText(at, clock, timeZone)} (${count})`,
        resumeLine: `Retrying now (${count})`,
        resumeActivity: `Retrying (${count})`,
      };
    },
  };
}

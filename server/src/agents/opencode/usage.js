// The OpenCode Go quota (docs/SPEC.md section 5, "Usage limits").
//
// The Go plan has three windows (5-hour, weekly, monthly) and reports them at
// `GET <Go root>/v1/usage` (for the default address `https://opencode.ai/inference/go/v1/usage`)
// as `{"usage":{"rolling"|"weekly"|"monthly":{"status":"ok"|"rate-limited","percent":0..100,
// "resetsAt":ISO}}}`: a share of each window and when it resets, no money. Inference answers carry
// no rate-limit headers, so that endpoint is the only source. When it does not answer for the
// saved key, or the address is not a Go address, the meters say so (`unavailable`) instead of
// showing a number VidAI made up.

import { failureText, parseError } from "../apiHttpFailure.js";

/** @typedef {import("../../../../src/lib/wire/harness.ts").OpencodeUsage} OpencodeUsage */
/** @typedef {import("../../../../src/lib/wire/harness.ts").OpencodeUsageLimit} OpencodeUsageLimit */

/** The Go root's usage path, after the address without its `/anthropic`. */
const USAGE_PATH = "/v1/usage";

/** Why there are no meters for an address that is not an OpenCode Go address. */
export const NOT_GO =
  "OpenCode reports 5-hour, weekly and monthly limits for Go subscriptions only. Spending and budgets of a balance are in the OpenCode console.";
/** Why there are no meters when the usage endpoint refuses the key. */
export const NOT_FOR_THIS_KEY =
  "OpenCode does not report usage to this API key. A key may need the Usage: Read permission, which you can give it in the OpenCode console.";
/** Why there are no meters for a workspace without Go. */
export const NO_GO_PLAN =
  "This key's workspace has no OpenCode Go subscription, so there are no Go limits to show.";
/** Why there are no meters without a key. */
export const NO_KEY = "Save an OpenCode API key to see its usage.";
/** Why there are no meters while edits do not run on OpenCode Go. */
export const NOT_SELECTED = "Edits do not run on OpenCode Go.";

/** @returns {OpencodeUsage} What is known before the first answer. */
export function emptyUsage() {
  return { limits: [], unavailable: null, fetchedAt: null, error: null };
}

/**
 * The usage address of an OpenCode Go address: `<...>/go/anthropic` becomes `<...>/go/v1/usage`.
 * Null for any other address (pay-as-you-go, another gateway).
 * @param {string} baseUrl
 * @returns {string | null}
 */
export function usageUrl(baseUrl) {
  /** @type {URL} */
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/u, "");
  if (!path.endsWith("/anthropic")) return null;
  const root = path.slice(0, path.length - "/anthropic".length);
  if (!root.toLowerCase().endsWith("/go")) return null;
  url.pathname = `${root}${USAGE_PATH}`;
  return url.href;
}

/** @type {readonly (readonly [string, string, string])[]} */
const WINDOWS = [
  ["rolling", "fiveHour", "5-hour limit"],
  ["weekly", "weekly", "Weekly limit"],
  ["monthly", "monthly", "Monthly limit"],
];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The windows of a Go usage answer (`fiveHour`, `weekly`, `monthly`; those present). Null when the
 * answer is not that shape. A window marked `rate-limited` counts as used up.
 * @param {string} body
 * @returns {OpencodeUsageLimit[] | null}
 */
export function parseGoUsage(body) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const windows = isRecord(value.usage) ? value.usage : value;
  /** @type {OpencodeUsageLimit[]} */
  const limits = [];
  for (const [name, key, label] of WINDOWS) {
    const window = windows[name];
    if (!isRecord(window)) continue;
    const percent = window.percent;
    if (typeof percent !== "number" || !Number.isFinite(percent)) continue;
    const used = window.status === "rate-limited" ? 100 : Math.min(100, Math.max(0, percent));
    const reset = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt.trim()) : NaN;
    limits.push({
      key,
      label,
      usedPercent: Math.round(used * 100) / 100,
      resetsAt: Number.isFinite(reset) ? reset : null,
    });
  }
  return limits.length > 0 ? limits : null;
}

/**
 * What one refresh found.
 * @typedef {{ kind: "limits", limits: OpencodeUsageLimit[] }
 *   | { kind: "unavailable", reason: string }
 *   | { kind: "failed", error: string }} Reading
 * `unavailable` is not an error: it stays so until something changes. `failed` keeps the last
 * values.
 */

/**
 * What an answer of the usage endpoint means.
 * @param {{ status: number, body: string }} answer
 * @returns {Reading}
 */
export function readingOf(answer) {
  switch (answer.status) {
    case 200: {
      const limits = parseGoUsage(answer.body);
      return limits === null
        ? {
            kind: "failed",
            error: "OpenCode answered, but not with usage limits. Try again later.",
          }
        : { kind: "limits", limits };
    }
    case 401:
      return { kind: "unavailable", reason: NOT_FOR_THIS_KEY };
    case 403:
      return {
        kind: "unavailable",
        reason: parseError(answer.body).kind === "EntitlementError" ? NO_GO_PLAN : NOT_FOR_THIS_KEY,
      };
    case 404:
      return { kind: "unavailable", reason: NOT_GO };
    default:
      return { kind: "failed", error: failureText(answer.status, answer.body) };
  }
}

/**
 * Applies a reading to the kept status.
 * @param {OpencodeUsage} status
 * @param {Reading} reading
 * @param {number} now Milliseconds since 1970.
 * @returns {OpencodeUsage} A new status.
 */
export function applyReading(status, reading, now) {
  switch (reading.kind) {
    case "limits":
      return { limits: reading.limits, unavailable: null, fetchedAt: now, error: null };
    case "unavailable":
      return { limits: [], unavailable: reading.reason, fetchedAt: now, error: null };
    case "failed":
      return { ...status, error: reading.error };
  }
}

/**
 * @typedef {object} UsageDeps
 * @property {{ now(): number }} clock
 * @property {(url: string, key: string) => Promise<{ status: number, body: string }>} getWithKey
 * @property {() => boolean} selected Whether edits run on OpenCode Go now: only then is OpenCode asked.
 * @property {() => string | null} key The saved OpenCode Go key, or null.
 * @property {() => string} baseUrl The address in use for OpenCode Go.
 * @property {(usage: OpencodeUsage) => void} [onUpdate] Called after every refresh that read something.
 */

/**
 * The last OpenCode usage and its refresh. Concurrent refreshes share one request: a refresh
 * asked for while another is running waits for it, but only when that one started after the
 * settings last changed (`reset`).
 * @param {UsageDeps} deps
 */
export function createUsageService(deps) {
  /** @type {OpencodeUsage} */
  let usage = emptyUsage();
  /** @type {Promise<OpencodeUsage> | null} */
  let running = null;
  /** Bumped by `reset`, so an answer for old settings is dropped. */
  let generation = 0;
  /** @type {number | null} */
  let lastAttempt = null;

  /** @returns {Promise<Reading | null>} */
  async function read() {
    if (!deps.selected()) return null;
    const key = deps.key();
    if (key === null) return { kind: "unavailable", reason: NO_KEY };
    const url = usageUrl(deps.baseUrl());
    if (url === null) return { kind: "unavailable", reason: NOT_GO };
    try {
      return readingOf(await deps.getWithKey(url, key));
    } catch (error) {
      return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    /** The last known usage. */
    usage() {
      return usage;
    },

    /** Forgets what is known (another key, address or setup), so nothing stale is shown. */
    reset() {
      generation += 1;
      running = null;
      lastAttempt = null;
      usage = emptyUsage();
    },

    /**
     * Asks OpenCode now (only while edits run on OpenCode Go). Never throws.
     * @returns {Promise<OpencodeUsage>}
     */
    refresh() {
      if (running !== null) return running;
      const mine = generation;
      lastAttempt = deps.clock.now();
      const current = (async () => {
        const reading = await read();
        if (reading === null || mine !== generation) return usage;
        usage = applyReading(usage, reading, deps.clock.now());
        deps.onUpdate?.(usage);
        return usage;
      })().finally(() => {
        if (running === current) running = null;
      });
      running = current;
      return current;
    },

    /**
     * Whether a scheduled refresh is due.
     * @param {number} intervalMs
     * @returns {boolean}
     */
    due(intervalMs) {
      return (
        running === null && (lastAttempt === null || deps.clock.now() - lastAttempt >= intervalMs)
      );
    },
  };
}

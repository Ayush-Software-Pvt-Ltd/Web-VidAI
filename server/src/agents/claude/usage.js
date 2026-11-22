// The plan's usage limits (docs/SPEC.md section 5, "Usage limits").
//
// The meter is fed two ways: the `get_usage` control request of the helper process (a periodic
// refresh, see `service.js`) and, free of charge, the `rate_limit_event` lines of running jobs.
// This file holds the pure mapping from Claude Code's answers to `UsageLimit`s.
//
// A `get_usage` answer (Claude Code 2.1.319) has `rate_limits_available` and `rate_limits` with
// the windows `five_hour` and `seven_day` (`{ utilization: percent, resets_at: ISO }` or null),
// model-scoped weekly windows (`seven_day_opus`, `seven_day_sonnet`, `model_scoped[]`), and a
// `limits` array that lists the same limits by `kind`: `session`, `weekly_all`, and
// `weekly_scoped` with `scope.model.display_name`. All of them are read and merged by key, the
// `limits` array first.

/** @typedef {import("../../../../src/lib/wire/usage.ts").UsageLimit} UsageLimit */
/** @typedef {import("../../../../src/lib/wire/usage.ts").UsageStatus} UsageStatus */

/** Key of the 5-hour (session) limit. */
export const FIVE_HOUR = "fiveHour";
/** Key of the weekly limit over all models. */
export const WEEKLY = "weekly";

/** @returns {UsageStatus} What is known before the first answer. */
export function emptyUsage() {
  return { available: false, limits: [], fetchedAt: null, error: null };
}

/**
 * Which limit a value belongs to: the 5-hour or the weekly limit, or the weekly limit of one
 * model family by its display name (for example "Fable").
 * @typedef {{ kind: "fiveHour" } | { kind: "weekly" } | { kind: "scoped", model: string }} LimitName
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {unknown} */
function field(/** @type {unknown} */ value, /** @type {string} */ key) {
  return isRecord(value) ? value[key] : undefined;
}

/** @param {unknown} value @returns {number | null} A JSON number, else `null`. */
function numberOf(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const RFC3339 = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/u;

/**
 * An RFC 3339 time as milliseconds since 1970, or `null` for anything else (a date without a
 * time, a made-up text). More than three fraction digits are cut, as the model timestamps do.
 * @param {string} text
 * @returns {number | null}
 */
export function parseRfc3339(text) {
  const m = RFC3339.exec(text.trim());
  if (m === null) return null;
  const [, date, time, fraction = "", zone = "Z"] = m;
  const millis = fraction.slice(0, 3).padEnd(3, "0");
  const ms = Date.parse(`${date}T${time}.${millis}${zone.toUpperCase()}`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * @param {string} text
 * @returns {string}
 */
function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * @param {LimitName} name
 * @param {number} percent
 * @param {number | null} resetsAt
 * @returns {UsageLimit | null}
 */
function makeLimit(name, percent, resetsAt) {
  if (!Number.isFinite(percent)) return null;
  /** @type {string} */
  let key;
  /** @type {string} */
  let label;
  if (name.kind === "fiveHour") {
    key = FIVE_HOUR;
    label = "5-hour limit";
  } else if (name.kind === "weekly") {
    key = WEEKLY;
    label = "Weekly limit";
  } else {
    const model = name.model.trim();
    const suffix = model.replace(/[^0-9A-Za-z]/gu, "");
    if (suffix === "") return null;
    key = `${WEEKLY}${capitalize(suffix)}`;
    label = `Weekly limit (${model})`;
  }
  return {
    key,
    label,
    // Two decimals hide float noise such as 0.19 * 100 = 19.000000000000004.
    usedPercent: Math.round(Math.min(100, Math.max(0, percent)) * 100) / 100,
    resetsAt,
  };
}

/**
 * `fiveHour`, then `weekly`, then the rest in their current order.
 * @param {UsageLimit[]} limits
 */
function sortLimits(limits) {
  /** @param {UsageLimit} l */
  const rank = (l) => (l.key === FIVE_HOUR ? 0 : l.key === WEEKLY ? 1 : 2);
  limits.sort((a, b) => rank(a) - rank(b));
}

/**
 * Adds a limit unless one with its key is already there (the first one wins).
 * @param {UsageLimit[]} limits
 * @param {LimitName} name
 * @param {unknown} percent
 * @param {unknown} resets
 */
function push(limits, name, percent, resets) {
  const resetsAt = typeof resets === "string" ? parseRfc3339(resets) : null;
  const value = numberOf(percent);
  if (value === null) return;
  const limit = makeLimit(name, value, resetsAt);
  if (limit !== null && !limits.some((l) => l.key === limit.key)) limits.push(limit);
}

/**
 * `{ available, limits }` from a `get_usage` answer. Limits are ordered `fiveHour`, `weekly`,
 * then the model-scoped weekly ones in the order Claude Code lists them. An answer without
 * readable limits counts as unavailable.
 * @param {unknown} answer
 * @returns {{ available: boolean, limits: UsageLimit[] }}
 */
export function parseUsage(answer) {
  const none = { available: false, limits: /** @type {UsageLimit[]} */ ([]) };
  const available = field(answer, "rate_limits_available") === true;
  const windows = field(answer, "rate_limits");
  if (!isRecord(windows) || !available) return none;
  /** @type {UsageLimit[]} */
  const limits = [];
  const listed = windows["limits"];
  for (const entry of Array.isArray(listed) ? listed : []) {
    /** @type {LimitName | null} */
    let name = null;
    const kind = field(entry, "kind");
    if (kind === "session") name = { kind: "fiveHour" };
    else if (kind === "weekly_all") name = { kind: "weekly" };
    else if (kind === "weekly_scoped") {
      const model = field(field(field(entry, "scope"), "model"), "display_name");
      if (typeof model === "string") name = { kind: "scoped", model };
    }
    if (name !== null) push(limits, name, field(entry, "percent"), field(entry, "resets_at"));
  }
  /** @type {readonly (readonly [string, LimitName])[]} */
  const windowed = [
    ["five_hour", { kind: "fiveHour" }],
    ["seven_day", { kind: "weekly" }],
    ["seven_day_opus", { kind: "scoped", model: "Opus" }],
    ["seven_day_sonnet", { kind: "scoped", model: "Sonnet" }],
  ];
  for (const [key, name] of windowed) {
    const window = windows[key];
    if (isRecord(window)) push(limits, name, window["utilization"], window["resets_at"]);
  }
  const scoped = windows["model_scoped"];
  for (const entry of Array.isArray(scoped) ? scoped : []) {
    const model = field(entry, "display_name");
    if (typeof model === "string") {
      push(
        limits,
        { kind: "scoped", model },
        field(entry, "utilization"),
        field(entry, "resets_at"),
      );
    }
  }
  sortLimits(limits);
  return { available: limits.length > 0, limits };
}

/**
 * The 5-hour and weekly limits of a `rate_limit_event`'s `rate_limit_info`, where utilization is
 * a fraction (0 to 1) and `resetsAt` is in epoch seconds. Empty when the shape is unknown.
 * @param {unknown} info
 * @returns {UsageLimit[]}
 */
export function limitsFromRateLimitInfo(info) {
  /** @type {UsageLimit[]} */
  const limits = [];
  /** @type {readonly (readonly [string, LimitName])[]} */
  const windows = [
    ["five_hour", { kind: "fiveHour" }],
    ["seven_day", { kind: "weekly" }],
  ];
  for (const [key, name] of windows) {
    const window = field(field(info, "unifiedWindows"), key);
    const fraction = numberOf(field(window, "utilization"));
    if (fraction === null) continue;
    const seconds = numberOf(field(window, "resetsAt"));
    const resetsAt = seconds === null ? null : Math.trunc(seconds * 1000);
    const limit = makeLimit(name, fraction * 100, resetsAt);
    if (limit !== null) limits.push(limit);
  }
  return limits;
}

/**
 * Replaces the limits in `current` that `updates` has a value for (by key), keeps the others,
 * and keeps the canonical order. Neither argument is changed.
 * @param {readonly UsageLimit[]} current
 * @param {readonly UsageLimit[]} updates
 * @returns {{ limits: UsageLimit[], changed: boolean }} `changed`: whether anything differs
 *   from `current`.
 */
export function mergeLimits(current, updates) {
  const limits = current.map((l) => ({ ...l }));
  for (const update of updates) {
    const at = limits.findIndex((l) => l.key === update.key);
    if (at >= 0) limits[at] = { ...update };
    else limits.push({ ...update });
  }
  sortLimits(limits);
  return { limits, changed: JSON.stringify(limits) !== JSON.stringify(current) };
}

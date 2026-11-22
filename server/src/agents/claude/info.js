// `ClaudeInfo`: the models, effort levels and defaults of the server's Claude Code, read from the
// `initialize` and `get_settings` control requests (docs/SPEC.md section 5, "Usage limits").
//
// Refresh policy (see `service.js`): at startup, on demand, and at most once a day otherwise.
// Every fetch uses a fresh short-lived helper process, so the list reflects the current settings.

/** @typedef {import("../../../../src/lib/wire/usage.ts").ClaudeInfo} ClaudeInfo */
/** @typedef {import("../../../../src/lib/wire/harness.ts").ClaudeModelInfo} ClaudeModelInfo */

/** How long `initialize` may take (it answers in well under a second normally). */
export const INITIALIZE_TIMEOUT_MS = 30_000;
/** How long `get_settings` may take. */
export const SETTINGS_TIMEOUT_MS = 15_000;
/** How old the cached list may get before it is fetched again without being asked. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The value Claude Code uses for its own "Default (recommended)" entry. VidAI leaves it out of the
 * list: the UI's own "Default" choice (`model: null`) already means "let Claude Code decide",
 * which also honours the model in the Claude Code settings of the server's OS user.
 */
const DEFAULT_ENTRY = "default";

/** @returns {ClaudeInfo} What is known before the first fetch. */
export function emptyInfo() {
  return {
    models: [],
    defaultModel: null,
    defaultEffort: null,
    subscriptionType: null,
    version: null,
    fetchedAt: null,
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {...string} keys
 * @returns {unknown} The value at the path, `undefined` when any step is not an object.
 */
function at(value, ...keys) {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * The trimmed string, or `null` for anything that is not a non-blank string.
 * @param {unknown} value
 * @returns {string | null}
 */
function nonEmpty(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

/**
 * @param {unknown} entry One element of `initialize`'s `models`.
 * @returns {ClaudeModelInfo | null}
 */
function parseModel(entry) {
  const value = nonEmpty(at(entry, "value"));
  if (value === null) return null;
  const supportsEffort = at(entry, "supportsEffort") !== false;
  const levels = at(entry, "supportedEffortLevels");
  const description = at(entry, "description");
  return {
    value,
    displayName: nonEmpty(at(entry, "displayName")) ?? value,
    description: typeof description === "string" ? description : "",
    effortLevels:
      Array.isArray(levels) && supportsEffort
        ? levels.flatMap((level) => nonEmpty(level) ?? [])
        : [],
  };
}

/**
 * The list value of the model Claude Code would use by itself.
 *
 * `applied.model` is the resolved model id (for example "claude-fable-5-1"), while the list holds
 * aliases (for example "fable" resolving to it). Preference: an entry whose value is the applied
 * id, then the alias from the user's settings (`effective.model`) when it resolves to the applied
 * id, then the first entry that resolves to it. Without `applied.model`, Claude Code's own default
 * entry tells which model it uses.
 * @param {unknown} settings The `get_settings` answer.
 * @param {readonly unknown[]} entries The raw `models` of `initialize`.
 * @returns {string | null}
 */
export function defaultModelOf(settings, entries) {
  const valueOf = (/** @type {unknown} */ m) => nonEmpty(at(m, "value"));
  const resolvedOf = (/** @type {unknown} */ m) => nonEmpty(at(m, "resolvedModel"));
  const applied =
    nonEmpty(at(settings, "applied", "model")) ??
    entries.filter((m) => valueOf(m) === DEFAULT_ENTRY).map(resolvedOf)[0] ??
    null;
  if (applied === null) return null;
  if (applied !== DEFAULT_ENTRY && entries.some((m) => valueOf(m) === applied)) return applied;
  const alias = nonEmpty(at(settings, "effective", "model"));
  if (
    alias !== null &&
    alias !== DEFAULT_ENTRY &&
    entries.some((m) => valueOf(m) === alias && resolvedOf(m) === applied)
  ) {
    return alias;
  }
  const resolving = entries
    .filter((m) => resolvedOf(m) === applied)
    .map(valueOf)
    .find((v) => v !== null && v !== DEFAULT_ENTRY);
  return resolving ?? applied;
}

/**
 * Builds `ClaudeInfo` from the `initialize` answer and the optional `get_settings` answer.
 * Entries without a value are dropped; missing fields become `null` or empty.
 * @param {unknown} init
 * @param {unknown} settings `null` or `undefined` when `get_settings` failed: the defaults are
 *   then unknown.
 * @param {number | null} fetchedAt
 * @returns {ClaudeInfo}
 */
export function parseInfo(init, settings, fetchedAt) {
  const raw = at(init, "models");
  const entries = Array.isArray(raw) ? raw : [];
  const known = settings !== null && settings !== undefined;
  return {
    models: entries.flatMap((entry) => {
      const model = parseModel(entry);
      return model === null || model.value === DEFAULT_ENTRY ? [] : [model];
    }),
    defaultModel: known ? defaultModelOf(settings, entries) : null,
    defaultEffort: known ? nonEmpty(at(settings, "applied", "effort")) : null,
    subscriptionType: nonEmpty(at(init, "account", "subscriptionType")),
    version: nonEmpty(at(init, "claude_code_version")),
    fetchedAt,
  };
}

/**
 * Asks a running helper for the model list and the defaults. `get_settings` failing is not fatal:
 * the defaults are then unknown. `initialize` failing is.
 * @param {{ request(subtype: string, timeoutMs: number): Promise<unknown> }} client
 * @param {number} fetchedAt
 * @returns {Promise<ClaudeInfo>}
 */
export async function fetchInfo(client, fetchedAt) {
  const init = await client.request("initialize", INITIALIZE_TIMEOUT_MS);
  /** @type {unknown} */
  let settings;
  try {
    settings = await client.request("get_settings", SETTINGS_TIMEOUT_MS);
  } catch {
    settings = null;
  }
  return parseInfo(init, settings, fetchedAt);
}

/**
 * Whether two lists say the same, for deciding whether a selection must be checked again.
 * @param {ClaudeInfo} a
 * @param {ClaudeInfo} b
 * @returns {boolean}
 */
export function sameModels(a, b) {
  return a.defaultModel === b.defaultModel && JSON.stringify(a.models) === JSON.stringify(b.models);
}

/**
 * @typedef {object} ModelSelection
 * @property {string | null} model `null` is Claude Code's default.
 * @property {string | null} effort `null` sends nothing.
 */

/**
 * Applies the selection rules (docs/SPEC.md section 5, "Usage limits") against the known model list: a
 * model that is not in the list falls back to `null` (Claude Code's default), and an effort the
 * chosen model does not support is reset to `null`. Without a fetched list (`info` is `null` or
 * has no models) the selection is kept as given, only blank strings become `null`.
 * @param {ModelSelection} selection
 * @param {ClaudeInfo | null} info
 * @returns {ModelSelection}
 */
export function normalizeSelection(selection, info) {
  const clean = (/** @type {string | null} */ v) => {
    const text = v?.trim();
    return text ? text : null;
  };
  let model = clean(selection.model);
  let effort = clean(selection.effort);
  if (info === null || info.models.length === 0) return { model, effort };
  const effective = model ?? info.defaultModel;
  const known = effective === null ? undefined : info.models.find((m) => m.value === effective);
  if (model !== null && known === undefined) model = null;
  /** @type {readonly string[] | null} */
  let levels = null;
  if (model !== null && known !== undefined) levels = known.effortLevels;
  // The default model: only check when Claude Code told us which model that is.
  else if (model === null && known !== undefined && info.defaultModel !== null) {
    levels = known.effortLevels;
  }
  if (levels !== null && effort !== null && !levels.includes(effort)) effort = null;
  return { model, effort };
}

// The per-option state of the harness (docs/SPEC.md section 5): each API option's address, model
// and reasoning efforts, the Claude subscription's model and effort, and the last model list of
// OpenCode Go. `settings.js` has a fixed set of keys and no generic get/set, so this keeps its
// own rows in the same `settings` table (keys starting with `harness.`) through the repository;
// `settings.js` ignores them. The `setup` itself stays in `settings.js`; keys are not here at all
// (`secrets.js`).
//
// Stored values are read leniently: anything that does not fit falls back to empty, so a hand
// edit or an older shape never breaks the server.

import { API_EFFORTS } from "./setups.js";

/** @typedef {import("../../../src/lib/wire/harness.ts").ApiOption} ApiOption */

/**
 * @typedef {object} OptionSettings
 * @property {string | null} baseUrl Normalized; null is the default address.
 * @property {string | null} model
 * @property {Record<string, string>} efforts Reasoning effort per model id.
 *
 * @typedef {object} ClaudeChoice
 * @property {string | null} model
 * @property {string | null} effort
 *
 * @typedef {object} StoredModel
 * @property {string} id
 * @property {string} displayName
 *
 * @typedef {object} StoredModels The list as last fetched, with the address it belongs to.
 * @property {string} baseUrl
 * @property {StoredModel[]} models
 * @property {number} fetchedAt Milliseconds since 1970.
 */

const OPTIONS_KEY = "harness.options";
const CLAUDE_KEY = "harness.claude";
const MODELS_KEY = "harness.apiModels";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {string | null} */
function textOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** @param {unknown} value @returns {OptionSettings} */
function readOption(value) {
  const record = isRecord(value) ? value : {};
  /** @type {Record<string, string>} */
  const efforts = {};
  if (isRecord(record.efforts)) {
    for (const [model, effort] of Object.entries(record.efforts)) {
      if (typeof effort === "string" && API_EFFORTS.includes(effort)) efforts[model] = effort;
    }
  }
  return { baseUrl: textOrNull(record.baseUrl), model: textOrNull(record.model), efforts };
}

/** @param {unknown} value @returns {StoredModels | null} */
function readModels(value) {
  if (!isRecord(value) || typeof value.baseUrl !== "string" || !Array.isArray(value.models)) {
    return null;
  }
  /** @type {StoredModel[]} */
  const models = [];
  for (const entry of /** @type {unknown[]} */ (value.models)) {
    if (isRecord(entry) && typeof entry.id === "string" && typeof entry.displayName === "string") {
      models.push({ id: entry.id, displayName: entry.displayName });
    }
  }
  const fetchedAt = typeof value.fetchedAt === "number" ? value.fetchedAt : 0;
  return { baseUrl: value.baseUrl, models, fetchedAt };
}

/**
 * @param {{ repo: ReturnType<typeof import("../db/settings.js").createSettingsRepo> }} deps
 */
export function createSetupStore({ repo }) {
  /** @returns {Record<ApiOption, OptionSettings>} */
  function readOptions() {
    const stored = repo.get(OPTIONS_KEY);
    const record = isRecord(stored) ? stored : {};
    return {
      opencodeGo: readOption(record.opencodeGo),
      anthropicApi: readOption(record.anthropicApi),
      openaiApi: readOption(record.openaiApi),
    };
  }

  /** @param {Record<ApiOption, OptionSettings>} all */
  function writeOptions(all) {
    repo.set(OPTIONS_KEY, all);
  }

  /**
   * Changes one option in one write.
   * @param {ApiOption} option
   * @param {(current: OptionSettings) => OptionSettings} change
   */
  function updateOption(option, change) {
    const all = readOptions();
    all[option] = change(all[option]);
    writeOptions(all);
  }

  return {
    /** @param {ApiOption} option @returns {OptionSettings} */
    option(option) {
      return readOptions()[option];
    },

    /** Every option, for the admin screen. @returns {Record<ApiOption, OptionSettings>} */
    options: readOptions,

    /** @param {ApiOption} option @param {string | null} baseUrl Already normalized. */
    setBaseUrl(option, baseUrl) {
      updateOption(option, (current) => ({ ...current, baseUrl }));
    },

    /** @param {ApiOption} option @param {string | null} model Already checked. */
    setModel(option, model) {
      updateOption(option, (current) => ({ ...current, model }));
    },

    /**
     * Remembers the effort of one model; null forgets it. Other models keep theirs, so switching
     * back restores each effort.
     * @param {ApiOption} option @param {string} model @param {string | null} effort
     */
    setEffort(option, model, effort) {
      updateOption(option, (current) => {
        const efforts = { ...current.efforts };
        if (effort === null) delete efforts[model];
        else efforts[model] = effort;
        return { ...current, efforts };
      });
    },

    /** The model and effort of the Claude subscription. @returns {ClaudeChoice} */
    claude() {
      const stored = repo.get(CLAUDE_KEY);
      const record = isRecord(stored) ? stored : {};
      return { model: textOrNull(record.model), effort: textOrNull(record.effort) };
    },

    /** @param {ClaudeChoice} choice Already normalized. */
    setClaude(choice) {
      repo.set(CLAUDE_KEY, { model: choice.model, effort: choice.effort });
    },

    /**
     * The model list last fetched for an option (kept for OpenCode Go only), or null.
     * @param {ApiOption} option
     * @returns {StoredModels | null}
     */
    apiModels(option) {
      const stored = repo.get(MODELS_KEY);
      return isRecord(stored) ? readModels(stored[option]) : null;
    },

    /** @param {ApiOption} option @param {StoredModels} list */
    setApiModels(option, list) {
      const stored = repo.get(MODELS_KEY);
      const record = isRecord(stored) ? { ...stored } : {};
      record[option] = list;
      repo.set(MODELS_KEY, record);
    },
  };
}

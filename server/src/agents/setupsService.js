// The harness settings of the whole server (docs/SPEC.md section 5, "Harness, program and model"):
// everything the admin screen changes and everything a new job needs to know about the setup.
// Nothing here
// is an RPC function (`rpc/adminHarness.js` is) and nothing here touches the network itself (the
// injected `http` and `usage` do).
//
// Keys live in `secrets` (encrypted) under one name per option; a key is never returned, never
// logged and never part of an error message. `secretsToScrub()` gives the job log scrubber what
// to hide.

import { invalidInput } from "../errors.js";
import { createReadiness } from "./readiness.js";
import {
  API_OPTIONS,
  SETUP_INFO,
  checkEffort,
  defaultBaseUrl,
  isApiOption,
  keyName,
  keyRequired,
  noModelText,
  normalizeKey,
  normalizeModelId,
  optionOfSetup,
  programOf,
  setupOfOption,
} from "./setups.js";
import { selectionProblem } from "./setupsJob.js";
import { normalizeSelection } from "./claude/info.js";
import { normalizeBaseUrl } from "./setupsUrl.js";

/** @typedef {import("../../../src/lib/wire.ts").Setup} Setup */
/** @typedef {import("../../../src/lib/wire/harness.ts").ApiOption} ApiOption */
/** @typedef {import("../../../src/lib/wire/harness.ts").ApiModels} ApiModels */
/** @typedef {import("../../../src/lib/wire/harness.ts").ApiTest} ApiTest */
/** @typedef {import("../../../src/lib/wire/harness.ts").ApiOptionState} ApiOptionState */
/** @typedef {import("../../../src/lib/wire/harness.ts").ClaudeModelInfo} ClaudeModelInfo */
/** @typedef {import("../../../src/lib/wire/harness.ts").ClaudeSelection} ClaudeSelection */
/** @typedef {import("../../../src/lib/wire/harness.ts").HarnessAdminState} HarnessAdminState */
/** @typedef {import("../../../src/lib/wire/harness.ts").HarnessPublicView} HarnessPublicView */
/** @typedef {import("../../../src/lib/wire/harness.ts").Readiness} Readiness */
/** @typedef {import("./apiHttpFailure.js").Audience} Audience */
/** @typedef {import("./setupsJob.js").ApiSetup} ApiSetup */

/**
 * What a new job on a setup is started with. Holds the key: it never leaves the server and is
 * never logged.
 * @typedef {object} Launch
 * @property {Setup} setup
 * @property {import("../../../src/lib/wire/harness.ts").HarnessProgram} program
 * @property {ApiOption | null} option
 * @property {string | null} model `null` is Claude Code's own default (Claude subscription only).
 * @property {string | null} effort
 * @property {string | null} baseUrl The address in use; null for the Claude subscription.
 * @property {string | null} key
 */

/**
 * @typedef {object} SetupsDeps
 * @property {ReturnType<typeof import("./setupStore.js").createSetupStore>} store
 * @property {{ getAll(): { setup: Setup }, update(patch: unknown): unknown }} settings The `setup`
 *   setting lives with the other admin settings (`settings.js`).
 * @property {{ get(name: string): string | null, set(name: string, value: string): void,
 *   clear(name: string): void, status(name: string): { saved: boolean, last4: string | null } }} secrets
 * @property {{ now(): number }} clock
 * @property {ReturnType<typeof import("./apiHttp.js").createApiHttp>} http
 * @property {ReturnType<typeof import("./opencode/usage.js").createUsageService>} usage
 * @property {import("./readiness.js").ReadinessProbes} probes
 * @property {() => Promise<ClaudeModelInfo[]>} claudeModels The models Claude Code offers (empty
 *   while unknown).
 * @property {() => Promise<import("../../../src/lib/wire/harness.ts").ClaudeRouting | null>} detectRouting
 * @property {() => void | Promise<void>} [onChange] Called after every change the users should
 *   see (the setup, the model, the effort).
 */

/**
 * @param {SetupsDeps} deps
 */
export function createSetupsService(deps) {
  const { store, settings, secrets, clock, http, usage, claudeModels } = deps;
  const readiness = createReadiness({ probes: deps.probes });

  /** @returns {Setup} */
  const currentSetup = () => settings.getAll().setup;

  /** @param {ApiOption} option @returns {string | null} */
  const savedKey = (option) => secrets.get(keyName(option));

  /** @param {ApiOption} option @returns {string} The address requests use. */
  function effectiveBaseUrl(option) {
    return store.option(option).baseUrl ?? defaultBaseUrl(option);
  }

  /**
   * The ids last fetched for the address in use, or null when no list was fetched for it. Only
   * OpenCode Go keeps a list; the other two take any typed model.
   * @param {ApiOption} option
   * @returns {string[] | null}
   */
  function offeredIds(option) {
    if (option !== "opencodeGo") return null;
    const list = store.apiModels(option);
    return list !== null && list.baseUrl === effectiveBaseUrl(option)
      ? list.models.map((model) => model.id)
      : null;
  }

  /**
   * What is known about one option right now.
   * @param {ApiOption} option
   * @returns {ApiSetup}
   */
  function apiSetup(option) {
    const saved = store.option(option);
    return {
      option,
      key: savedKey(option),
      baseUrl: effectiveBaseUrl(option),
      model: saved.model,
      offered: offeredIds(option),
    };
  }

  /** @param {() => void | Promise<void> | undefined} [after] */
  async function changed(after) {
    await after?.();
    await deps.onChange?.();
  }

  /** While edits run on `option`, they go back to the Claude subscription. @param {ApiOption} option */
  function fallBackToClaude(option) {
    if (currentSetup() === setupOfOption(option)) settings.update({ setup: "claudeSubscription" });
  }

  /** Forgets the quota of the old key or address and asks again in the background. */
  function restartUsage() {
    usage.reset();
    void usage.refresh();
  }

  /**
   * @param {ApiOption} option
   * @returns {ApiOptionState}
   */
  function optionState(option) {
    const saved = store.option(option);
    return {
      baseUrl: saved.baseUrl,
      effectiveBaseUrl: saved.baseUrl ?? defaultBaseUrl(option),
      defaultBaseUrl: defaultBaseUrl(option),
      keyRequired: keyRequired(option),
      key: secrets.status(keyName(option)),
      model: saved.model,
      efforts: saved.efforts,
    };
  }

  /** @returns {Promise<ClaudeSelection>} */
  async function claudeSelection() {
    const choice = store.claude();
    return { model: choice.model, effort: choice.effort, models: await claudeModels() };
  }

  /**
   * The name of a model as people read it.
   * @param {Setup} setup
   * @param {string | null} model
   * @param {ClaudeModelInfo[]} claudeList
   * @returns {string | null}
   */
  function modelNameOf(setup, model, claudeList) {
    if (model === null) return null;
    const option = optionOfSetup(setup);
    if (option === null) return claudeList.find((m) => m.value === model)?.displayName ?? model;
    return store.apiModels(option)?.models.find((m) => m.id === model)?.displayName ?? model;
  }

  /** @param {Setup} setup @returns {{ model: string | null, effort: string | null }} */
  function selectionOf(setup) {
    const option = optionOfSetup(setup);
    if (option === null) {
      const choice = store.claude();
      return { model: choice.model, effort: choice.effort };
    }
    const saved = store.option(option);
    return {
      model: saved.model,
      effort: saved.model ? (saved.efforts[saved.model] ?? null) : null,
    };
  }

  /**
   * What the settings hold for the readiness decision.
   * @param {Setup} setup
   * @returns {{ keySaved: boolean, modelChosen: boolean }}
   */
  function saved(setup) {
    const option = optionOfSetup(setup);
    if (option === null) return { keySaved: true, modelChosen: true };
    return {
      keySaved: savedKey(option) !== null,
      modelChosen: store.option(option).model !== null,
    };
  }

  /** @param {unknown} option @returns {ApiOption} */
  function checkedOption(option) {
    if (!isApiOption(option)) throw invalidInput("That is not one of the API options.");
    return option;
  }

  return {
    currentSetup,
    apiSetup,
    savedKey,

    /** The whole admin screen. @returns {Promise<HarnessAdminState>} */
    async adminState() {
      const setup = currentSetup();
      return {
        setup,
        program: programOf(setup),
        options: {
          opencodeGo: optionState("opencodeGo"),
          anthropicApi: optionState("anthropicApi"),
          openaiApi: optionState("openaiApi"),
        },
        claude: await claudeSelection(),
        claudeRouting: await deps.detectRouting(),
      };
    },

    /**
     * What every signed-in user may see, read-only.
     * @returns {Promise<HarnessPublicView>}
     */
    async publicView() {
      const setup = currentSetup();
      const { model, effort } = selectionOf(setup);
      const list = optionOfSetup(setup) === null ? await claudeModels() : [];
      return {
        setup,
        program: programOf(setup),
        model,
        modelName: modelNameOf(setup, model, list),
        effort,
      };
    },

    /**
     * What a new job on `setup` (default: the selected one) is started with. A job keeps the
     * setup it started in, also for Continue, Re-Edit and timeline changes (SPEC section 8).
     * @param {Setup} [setup]
     * @returns {Launch}
     */
    launchFor(setup = currentSetup()) {
      const option = optionOfSetup(setup);
      const { model, effort } = selectionOf(setup);
      return {
        setup,
        program: programOf(setup),
        option,
        model,
        effort,
        baseUrl: option === null ? null : effectiveBaseUrl(option),
        key: option === null ? null : savedKey(option),
      };
    },

    /** Every saved key, for the job log scrubber. @returns {string[]} */
    secretsToScrub() {
      /** @type {string[]} */
      const keys = [];
      for (const option of API_OPTIONS) {
        const key = savedKey(option);
        if (key !== null && key.trim() !== "") keys.push(key.trim());
      }
      return keys;
    },

    /**
     * Can new edits start on `setup` (default: the selected one)? Looks only at what the setup
     * needs.
     * @param {{ setup?: Setup, audience?: Audience }} [options]
     * @returns {Promise<Readiness>}
     */
    async checkReadiness({ setup = currentSetup(), audience = "admin" } = {}) {
      return readiness.check(setup, saved(setup), { audience });
    },

    /**
     * Throws `notReady` with a sentence when new edits cannot start.
     * @param {{ setup?: Setup, audience?: Audience }} [options]
     * @returns {Promise<void>}
     */
    async ensureReady({ setup = currentSetup(), audience = "user" } = {}) {
      return readiness.ensureReady(setup, saved(setup), { audience });
    },

    /**
     * "Edits run on": the Claude subscription, or an API option (only with a key when it needs
     * one, and a chosen model). New edits use it; running jobs and earlier sessions keep theirs.
     * The program is not checked here: a missing one is a readiness problem.
     * @param {unknown} setup
     * @returns {Promise<void>}
     */
    async setSetup(setup) {
      const known = Object.keys(SETUP_INFO).find((name) => name === setup);
      if (known === undefined) throw invalidInput("That is not one of the four setups.");
      const chosen = /** @type {Setup} */ (known);
      const option = optionOfSetup(chosen);
      if (option !== null) {
        const problem = selectionProblem(apiSetup(option));
        if (problem !== null) throw invalidInput(problem);
      }
      const before = currentSetup();
      settings.update({ setup: chosen });
      await changed(() => {
        if (before !== chosen) {
          usage.reset();
          if (chosen === "opencodeGo") void usage.refresh();
        }
      });
    },

    /**
     * Sets the address of one option (null or empty: its default), normalized by the rules of the
     * option's protocol; one that cannot be used is refused.
     * @param {unknown} option
     * @param {unknown} baseUrl
     * @returns {Promise<void>}
     */
    async setBaseUrl(option, baseUrl) {
      const which = checkedOption(option);
      const normalized = normalizeBaseUrl(which, baseUrl);
      const different = store.option(which).baseUrl !== normalized;
      store.setBaseUrl(which, normalized);
      await changed(() => {
        if (different && which === "opencodeGo") restartUsage();
      });
    },

    /**
     * Saves the key of one option (trimmed, no spaces).
     * @param {unknown} option
     * @param {unknown} key
     * @returns {Promise<void>}
     */
    async setKey(option, key) {
      const which = checkedOption(option);
      secrets.set(keyName(which), normalizeKey(key));
      await changed(() => {
        if (which === "opencodeGo") restartUsage();
      });
    },

    /**
     * Removes the key of one option. While edits run on an option that needs its key (OpenCode
     * Go) they go back to the Claude subscription; the other two work without a key and stay
     * selected.
     * @param {unknown} option
     * @returns {Promise<void>}
     */
    async clearKey(option) {
      const which = checkedOption(option);
      secrets.clear(keyName(which));
      if (keyRequired(which)) fallBackToClaude(which);
      await changed(() => {
        if (which === "opencodeGo") restartUsage();
      });
    },

    /**
     * Chooses the model of one option (null clears it; on the selected option edits then go back
     * to the Claude subscription).
     * @param {unknown} option
     * @param {unknown} model
     * @returns {Promise<void>}
     */
    async setModel(option, model) {
      const which = checkedOption(option);
      const clean =
        model === null || model === undefined || String(model).trim() === ""
          ? null
          : normalizeModelId(model);
      store.setModel(which, clean);
      if (clean === null) fallBackToClaude(which);
      await changed();
    },

    /**
     * Remembers the reasoning effort of one model of one option (null forgets it: the model runs
     * on its own default). Other models keep theirs, so switching back restores each effort.
     * @param {unknown} option
     * @param {unknown} model
     * @param {unknown} effort
     * @returns {Promise<void>}
     */
    async setEffort(option, model, effort) {
      const which = checkedOption(option);
      const id = normalizeModelId(model);
      const clean = effort === null || effort === undefined ? null : checkEffort(effort);
      store.setEffort(which, id, clean);
      await changed();
    },

    /**
     * The model and effort of the Claude subscription. `null` model is Claude Code's own
     * default. When the list of models is known, the effort must be one the model supports.
     * @param {unknown} model
     * @param {unknown} effort
     * @returns {Promise<void>}
     */
    async setClaudeSelection(model, effort) {
      const cleanModel = model === null || model === undefined ? null : normalizeModelId(model);
      const cleanEffort = effort === null || effort === undefined ? null : checkEffort(effort);
      if (cleanEffort !== null) {
        const info = (await claudeModels()).find((m) => m.value === cleanModel);
        if (info !== undefined && !info.effortLevels.includes(cleanEffort)) {
          throw invalidInput(
            info.effortLevels.length === 0
              ? `${info.displayName} has no reasoning effort to choose.`
              : `${info.displayName} supports these reasoning efforts: ${info.effortLevels.join(", ")}.`,
          );
        }
      }
      store.setClaude({ model: cleanModel, effort: cleanEffort });
      await changed();
    },

    /**
     * Claude Code's model list changed: checks the saved model and effort of the Claude
     * subscription against it (`normalizeSelection`), saves the result when it differs and tells
     * the users. A model that is gone falls back to Claude Code's own default, an effort the
     * model does not support to none.
     * @param {import("../../../src/lib/wire/usage.ts").ClaudeInfo} info
     * @returns {Promise<boolean>} Whether the saved selection changed.
     */
    async recheckClaudeSelection(info) {
      const saved = store.claude();
      const next = normalizeSelection(saved, info);
      if (next.model === saved.model && next.effort === saved.effort) return false;
      store.setClaude(next);
      await changed();
      return true;
    },

    /**
     * The models of one option at its address: the kept list unless `refresh`, then live (with the
     * saved key when there is one). Only OpenCode Go keeps the list; for the other options (a
     * typed model, a list fetched on demand) the answer is returned and not kept.
     * @param {unknown} option
     * @param {boolean} refresh
     * @returns {Promise<ApiModels>}
     */
    async apiModels(option, refresh) {
      const which = checkedOption(option);
      const baseUrl = effectiveBaseUrl(which);
      if (!refresh) {
        const kept = store.apiModels(which);
        return kept !== null && kept.baseUrl === baseUrl
          ? { option: which, baseUrl, models: kept.models, fetchedAt: kept.fetchedAt }
          : { option: which, baseUrl, models: [], fetchedAt: null };
      }
      const models = await http.fetchModels(which, baseUrl, savedKey(which));
      const fetchedAt = clock.now();
      if (which === "opencodeGo") store.setApiModels(which, { baseUrl, models, fetchedAt });
      return { option: which, baseUrl, models, fetchedAt };
    },

    /**
     * Sends one tiny request to the option's service and says whether the key, the plan and the
     * model work together.
     * @param {unknown} option
     * @returns {Promise<ApiTest>}
     */
    async testApi(option) {
      const which = checkedOption(option);
      const setup = apiSetup(which);
      // The two compatible APIs work without a key; only OpenCode Go needs one.
      if (setup.key === null && keyRequired(which)) {
        throw invalidInput("No API key is saved for this option. Save a key first.");
      }
      if (setup.model === null) throw invalidInput(noModelText(which));
      const name =
        store.apiModels(which)?.models.find((m) => m.id === setup.model)?.displayName ??
        setup.model;
      return http.testApi(which, setup.baseUrl, setup.key, setup.model, name);
    },
  };
}

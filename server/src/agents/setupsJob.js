// What selecting an API option and launching a job on it need to know (SPEC-desktop section 7a;
// src-tauri/src/opencode/mod.rs `ApiSetup` and `job_env`). Pure functions of plain values.

import { invalidInput } from "../errors.js";
import { NO_KEY_TOKEN, SETUP_INFO, keyRequired, noModelText, setupOfOption } from "./setups.js";

/** @typedef {import("../../../src/lib/wire.ts").Setup} Setup */
/** @typedef {import("../../../src/lib/wire/harness.ts").ApiOption} ApiOption */

/**
 * What is known about one API option right now.
 * @typedef {object} ApiSetup
 * @property {ApiOption} option
 * @property {string | null} key The saved key (never sent to a browser or logged).
 * @property {string} baseUrl The normalized address (the default when the option has none of its own).
 * @property {string | null} model The model chosen in Settings.
 * @property {string[] | null} offered The model ids last fetched for `baseUrl`, null when no list
 *   was fetched for it. Only OpenCode Go keeps a list; the other two take any typed model.
 */

/** The variable of the base environment that is removed when a job has a key. */
const REMOVED_ENV_VAR = "ANTHROPIC_AUTH_TOKEN";

/**
 * The environment changes for a job of Claude Code on an Anthropic compatible API
 * (`anthropicApi`): the address, the key (sent as `x-api-key`), and the model behind each of
 * Claude Code's model aliases, all set to the one chosen model. With a key,
 * `ANTHROPIC_AUTH_TOKEN` is removed so no token ever competes with the key. Without one (the key
 * is optional), `ANTHROPIC_API_KEY` is removed, so a key of the server's own environment never
 * leaks to the service, and `ANTHROPIC_AUTH_TOKEN` is `no-key`, so Claude Code does not use the
 * login of the OS user. Nothing else changes. Every other setup leaves the environment exactly
 * as it is (the Claude subscription must stay the OS user's own; the OpenCode setups build their
 * own run configuration).
 * @param {{ setup: Setup, baseUrl: string, key: string | null, model: string | null }} state
 * @param {Readonly<Record<string, string | undefined>>} baseEnv Not modified.
 * @returns {Record<string, string | undefined>} A new object.
 */
export function jobEnv(state, baseEnv) {
  const env = { ...baseEnv };
  if (state.setup !== "anthropicApi") return env;
  if (!state.model) throw invalidInput(noModelText("anthropicApi"));
  if (state.key) {
    delete env[REMOVED_ENV_VAR];
    env.ANTHROPIC_API_KEY = state.key;
  } else {
    delete env.ANTHROPIC_API_KEY;
    env[REMOVED_ENV_VAR] = NO_KEY_TOKEN;
  }
  env.ANTHROPIC_BASE_URL = state.baseUrl;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = state.model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = state.model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = state.model;
  return env;
}

/** The names `jobEnv` sets, for tests and for scrubbing. */
export const JOB_ENV_VARS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

/**
 * Why a job cannot run on this option with `model`, or null when it can. The model counts as
 * gone only when the last list fetched for this address (OpenCode Go only) does not have it; a
 * model typed for another option is never refused for missing from a list.
 * @param {ApiSetup} setup
 * @param {string | null} model
 * @returns {string | null}
 */
export function problemWith(setup, model) {
  const service = SETUP_INFO[setupOfOption(setup.option)].service;
  if (setup.key === null && keyRequired(setup.option)) {
    return `No API key is saved for ${service}.`;
  }
  if (model === null || model.trim() === "") return `No model is chosen for ${service}.`;
  if (setup.offered !== null && !setup.offered.includes(model)) {
    return `${service} no longer offers the model ${model}.`;
  }
  return null;
}

/**
 * Why this option cannot be selected for new edits, or null when it can: it needs its key
 * (OpenCode Go only) and a chosen model. The program is not checked here: a missing or
 * unsupported program is a readiness problem.
 * @param {ApiSetup} setup
 * @returns {string | null}
 */
export function selectionProblem(setup) {
  const needsKey = setup.key === null && keyRequired(setup.option);
  if (needsKey) {
    return setup.model === null
      ? "Save an API key and choose a model first."
      : "Save an API key first.";
  }
  return setup.model === null ? noModelText(setup.option) : null;
}

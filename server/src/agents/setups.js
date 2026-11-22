// The four setups and their API options (docs/SPEC.md section 5, "Harness, program and model";
// docs/SPEC-desktop.md section 7a, "The four options"): names, addresses, protocols, keys and the
// small checks on what an admin types. Ported from src-tauri/src/opencode/mod.rs and the names
// of src/lib/setup.ts. Pure data and functions; nothing here reads a store or the network.
//
// Split by job: addresses in `setupsUrl.js`, what a job needs in `setupsJob.js`, the per-option
// state in `setupStore.js`.

import { invalidInput } from "../errors.js";
import { SETUPS, forNewJob } from "./harness.js";

/** @typedef {import("../../../src/lib/wire.ts").Setup} Setup */
/** @typedef {import("../../../src/lib/wire/harness.ts").ApiOption} ApiOption */
/** @typedef {"anthropic" | "openai"} Protocol */

/**
 * The three setups with a key, an address, a model and efforts of their own.
 * @type {readonly ApiOption[]}
 */
export const API_OPTIONS = ["opencodeGo", "anthropicApi", "openaiApi"];

/** The default address of `opencodeGo`: an OpenCode Go subscription (Anthropic's form). */
export const GO_BASE_URL = "https://opencode.ai/inference/go/anthropic";
/** The default address of `anthropicApi`. */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
/** The default address of `openaiApi` (OpenAI's form, which keeps its `/v1`). */
export const OPENAI_BASE_URL = "https://opencode.ai/inference/go/v1";
/** The address of OpenCode's pay-as-you-go balance. */
export const PAY_AS_YOU_GO_BASE_URL = "https://opencode.ai/inference/anthropic";
/** Where keys, plans, budgets and usage are managed. */
export const CONSOLE_URL = "https://opencode.ai/console";

/** The reasoning efforts a model of an API option can be given, lowest first. */
export const API_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * What Claude Code is given as its token when `anthropicApi` has no key (a server on this
 * computer often needs none). It is no secret, and a server that needs no key ignores it.
 */
export const NO_KEY_TOKEN = "no-key";

/** Replacement text for an API key in logs. */
export const SCRUBBED = "[api key]";

/**
 * @typedef {object} SetupInfo
 * @property {string} label What Settings and the logs call the setup.
 * @property {string} service The service the model comes from, as the texts say it.
 * @property {ApiOption | null} option The option behind the setup; null for the Claude subscription.
 */

/** @type {Record<Setup, SetupInfo>} */
export const SETUP_INFO = {
  claudeSubscription: {
    label: "Claude Code with Claude Subscription",
    service: "Claude Subscription",
    option: null,
  },
  opencodeGo: {
    label: "OpenCode 2 with OpenCode Go Subscription",
    service: "OpenCode Go",
    option: "opencodeGo",
  },
  anthropicApi: {
    label: "Claude Code with Anthropic Compatible API",
    service: "Anthropic Compatible API",
    option: "anthropicApi",
  },
  openaiApi: {
    label: "OpenCode 2 with OpenAI Compatible API",
    service: "OpenAI Compatible API",
    option: "openaiApi",
  },
};

/** @type {Record<ApiOption, string>} */
const DEFAULT_BASE_URL = {
  opencodeGo: GO_BASE_URL,
  anthropicApi: ANTHROPIC_BASE_URL,
  openaiApi: OPENAI_BASE_URL,
};

/** @type {Record<ApiOption, Protocol>} */
const PROTOCOL = { opencodeGo: "anthropic", anthropicApi: "anthropic", openaiApi: "openai" };

/**
 * The secret names of the keys, one per option (`secrets.js`).
 * @type {Record<ApiOption, string>}
 */
const KEY_NAME = {
  opencodeGo: "opencode-go-api-key",
  anthropicApi: "anthropic-api-key",
  openaiApi: "openai-api-key",
};

/** @param {unknown} value @returns {value is ApiOption} */
export function isApiOption(value) {
  return API_OPTIONS.some((option) => option === value);
}

/** @param {unknown} value @returns {value is Setup} */
export function isSetup(value) {
  return SETUPS.some((setup) => setup === value);
}

/** The API option behind a setup; null for the Claude subscription. @param {Setup} setup */
export function optionOfSetup(setup) {
  return SETUP_INFO[setup].option;
}

/** The setup that selects an API option (the names are the same). @param {ApiOption} option @returns {Setup} */
export function setupOfOption(option) {
  return option;
}

/** The program that does a new edit on a setup. @param {Setup} setup */
export function programOf(setup) {
  return forNewJob(setup);
}

/** The default address of `option` (stored as null). @param {ApiOption} option */
export function defaultBaseUrl(option) {
  return DEFAULT_BASE_URL[option];
}

/** The wire protocol of an option. @param {ApiOption} option @returns {Protocol} */
export function protocolOf(option) {
  return PROTOCOL[option];
}

/** The name of the secret that holds the key of `option`. @param {ApiOption} option */
export function keyName(option) {
  return KEY_NAME[option];
}

/**
 * Whether edits on an API option need a saved key. Only OpenCode Go does; the Anthropic and
 * OpenAI compatible APIs are often a server on the admin's own network that needs none.
 * @param {ApiOption} option
 */
export function keyRequired(option) {
  return option === "opencodeGo";
}

/**
 * What an option without a model says: OpenCode Go's model is chosen from its list, the model
 * of the other two is typed.
 * @param {ApiOption} option
 */
export function noModelText(option) {
  return keyRequired(option) ? "Choose a model first." : "Type a model first.";
}

/**
 * Trims and checks a key typed by the admin.
 * @param {unknown} key
 * @returns {string}
 */
export function normalizeKey(key) {
  const text = typeof key === "string" ? key.trim() : "";
  if (text === "") throw invalidInput("Enter an API key.");
  // eslint-disable-next-line no-control-regex -- a key never contains control characters
  if (/[\s\u0000-\u001f\u007f-\u009f]/u.test(text)) {
    throw invalidInput(
      "An API key has no spaces or line breaks. Copy it again and paste only the key.",
    );
  }
  return text;
}

/**
 * A model id as the settings keep it: trimmed, no spaces or control characters.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeModelId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  // eslint-disable-next-line no-control-regex -- a model id never contains control characters
  if (text === "" || /[\s\u0000-\u001f\u007f-\u009f]/u.test(text)) {
    throw invalidInput("That is not a model id.");
  }
  return text;
}

/**
 * A reasoning effort of an API option.
 * @param {unknown} value
 * @returns {string}
 */
export function checkEffort(value) {
  const found = API_EFFORTS.find((effort) => effort === value);
  if (found === undefined) {
    throw invalidInput(`The reasoning effort must be one of: ${API_EFFORTS.join(", ")}.`);
  }
  return found;
}

/**
 * `text` with the key replaced by `[api key]`.
 * @param {string} text
 * @param {string | null | undefined} key
 */
export function scrubKey(text, key) {
  const trimmed = key?.trim();
  return trimmed ? text.replaceAll(trimmed, SCRUBBED) : text;
}

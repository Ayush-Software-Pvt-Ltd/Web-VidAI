// What one OpenCode 2 server of a job is started with (docs/SPEC.md section 5, "The OpenCode 2
// program"; docs/SPEC-desktop.md section 7a; ported from `launch2.rs`): the command line, the
// environment, the per-run configuration, how VidAI's address and model become OpenCode 2's
// `provider/model`, and the permissions of its session.
//
// The configuration goes in `OPENCODE_CONFIG_CONTENT`, which OpenCode 2 merges over the user's
// own configuration (above every configuration file of the user, below an administrator's managed
// settings), and the key goes in the variable of the option: `OPENCODE_API_KEY` for `opencodeGo`,
// `VIDAI_API_KEY` for `openaiApi`. The only files VidAI makes are inside the job's own folder
// (`jobDir`, an empty private configuration folder), and they are removed with the job.
//
// - The configuration has OpenCode 2's own keys (`providers`, `package`, `settings`,
//   `snapshots`); `{env:<key variable>}` is substituted into it.
// - OpenCode's own providers (`opencode-go`, `opencode`) take their key from a login stored in
//   OpenCode's database first and from `OPENCODE_API_KEY` only without one, and a configured key
//   does not change that. So the server is asked which key a built-in provider would use
//   (`serverApi.js`), and VidAI's own provider `VIDAI_PROVIDER` runs the model whenever it would
//   not be VidAI's key.
// - `openaiApi` never uses OpenCode's own providers: `VIDAI_PROVIDER` runs it with the package
//   `@ai-sdk/openai-compatible` at the address as given and the key in `VIDAI_API_KEY`.
// - OpenCode 2 does not read `CLAUDE.md`; the Editing Folder's `CLAUDE.md` and the user's
//   `~/.claude/CLAUDE.md` are named as instructions, like Claude Code reads them.
// - The server runs with `--stdio`: it picks a free port itself, prints its address as one JSON
//   line, ends when its stdin closes (also when VidAI itself ends) and keeps its password out of
//   the environment of the commands it runs.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import {
  instructionFiles,
  privateConfigDir,
  userHome,
  withoutVars,
} from "../../platform/opencodeLaunch.js";
import { GO_BASE_URL, OPENAI_BASE_URL, PAY_AS_YOU_GO_BASE_URL } from "../setups.js";

/** @typedef {import("../../../../src/lib/wire/harness.ts").ApiOption} ApiOption */
/** @typedef {Readonly<Record<string, string | undefined>>} Env */

/** The only address a job's server listens on. */
export const HOST = "127.0.0.1";
/** The variable that carries the key of `opencodeGo` (OpenCode's own name for its providers' key). */
export const KEY_VAR = "OPENCODE_API_KEY";
/** The variable that carries the key of `openaiApi` (read only through VidAI's own provider). */
export const OPENAI_KEY_VAR = "VIDAI_API_KEY";
/** The variable that carries the per-run configuration. */
export const CONFIG_VAR = "OPENCODE_CONFIG_CONTENT";
/** The variable that carries the per-run server password (HTTP basic auth, user `opencode`). */
export const PASSWORD_VAR = "OPENCODE_SERVER_PASSWORD";
/** The user name OpenCode expects with the password (its default). */
export const USERNAME = "opencode";
/** OpenCode's provider for a Go subscription. */
export const GO_PROVIDER = "opencode-go";
/** OpenCode's provider for the pay-as-you-go balance (OpenCode Zen). */
export const ZEN_PROVIDER = "opencode";
/**
 * The provider VidAI defines in the per-run configuration for its address: for `opencodeGo`
 * Anthropic's API at the address, the same way Claude Code reaches it (used for any other
 * address, and for a model OpenCode's own catalog does not list yet); for `openaiApi` an OpenAI
 * compatible API at the address, always.
 */
export const VIDAI_PROVIDER = "vidai";

/**
 * Variables of the server's environment that would change how VidAI talks to the OpenCode server
 * or which key and configuration a run uses, removed before VidAI sets its own: both password
 * variables (`OPENCODE_PASSWORD` wins over `OPENCODE_SERVER_PASSWORD`), another configuration or
 * key, and feature flags that change how a turn runs.
 */
export const REMOVED_VARS = [
  // A Claude gateway of the server's shell is not the address VidAI configures for the job.
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENCODE_PASSWORD",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_API_KEY",
  "VIDAI_API_KEY",
  "OPENCODE_FLAGS",
];

/** Switches that keep a job's server to itself: no self-update. */
export const FIXED_VARS = /** @type {const} */ ([["OPENCODE_DISABLE_AUTOUPDATE", "1"]]);

/**
 * The test switch of the real smoke scenario: with `VIDAI_E2E_OPENCODE_LOGIN` set to `own` or
 * `public`, a job's server on `opencodeGo` gets no key from VidAI and runs on the OpenCode
 * program's own login (`own`) or, ignoring that login without reading it, on OpenCode's public
 * free tier (`public`). Only a server started with `NODE_ENV=test` ever reads it, and `openaiApi`
 * ignores it, so a normal run always passes VidAI's own key.
 */
export const TEST_LOGIN_VAR = "VIDAI_E2E_OPENCODE_LOGIN";

/**
 * Whether a test login is asked for `option`.
 * @param {ApiOption} option
 * @param {Env} env The server's own environment.
 * @returns {boolean}
 */
export function testLoginRequested(option, env) {
  const value = env[TEST_LOGIN_VAR];
  return (
    env["NODE_ENV"] === "test" && option === "opencodeGo" && (value === "own" || value === "public")
  );
}

/**
 * The variable that carries the key of `option`.
 * @param {ApiOption} option
 * @returns {string}
 */
export function keyVar(option) {
  return option === "openaiApi" ? OPENAI_KEY_VAR : KEY_VAR;
}

/**
 * The AI SDK package VidAI's own provider uses for `option`.
 * @param {ApiOption} option
 * @returns {string}
 */
export function packageOf(option) {
  return option === "openaiApi" ? "@ai-sdk/openai-compatible" : "@ai-sdk/anthropic";
}

/**
 * A model as OpenCode 2 names it in a session.
 * @typedef {object} ModelRef
 * @property {string} providerId
 * @property {string} modelId
 */

/**
 * @param {string} providerId
 * @param {string} modelId
 * @returns {ModelRef}
 */
export function modelRef(providerId, modelId) {
  return { providerId, modelId };
}

/**
 * The model through VidAI's own provider (see `VIDAI_PROVIDER`).
 * @param {string} modelId
 * @returns {ModelRef}
 */
export function customModel(modelId) {
  return modelRef(VIDAI_PROVIDER, modelId);
}

/**
 * A model as OpenCode names it: `<provider>/<model>`.
 * @param {ModelRef} model
 * @returns {string}
 */
export function modelText(model) {
  return `${model.providerId}/${model.modelId}`;
}

/**
 * A model as a session carries it (`{providerID, id}`, plus the `variant` that carries the
 * reasoning effort when there is one).
 * @param {ModelRef} model
 * @param {string | null} variant
 * @returns {{ providerID: string, id: string, variant?: string }}
 */
export function modelJson(model, variant) {
  const json = { providerID: model.providerId, id: model.modelId };
  return variant === null ? json : { ...json, variant };
}

/**
 * How a VidAI model choice (an address and a model id) is run by OpenCode: by one of OpenCode's
 * own providers, which know each model's protocol and price, or by `VIDAI_PROVIDER`.
 * @typedef {{ kind: "builtin", provider: string } | { kind: "custom" }} Route
 */

/**
 * The route of a normalized address of `option` (`null` is the default address of `opencodeGo`).
 * `openaiApi` is always custom: whatever its address, none of OpenCode's own providers runs it.
 * @param {ApiOption} option
 * @param {string | null} baseUrl
 * @returns {Route}
 */
export function route(option, baseUrl) {
  if (option === "openaiApi") return { kind: "custom" };
  switch (baseUrl ?? GO_BASE_URL) {
    case GO_BASE_URL:
      return { kind: "builtin", provider: GO_PROVIDER };
    case PAY_AS_YOU_GO_BASE_URL:
      return { kind: "builtin", provider: ZEN_PROVIDER };
    default:
      return { kind: "custom" };
  }
}

/**
 * The model to ask for first; `customModel` is the fallback when the built-in provider does not
 * list the model.
 * @param {Route} how
 * @param {string} modelId
 * @returns {ModelRef}
 */
export function routedModel(how, modelId) {
  return how.kind === "builtin" ? modelRef(how.provider, modelId) : customModel(modelId);
}

/**
 * The model variant that carries a reasoning `effort`: the effort itself when the model offers a
 * variant of that name (`offered`, from the server's catalog; `null` when it could not be read),
 * otherwise the sentence for the log that says the model runs on its default. OpenCode names the
 * variants of a model after the efforts it accepts, and refuses or ignores any other name, so an
 * effort the model lacks is never passed on.
 * @param {ModelRef} model
 * @param {string} effort
 * @param {readonly string[] | null} offered
 * @returns {{ variant: string, note: null } | { variant: null, note: string }}
 */
export function variantForEffort(model, effort, offered) {
  const id = model.modelId;
  if (offered?.includes(effort)) return { variant: effort, note: null };
  if (offered === null) {
    return {
      variant: null,
      note: `The reasoning levels of ${id} could not be read, so the effort ${effort} is not used.`,
    };
  }
  if (offered.length === 0) {
    return {
      variant: null,
      note: `${id} has no reasoning effort levels, so the effort ${effort} is not used.`,
    };
  }
  return {
    variant: null,
    note: `${id} does not offer the reasoning effort ${effort} (it offers ${offered.join(", ")}), so it runs on its default.`,
  };
}

/**
 * A fresh password for one server (128 random bits).
 * @returns {string}
 */
export function newPassword() {
  return randomBytes(16).toString("hex");
}

/**
 * The per-run configuration (`OPENCODE_CONFIG_CONTENT`): no sharing, no snapshots of the Editing
 * Folder (it holds gigabytes of footage), no language servers or formatters, the instructions of
 * `CLAUDE.md`, and VidAI's own provider for the address and model: for `opencodeGo` Anthropic's
 * API at `<address>/v1` with the key, the way Claude Code reaches it; for `openaiApi` the package
 * `@ai-sdk/openai-compatible` with `baseURL` the address as given (it already ends in `/v1`). The
 * key is always `{env:<key variable>}`, never its value. Built-in providers need nothing here:
 * `OPENCODE_API_KEY` is their key. Permissions are not here: they belong to the session
 * (`sessionPermissions`), which OpenCode 2 applies after every configured rule.
 * @param {object} options
 * @param {ApiOption} options.option
 * @param {string | null} options.baseUrl
 * @param {string} options.modelId
 * @param {string} options.editingFolder
 * @param {string | null} options.home
 * @param {NodeJS.Platform} [options.platform]
 * @returns {Record<string, unknown>}
 */
export function runConfig({ option, baseUrl, modelId, editingFolder, home, platform }) {
  const openai = option === "openaiApi";
  return {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    snapshots: false,
    lsp: false,
    formatter: false,
    instructions: instructionFiles(editingFolder, home, platform),
    providers: {
      [VIDAI_PROVIDER]: {
        name: openai ? "OpenAI Compatible API (VidAI)" : "OpenCode (VidAI)",
        package: packageOf(option),
        settings: {
          baseURL: openai ? (baseUrl ?? OPENAI_BASE_URL) : `${baseUrl ?? GO_BASE_URL}/v1`,
          apiKey: `{env:${keyVar(option)}}`,
        },
        models: { [modelId]: { name: modelId } },
      },
    },
  };
}

/**
 * The permission rules of a job's session: everything is allowed (the Claude Code jobs run with
 * every permission bypassed and the OpenCode ones are meant to behave the same), and the question
 * tool, which would wait for a person, is denied, which removes it. The last matching rule
 * decides, and a session's rules come after the agent's and every configured rule. (OpenCode 2
 * has no plan mode tools.)
 * @returns {Array<{ action: string, resource: string, effect: "allow" | "deny" }>}
 */
export function sessionPermissions() {
  return [
    { action: "*", resource: "*", effect: "allow" },
    { action: "question", resource: "*", effect: "deny" },
  ];
}

/**
 * The complete environment of a job's server: `base` without `REMOVED_VARS`, plus the key (in the
 * variable of `option`; none without one), the password, the configuration and `FIXED_VARS`.
 * @param {object} options
 * @param {ApiOption} options.option
 * @param {Env} options.base
 * @param {string | null} options.key
 * @param {string} options.password
 * @param {unknown} options.config
 * @param {NodeJS.Platform} [options.platform]
 * @returns {Record<string, string>}
 */
export function serverEnv({ option, base, key, password, config, platform }) {
  const env = withoutVars(base, REMOVED_VARS, platform);
  for (const [name, value] of FIXED_VARS) env[name] = value;
  if (key !== null) env[keyVar(option)] = key;
  env[PASSWORD_VAR] = password;
  env[CONFIG_VAR] = JSON.stringify(config);
  return env;
}

/**
 * The run configuration without VidAI's key (in place): the test login, and an option whose key
 * is optional and not saved (`openaiApi` on a server that needs none, which then gets no
 * `Authorization` header). OpenCode 2.2.6 refuses `apiKey: false` ("Expected JSON value"), so the
 * key is left out.
 * @param {Record<string, unknown>} config
 */
export function withoutKey(config) {
  const providers = config["providers"];
  if (typeof providers !== "object" || providers === null) return;
  for (const provider of Object.values(providers)) {
    const settings = /** @type {{ settings?: unknown }} */ (provider).settings;
    if (typeof settings === "object" && settings !== null) {
      delete (/** @type {Record<string, unknown>} */ (settings)["apiKey"]);
    }
  }
}

/**
 * The environment of `serverEnv` for a test login (in place): no key, also not the server's own
 * Anthropic key, which VidAI's provider would send without a key of its own. OpenCode 2 then runs
 * on the program's own login, or without one on OpenCode's public free tier (it has no way to
 * ignore a stored login, so `public` and `own` start the same server).
 * @param {Record<string, string>} env
 */
export function applyTestLogin(env) {
  delete env[KEY_VAR];
  delete env["ANTHROPIC_API_KEY"];
}

/**
 * `serve --stdio --hostname 127.0.0.1 --port 0`: the server picks a free port on this computer
 * and prints `{"url":"http://127.0.0.1:<port>"}` (OpenCode's own default would be 4096 and up,
 * where the admin's own server may listen), and it ends when its stdin closes.
 * @returns {string[]}
 */
export function serverArgs() {
  return ["serve", "--stdio", "--hostname", HOST, "--port", "0"];
}

/**
 * The address in the first line the server prints with `--stdio` (`{"url":"..."}`); the line of
 * a server without `--stdio` (`server listening on http://...`) is understood too.
 * @param {string} line
 * @returns {string | null}
 */
export function listeningUrl(line) {
  try {
    const value = /** @type {unknown} */ (JSON.parse(line));
    const url = /** @type {{ url?: unknown } | null} */ (value)?.url;
    if (typeof url === "string" && url.startsWith("http://")) return url.replace(/\/+$/, "");
  } catch {
    // Not JSON: the plain form below.
  }
  const rest = line.split("server listening on http://")[1]?.trim();
  if (rest === undefined || rest === "") return null;
  return `http://${rest.split(/\s+/)[0]}`;
}

/**
 * Keeps the user's own OpenCode configuration out of a job's server (their MCP servers, plugins,
 * agents and commands). OpenCode 2 takes its global config folder from `OPENCODE_CONFIG_DIR` when
 * that is set, so an empty private folder of VidAI's replaces the user's, and the Editing
 * Folder's own project configuration is not read. Best effort: when the folder cannot be made the
 * job runs as before (the project configuration is still switched off).
 * @param {Record<string, string>} env Changed in place.
 * @param {string} jobDir
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean} Whether the private folder was made.
 */
export function isolateUserConfig(env, jobDir, platform) {
  env["OPENCODE_CONFIG_PROJECT_DISABLE"] = "1";
  const dir = privateConfigDir(jobDir, platform);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return false;
  }
  env["OPENCODE_CONFIG_DIR"] = dir;
  return true;
}

/**
 * Removes what a job's server left in its own folder (the private configuration folder, then the
 * job folder when nothing else is in it). Never throws.
 * @param {string} jobDir
 * @param {NodeJS.Platform} [platform]
 */
export function removeJobFiles(jobDir, platform) {
  try {
    fs.rmSync(privateConfigDir(jobDir, platform), { recursive: true, force: true });
    fs.rmdirSync(jobDir);
  } catch {
    // The folder is not empty (the caller keeps other files in it) or already gone.
  }
}

/**
 * What a job's OpenCode server needs to start.
 * @typedef {object} Launch
 * @property {{ program: string, args: string[], cwd: string, env: Record<string, string> }} command
 *   `env` is the complete environment of the server process.
 * @property {string} password The per-run password (also in `command.env`).
 * @property {string} directory The folder the session works in (the Editing Folder).
 * @property {ModelRef} model The model to ask for first (`route`).
 * @property {string | null} effort
 * @property {boolean} testLogin
 * @property {Record<string, unknown>} config The per-run configuration (without any key value).
 */

/**
 * The server of one job: `baseEnv` is the environment of the job (the server's own, minus its
 * admin variables), `baseUrl` the normalized address (`null`: the default).
 * @param {object} options
 * @param {string} options.program The `opencode2` program.
 * @param {string} options.editingFolder The server's working directory and the session's folder.
 * @param {Env} options.baseEnv
 * @param {ApiOption} options.option
 * @param {string | null} options.key `null` when the option's key is optional and not saved.
 * @param {string | null} options.baseUrl
 * @param {string} options.modelId
 * @param {string | null} options.effort
 * @param {string} options.jobDir Where the job's own files go (made here, removed with
 *   `removeJobFiles`).
 * @param {boolean} [options.testLogin]
 * @param {NodeJS.Platform} [options.platform]
 * @returns {Launch}
 */
export function buildLaunch(options) {
  const { option, baseEnv, platform } = options;
  const key = options.key?.trim() ? options.key.trim() : null;
  const password = newPassword();
  const config = runConfig({
    option,
    baseUrl: options.baseUrl,
    modelId: options.modelId,
    editingFolder: options.editingFolder,
    home: userHome(baseEnv, platform),
    platform,
  });
  const testLogin = options.testLogin === true && option === "opencodeGo";
  if (testLogin || key === null) withoutKey(config);
  const env = serverEnv({ option, base: baseEnv, key, password, config, platform });
  isolateUserConfig(env, options.jobDir, platform);
  if (testLogin) applyTestLogin(env);
  return {
    command: {
      program: options.program,
      args: serverArgs(),
      cwd: options.editingFolder,
      env,
    },
    password,
    directory: options.editingFolder,
    model: routedModel(route(option, options.baseUrl), options.modelId),
    effort: options.effort,
    testLogin,
    config,
  };
}

/**
 * Seed of the harness area: the models Claude Code offers, the plaintext keys the wire never
 * carries (kept in a per-world "sim", because the wire holds only `saved` and the last 4
 * characters), the scenario patches (`setup-*`, `claude-routed`) and the one place that keeps the
 * public harness, the settings' setup and the readiness in step with `world.harness`.
 */
import { SETUP_INFO, optionOfSetup, programOf } from "../../setup";
import type { ApiOption, ClaudeModelInfo, Readiness, ReadinessProblem, Setup } from "../../types";
import type { World } from "../world";
import { GO_MODELS } from "./apiModels";

/** What the mock keeps beside `world.harness` (the keys, and switches for tests and scenarios). */
export interface HarnessSim {
  /** The saved key of each option (the server keeps it encrypted; the wire shows the last 4). */
  keys: Record<ApiOption, string | null>;
  /** Every model list request fails (in addition to addresses with `fail` in them). */
  modelsFail: boolean;
  /** A refresh of a list takes this long (ticks are not used: the call waits), so loading shows. */
  modelsDelayMs: number;
  /** The server's Claude Code is not logged in (while true and Claude subscription is selected). */
  claudeLoggedOut: boolean | null;
}

const sims = new WeakMap<World, HarnessSim>();

/** The sim of a world (created on first use). */
export function harnessSim(world: World): HarnessSim {
  let sim = sims.get(world);
  if (sim === undefined) {
    sim = {
      keys: { opencodeGo: null, anthropicApi: null, openaiApi: null },
      modelsFail: false,
      modelsDelayMs: 0,
      claudeLoggedOut: null,
    };
    sims.set(world, sim);
  }
  return sim;
}

export const SAMPLE_OPENCODE_KEY = "oc_sk_live_4f1c8a2be9d07c3a";
export const SAMPLE_ANTHROPIC_KEY = "sk-ant-api03-7d2e91c0aa4b5f38";
export const SAMPLE_OPENAI_KEY = "sk-live-93b6e0d1c47a2f58";
export const SAMPLE_OPENCODE_MODEL = "glm-5.3";
export const SAMPLE_ANTHROPIC_MODEL = "claude-sonnet-5-5";
export const SAMPLE_OPENAI_MODEL = "gpt-5.3";

/** A model the OpenCode Go list no longer has (scenario `setup-model-gone`). */
export const GONE_MODEL = "glm-4.9-retired";

/** The models Claude Code lists for the server's subscription. */
export const CLAUDE_MODELS: readonly ClaudeModelInfo[] = [
  {
    value: "claude-opus-5-5",
    displayName: "Opus 5.5",
    description: "The most capable model, for hard edits",
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "claude-sonnet-5-5",
    displayName: "Sonnet 5.5",
    description: "Balanced speed and quality",
    effortLevels: ["low", "medium", "high"],
  },
  {
    value: "claude-haiku-5-5",
    displayName: "Haiku 5.5",
    description: "The fastest model",
    effortLevels: [],
  },
];

/** What the wire shows of a key: whether it is saved and its last 4 characters. */
export function keyStatus(key: string | null): { saved: boolean; last4: string | null } {
  if (key === null) return { saved: false, last4: null };
  return { saved: true, last4: key.length >= 8 ? key.slice(-4) : null };
}

const FIX = {
  admin: { settings: "Fix it in Admin, Harness and Model.", system: "See Admin, System." },
  user: { settings: "Ask an admin to fix it.", system: "Ask an admin to fix it." },
} as const;

/** The sentences of `server/src/agents/readiness.js` for the problems the mock can have. */
function readinessMessage(
  setup: Setup,
  problem: ReadinessProblem,
  audience: "admin" | "user",
): string {
  const service = SETUP_INFO[setup].service;
  const fix = FIX[audience];
  switch (problem) {
    case "apiKeyMissing":
      return `No API key is saved for ${service}. Edits are set to run on it. ${fix.settings}`;
    case "apiModelMissing":
      return `No model is chosen for ${service}. Edits are set to run on it. ${fix.settings}`;
    case "claudeMissing":
      return `Claude Code is not installed on the computer that runs VidAI. ${fix.system}`;
    case "claudeLoggedOut":
      return `Claude Code is not logged in on the computer that runs VidAI. ${
        audience === "admin" ? "Run claude once in a terminal there and sign in." : fix.system
      }`;
    case "programMissing":
    case "programUnsupported":
      return `OpenCode 2 is not installed on the computer that runs VidAI. Edits are set to run with OpenCode 2. ${fix.system}`;
    case "notPrepared":
      return `The computer that runs VidAI is not prepared for edits yet. ${
        audience === "admin" ? "Press Prepare in Admin, System." : fix.system
      }`;
    case "gitBashMissing":
      return `Claude Code needs Git for Windows (Git Bash) on the computer that runs VidAI. ${fix.system}`;
  }
}

function readinessOf(
  setup: Setup,
  problem: ReadinessProblem | null,
  audience: "admin" | "user",
): Readiness {
  return {
    problem,
    message: problem === null ? null : readinessMessage(setup, problem, audience),
  };
}

/** The first thing that blocks new edits on the current setup (the decision of the server). */
function problemOf(world: World): ReadinessProblem | null {
  const sim = harnessSim(world);
  const { setup, options } = world.harness;
  const option = optionOfSetup(setup);
  if (option !== null) {
    const state = options[option];
    if (state.keyRequired && !state.key.saved) return "apiKeyMissing";
    if (state.model === null) return "apiModelMissing";
  }
  const found = (id: string) => world.system.programs.find((p) => p.id === id);
  if (programOf(setup) === "claudeCode") {
    if (found("claude")?.found === false) return "claudeMissing";
    // Remembered from the scenario's readiness the first time a setup changes.
    sim.claudeLoggedOut ??= world.readinessAdmin.problem === "claudeLoggedOut";
    if (sim.claudeLoggedOut && setup === "claudeSubscription") return "claudeLoggedOut";
  } else if (found("opencode")?.found === false) {
    return "programMissing";
  }
  return world.system.prepare.editReady ? null : "notPrepared";
}

/**
 * Brings what depends on `world.harness` in step: the settings' setup, the public view every user
 * reads, and the readiness of an admin and of a user.
 */
export function syncHarness(world: World): void {
  const { setup, program, claude, options } = world.harness;
  const option = optionOfSetup(setup);
  let model: string | null;
  let effort: string | null;
  let modelName: string | null;
  if (option === null) {
    model = claude.model;
    effort = claude.effort;
    modelName = claude.models.find((m) => m.value === model)?.displayName ?? model;
  } else {
    model = options[option].model;
    effort = model === null ? null : (options[option].efforts[model] ?? null);
    modelName = world.apiModels[option]?.models.find((m) => m.id === model)?.displayName ?? model;
  }
  world.adminSettings.setup = setup;
  world.harnessPublic = { setup, program, model, modelName, effort };
  const problem = problemOf(world);
  world.readinessAdmin = readinessOf(setup, problem, "admin");
  world.readinessUser = readinessOf(setup, problem, "user");
}

/** Saves a key as the server does: the plaintext in the sim, only the status on the wire. */
export function putKey(world: World, option: ApiOption, key: string | null): void {
  harnessSim(world).keys[option] = key;
  world.harness.options[option].key = keyStatus(key);
}

/** Chooses the model of an option (and an effort for it, when given). */
function putModel(world: World, option: ApiOption, model: string, effort?: string): void {
  const state = world.harness.options[option];
  state.model = model;
  if (effort !== undefined) state.efforts[model] = effort;
}

/** The kept OpenCode Go list (only that list is kept, at its address). */
export function keepGoModels(world: World, now: number): void {
  world.apiModels.opencodeGo = {
    option: "opencodeGo",
    baseUrl: world.harness.options.opencodeGo.effectiveBaseUrl,
    models: GO_MODELS.map((m) => ({ ...m })),
    fetchedAt: now,
  };
}

export function seedHarness(world: World, _now: number): void {
  world.harness.claude.models = CLAUDE_MODELS.map((m) => ({
    ...m,
    effortLevels: [...m.effortLevels],
  }));
  // No `syncHarness` here: the public view and the readiness of the empty world are right, and
  // the readiness must stay untouched for the scenario that sets it (`not-ready`).
}

function select(world: World, setup: Setup): void {
  world.harness.setup = setup;
  world.harness.program = programOf(setup);
  syncHarness(world);
}

/** Scenario `setup-ready`: the Claude subscription with a chosen model and effort. */
export function setupReady(world: World): void {
  world.harness.claude.model = "claude-sonnet-5-5";
  world.harness.claude.effort = "high";
  syncHarness(world);
}

/** Scenario `setup-opencode-go`: OpenCode Go with its key, its list and a chosen model. */
export function setupOpencodeGo(world: World): void {
  putKey(world, "opencodeGo", SAMPLE_OPENCODE_KEY);
  keepGoModels(world, Date.now());
  putModel(world, "opencodeGo", SAMPLE_OPENCODE_MODEL, "high");
  select(world, "opencodeGo");
}

/** Scenario `setup-anthropic-api`: an Anthropic compatible API with a key and a typed model. */
export function setupAnthropicApi(world: World): void {
  putKey(world, "anthropicApi", SAMPLE_ANTHROPIC_KEY);
  putModel(world, "anthropicApi", SAMPLE_ANTHROPIC_MODEL, "medium");
  select(world, "anthropicApi");
}

/** Scenario `setup-openai-api`: an OpenAI compatible API on this computer, without a key. */
export function setupOpenaiApi(world: World): void {
  const option = world.harness.options.openaiApi;
  option.baseUrl = "http://localhost:8080/v1";
  option.effectiveBaseUrl = "http://localhost:8080/v1";
  putModel(world, "openaiApi", SAMPLE_OPENAI_MODEL);
  select(world, "openaiApi");
}

/** Scenario `setup-model-gone`: the chosen model is no longer in OpenCode Go's list. */
export function setupModelGone(world: World): void {
  setupOpencodeGo(world);
  putModel(world, "opencodeGo", GONE_MODEL);
  syncHarness(world);
}

/** Scenario `setup-models-fail`: every model list request fails. */
export function setupModelsFail(world: World): void {
  harnessSim(world).modelsFail = true;
}

/** Scenario `claude-routed`: the server's Claude Code is already pointed at another service. */
export function claudeRouted(world: World): void {
  world.harness.claudeRouting = { baseUrl: "https://gateway.example.com", source: "environment" };
}

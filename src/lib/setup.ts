/**
 * The four ways edits can run (SPEC section 5, "Harness, program and model") as the UI needs to
 * know them: labels, the program and the service of each, the API options with their default
 * addresses, efforts and links. The rules (what is allowed, what is ready) stay on the server;
 * this module only names things, in step with `server/src/agents/setups.js`.
 */
import type { ApiOption, HarnessProgram, Setup } from "./types";

/** The four setups in the order Settings and the onboarding list them. */
export const SETUPS: readonly Setup[] = [
  "claudeSubscription",
  "opencodeGo",
  "anthropicApi",
  "openaiApi",
];

/** The three setups that have a key, an address, a model and efforts of their own. */
export const API_OPTIONS: readonly ApiOption[] = ["opencodeGo", "anthropicApi", "openaiApi"];

export interface SetupInfo {
  /** The label Settings, the onboarding and the logs use. */
  label: string;
  /** The service the model comes from, as the log says it ("on OpenCode Go"). */
  service: string;
  /** The program that does a new edit on this setup. */
  program: HarnessProgram;
  /** The program as the UI names it. */
  programName: "Claude Code" | "OpenCode 2";
  /** The option behind the setup; `null` for the Claude subscription. */
  option: ApiOption | null;
  /** One line for the radio cards of the onboarding and Settings. */
  line: string;
}

export const SETUP_INFO: Record<Setup, SetupInfo> = {
  claudeSubscription: {
    label: "Claude Code with Claude Subscription",
    service: "Claude Subscription",
    program: "claudeCode",
    programName: "Claude Code",
    option: null,
    line: "Uses your own Claude login. The model and effort are chosen in the top bar.",
  },
  opencodeGo: {
    label: "OpenCode 2 with OpenCode Go Subscription",
    service: "OpenCode Go",
    program: "opencode2",
    programName: "OpenCode 2",
    option: "opencodeGo",
    line: "Uses your OpenCode Go subscription and its API key.",
  },
  anthropicApi: {
    label: "Claude Code with Anthropic Compatible API",
    service: "Anthropic Compatible API",
    program: "claudeCode",
    programName: "Claude Code",
    option: "anthropicApi",
    line: "Uses any Anthropic Compatible API, with a key only if it needs one, without a Claude login.",
  },
  openaiApi: {
    label: "OpenCode 2 with OpenAI Compatible API",
    service: "OpenAI Compatible API",
    program: "opencode2",
    programName: "OpenCode 2",
    option: "openaiApi",
    line: "Uses any OpenAI Compatible API, with a key only if it needs one.",
  },
};

/**
 * Whether edits on an API option need a saved key (the server says it too, `ApiOptionState`).
 * Only OpenCode Go does; the Anthropic and OpenAI compatible APIs are often a server on the
 * admin's own network that needs none.
 */
export function keyRequired(option: ApiOption): boolean {
  return option === "opencodeGo";
}

/** What an option without a model says: OpenCode Go's model is chosen from its list, the model of the
 * two compatible APIs is typed. */
export function noModelText(option: ApiOption): string {
  return keyRequired(option) ? "Choose a model first." : "Type a model first.";
}

/** The setup that selects an API option. */
export function setupOfOption(option: ApiOption): Setup {
  return option;
}

/** The API option behind a setup; `null` for the Claude subscription. */
export function optionOfSetup(setup: Setup): ApiOption | null {
  return setup === "claudeSubscription" ? null : setup;
}

/** The program that does a new edit on a setup. */
export function programOf(setup: Setup): HarnessProgram {
  return SETUP_INFO[setup].program;
}

/** The default address of each option, stored as `null` (the server says it too, `defaultBaseUrl`). */
export const API_DEFAULT_BASE_URL: Record<ApiOption, string> = {
  opencodeGo: "https://opencode.ai/inference/go/anthropic",
  anthropicApi: "https://api.anthropic.com",
  openaiApi: "https://opencode.ai/inference/go/v1",
};

/** The wire protocol of an option: the Anthropic Messages API or the OpenAI chat completions API. */
export type ApiProtocol = "anthropic" | "openai";

export const API_PROTOCOL: Record<ApiOption, ApiProtocol> = {
  opencodeGo: "anthropic",
  anthropicApi: "anthropic",
  openaiApi: "openai",
};

/** The reasoning efforts a model of an API option can be given, lowest first. */
export const API_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** The OpenCode console, where keys, plans, budgets and usage are managed. */
export const OPENCODE_CONSOLE_URL = "https://opencode.ai/console";

/** Whether an address is an OpenCode Go address (it has a Go quota): `.../go/anthropic` or `.../go/v1`. */
export function isGoAddress(baseUrl: string): boolean {
  return /\/go\/(anthropic|v1)$/i.test(baseUrl);
}

/** Whether an address belongs to OpenCode itself (its error wording names OpenCode). */
export function isOpencodeHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "opencode.ai" || host.endsWith(".opencode.ai");
  } catch {
    return false;
  }
}

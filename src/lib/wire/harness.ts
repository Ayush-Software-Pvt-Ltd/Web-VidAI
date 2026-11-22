// Wire types of the harness area (docs/SPEC.md section 5, "Harness, program and model"): the
// four setups' admin screen, what a user may see of it, and the readiness of a launch. Pure
// declarations; every field is always present (`null` when empty). Times are milliseconds since
// 1970, like everywhere else on this wire.

import type { Setup } from "../wire.ts";

/** The setups that have an address, a key, a model and efforts of their own. */
export type ApiOption = "opencodeGo" | "anthropicApi" | "openaiApi";

/** The program that does an edit: Claude Code or OpenCode 2 (`opencode2`). */
export type HarnessProgram = "claudeCode" | "opencode2";

/** What the UI may know about the saved key of one API option; the key itself never leaves the server. */
export interface ApiKeyStatus {
  saved: boolean;
  /** The last 4 characters; `null` when nothing is saved or the key is too short to show any. */
  last4: string | null;
}

/** One API option as the admin screen shows it. The key is only its status. */
export interface ApiOptionState {
  /** The normalized address; `null` is the default address of the option. */
  baseUrl: string | null;
  /** The address requests use: `baseUrl` or `defaultBaseUrl`. */
  effectiveBaseUrl: string;
  defaultBaseUrl: string;
  /** Only OpenCode Go needs a key; the other two work without (SPEC section 5). */
  keyRequired: boolean;
  key: ApiKeyStatus;
  /** The model id every edit on this option uses; `null` until one is chosen. */
  model: string | null;
  /** Reasoning effort per model id: one of `low`, `medium`, `high`, `xhigh`, `max`. */
  efforts: Record<string, string>;
}

/** One model Claude Code offers, as the provider of the Claude model list reports it. */
export interface ClaudeModelInfo {
  /** What is passed to `--model`. */
  value: string;
  displayName: string;
  description: string;
  /** The reasoning efforts the model supports, lowest first; empty when none. */
  effortLevels: string[];
}

/** The model choice of `claudeSubscription` (it has no address or key). */
export interface ClaudeSelection {
  /** `null` is Claude Code's own default. */
  model: string | null;
  /** `null` sends nothing. */
  effort: string | null;
  /** Empty until the Claude model list is available. */
  models: ClaudeModelInfo[];
}

/** Where the server's own Claude Code setup already points `ANTHROPIC_BASE_URL` (SPEC section 5). */
export interface ClaudeRouting {
  baseUrl: string;
  /** `environment`: the server's environment; `claudeSettings`: the `env` of Claude Code's settings file. */
  source: "environment" | "claudeSettings";
}

/** What `adminGetHarness` and every harness setter answer: the whole screen. */
export interface HarnessAdminState {
  setup: Setup;
  program: HarnessProgram;
  options: Record<ApiOption, ApiOptionState>;
  claude: ClaudeSelection;
  /** Non-null: option 1 does not mean what it says on this server. */
  claudeRouting: ClaudeRouting | null;
}

/**
 * What every signed-in user may see, read-only, and the payload of `settings-changed` events
 * that concern the harness.
 */
export interface HarnessPublicView {
  setup: Setup;
  program: HarnessProgram;
  /** The model id in use; `null` is Claude Code's own default (Claude subscription only). */
  model: string | null;
  /** The model as people read it (the display name when the list names it, else the id). */
  modelName: string | null;
  /** The reasoning effort, or `null` for the model's default. */
  effort: string | null;
}

/** One model an API option offers at its address. */
export interface ApiModel {
  id: string;
  displayName: string;
}

/** The models of one option at one address, as last fetched. */
export interface ApiModels {
  option: ApiOption;
  /** The address the list belongs to. */
  baseUrl: string;
  models: ApiModel[];
  /** `null` for an empty stand-in that was never fetched. */
  fetchedAt: number | null;
}

/** The result of the Test action: one tiny request to the service. */
export interface ApiTest {
  ok: boolean;
  /** "OpenCode Go answered with GLM-5.3." or the reason it failed. */
  message: string;
}

/** One window of the OpenCode Go quota. */
export interface OpencodeUsageLimit {
  /** `fiveHour`, `weekly` or `monthly`. */
  key: string;
  /** "5-hour limit", "Weekly limit", "Monthly limit". */
  label: string;
  /** 0 to 100. */
  usedPercent: number;
  /** Milliseconds since 1970 when the window resets. */
  resetsAt: number | null;
}

/** The OpenCode Go quota as OpenCode reports it (docs/SPEC.md section 5, "Usage limits"). */
export interface OpencodeUsage {
  /** Empty while unknown or unavailable. */
  limits: OpencodeUsageLimit[];
  /** Why no limits can be shown; `null` while they are shown or before the first answer. */
  unavailable: string | null;
  fetchedAt: number | null;
  /** The last refresh error (the last limits are kept). */
  error: string | null;
}

/** What blocks new edits, in the order the person is asked to fix it. */
export type ReadinessProblem =
  | "apiKeyMissing"
  | "apiModelMissing"
  | "gitBashMissing"
  | "claudeMissing"
  | "claudeLoggedOut"
  | "programMissing"
  | "programUnsupported"
  | "notPrepared";

export type ClaudeState = "none" | "loggedOut" | "ready";
export type CliState = "none" | "unsupported" | "ready";

/** Everything the decision of `readiness.problem` depends on. */
export interface ReadinessFacts {
  setup: Setup;
  keySaved: boolean;
  modelChosen: boolean;
  gitBashMissing: boolean;
  claude: ClaudeState;
  program: CliState;
  prepared: boolean;
}

/** The answer of a readiness check. */
export interface Readiness {
  /** `null` when new edits can start. */
  problem: ReadinessProblem | null;
  /** A full sentence for `problem`; `null` when there is none. */
  message: string | null;
}

// Wire types of the Claude Code control helper (docs/SPEC.md sections 5 and 14; written by
// `server/src/agents/claude/`): the plan's usage meter, the model list Claude Code reports, and
// where the server's Claude Code is pointed. Pure declarations; every field is always present
// (`null` when empty). Times are milliseconds since 1970 (the desktop app used ISO texts here).

import type { ClaudeModelInfo, OpencodeUsage } from "./harness.ts";

export type { ClaudeRouting } from "./harness.ts";

/** One window of the plan's usage limits. */
export interface UsageLimit {
  /** `fiveHour`, `weekly`, or a model-scoped weekly key such as `weeklyFable`. */
  key: string;
  /** "5-hour limit", "Weekly limit", "Weekly limit (Opus)". */
  label: string;
  /** 0 to 100. */
  usedPercent: number;
  /** Milliseconds since 1970 when the window resets. */
  resetsAt: number | null;
}

/**
 * The Claude plan's usage limits, read by the server through its own Claude Code (the one of the
 * OS user that runs the server) and shared by everybody, read-only.
 */
export interface UsageStatus {
  /** `false` when the plan reports no rate limits (or nothing was fetched yet). */
  available: boolean;
  /** `fiveHour` first, then `weekly`, then model-scoped ones. */
  limits: UsageLimit[];
  /** When the limits were last read; `null` before the first answer. */
  fetchedAt: number | null;
  /** The last refresh error, readable by a user (the last limits are kept). */
  error: string | null;
}

/** What `getUsage` answers: the Claude meters, and the OpenCode Go quota on that setup. */
export interface UsageView {
  claude: UsageStatus;
  /** Non-null only while the active setup is OpenCode Go. */
  opencode: OpencodeUsage | null;
}

/**
 * The payload of `usage-updated`: only the part that changed is present, so both keys are
 * optional (the one exception to "nothing is optional", because the Claude side and the
 * OpenCode side are fed by different modules).
 */
export interface UsageUpdate {
  claude?: UsageStatus;
  opencode?: OpencodeUsage;
}

/** The models, defaults and plan of the server's Claude Code, as it reports them. */
export interface ClaudeInfo {
  /** As reported by Claude Code, same order, without its own "default" entry. */
  models: ClaudeModelInfo[];
  /** The list value of the model Claude Code would use by itself (display only). */
  defaultModel: string | null;
  defaultEffort: string | null;
  /** For example "Claude Team". */
  subscriptionType: string | null;
  /** The Claude Code version, for example "2.1.319". */
  version: string | null;
  /** When the list was fetched; `null` means never fetched yet (the list is then empty). */
  fetchedAt: number | null;
}

/** One model of `ClaudeInfo.models`. */
export type ClaudeModel = ClaudeModelInfo;

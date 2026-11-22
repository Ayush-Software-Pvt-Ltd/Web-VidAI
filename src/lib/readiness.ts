/**
 * What the page shows for the server's readiness check. The server decides (`getReadiness`
 * answers `{ problem, message }`, from `server/src/agents/readiness.js`) and words the full
 * sentence for the audience (an admin is told where to fix it, anyone else to ask an admin); the
 * UI does not mirror the rule. This module only adds what a screen needs around the sentence:
 * a short title, where the fix is, and the name of the program.
 */
import type { HarnessProgram, Readiness, ReadinessProblem } from "./types";

export type { Readiness, ReadinessProblem };

/** A short heading for each problem (a banner, a sidebar line); the sentence is `Readiness.message`. */
export const PROBLEM_TITLES: Record<ReadinessProblem, string> = {
  apiKeyMissing: "API key missing",
  apiModelMissing: "Model not chosen",
  gitBashMissing: "Git for Windows missing",
  claudeMissing: "Claude Code not installed",
  claudeLoggedOut: "Claude Code not logged in",
  programMissing: "OpenCode 2 not installed",
  programUnsupported: "OpenCode 2 cannot be used",
  notPrepared: "Not prepared yet",
};

/**
 * Where an admin fixes a problem: in the harness settings (`settings`: a key or a model) or on
 * the server's computer, shown in Admin, System (`system`: a program, a login, the preparation).
 */
export function problemFix(problem: ReadinessProblem): "settings" | "system" {
  return problem === "apiKeyMissing" || problem === "apiModelMissing" ? "settings" : "system";
}

/** The title of what blocks new edits, or `null` when they can start (or nothing is known yet). */
export function problemTitle(readiness: Readiness | null | undefined): string | null {
  return readiness?.problem ? PROBLEM_TITLES[readiness.problem] : null;
}

/** The sentence the server wrote for what blocks new edits, or `null` when nothing does. */
export function problemMessage(readiness: Readiness | null | undefined): string | null {
  return readiness?.problem ? (readiness.message ?? PROBLEM_TITLES[readiness.problem]) : null;
}

/** The display name of a program. */
export function programName(program: HarnessProgram | null | undefined): string {
  return program === "opencode2" ? "OpenCode 2" : "Claude Code";
}

import { describe, expect, it } from "vitest";
import { PROBLEM_TITLES, problemFix, problemMessage, problemTitle, programName } from "./readiness";
import type { ReadinessProblem } from "./types";

const ALL: ReadinessProblem[] = [
  "apiKeyMissing",
  "apiModelMissing",
  "gitBashMissing",
  "claudeMissing",
  "claudeLoggedOut",
  "programMissing",
  "programUnsupported",
  "notPrepared",
];

describe("readiness wording", () => {
  it("has a title for every problem the server can report", () => {
    expect(Object.keys(PROBLEM_TITLES).sort()).toEqual([...ALL].sort());
    for (const problem of ALL) expect(PROBLEM_TITLES[problem]).not.toBe("");
  });

  it("sends keys and models to the settings and everything else to the system page", () => {
    expect(problemFix("apiKeyMissing")).toBe("settings");
    expect(problemFix("apiModelMissing")).toBe("settings");
    for (const problem of ALL.slice(2)) expect(problemFix(problem)).toBe("system");
  });

  it("shows nothing while edits can start or nothing is known", () => {
    expect(problemTitle(null)).toBeNull();
    expect(problemMessage(undefined)).toBeNull();
    expect(problemTitle({ problem: null, message: null })).toBeNull();
    expect(problemMessage({ problem: null, message: null })).toBeNull();
  });

  it("shows the server's sentence, and the title when the sentence is missing", () => {
    const readiness = {
      problem: "claudeMissing",
      message: "Claude Code is not installed.",
    } as const;
    expect(problemTitle(readiness)).toBe("Claude Code not installed");
    expect(problemMessage(readiness)).toBe("Claude Code is not installed.");
    expect(problemMessage({ problem: "notPrepared", message: null })).toBe("Not prepared yet");
  });

  it("names the programs", () => {
    expect(programName("claudeCode")).toBe("Claude Code");
    expect(programName("opencode2")).toBe("OpenCode 2");
    expect(programName(null)).toBe("Claude Code");
  });
});

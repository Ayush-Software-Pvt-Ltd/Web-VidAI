import { describe, expect, it } from "vitest";
import {
  API_DEFAULT_BASE_URL,
  API_OPTIONS,
  API_PROTOCOL,
  SETUPS,
  SETUP_INFO,
  isGoAddress,
  isOpencodeHost,
  keyRequired,
  noModelText,
  optionOfSetup,
  programOf,
  setupOfOption,
} from "./setup";

describe("setups", () => {
  it("lists the four setups, each with a label, a service and a line", () => {
    expect(SETUPS).toEqual(["claudeSubscription", "opencodeGo", "anthropicApi", "openaiApi"]);
    for (const setup of SETUPS) {
      const info = SETUP_INFO[setup];
      expect(info.label).toContain(info.programName);
      expect(info.line.length).toBeGreaterThan(10);
      expect(info.service).not.toBe("");
    }
  });

  it("runs the Claude subscription and the Anthropic API on Claude Code, the others on OpenCode 2", () => {
    expect(SETUPS.map(programOf)).toEqual(["claudeCode", "opencode2", "claudeCode", "opencode2"]);
    expect(SETUPS.map((s) => SETUP_INFO[s].programName)).toEqual([
      "Claude Code",
      "OpenCode 2",
      "Claude Code",
      "OpenCode 2",
    ]);
  });

  it("maps options to setups and back", () => {
    expect(optionOfSetup("claudeSubscription")).toBeNull();
    for (const option of API_OPTIONS) {
      expect(setupOfOption(option)).toBe(option);
      expect(optionOfSetup(option)).toBe(option);
      expect(SETUP_INFO[option].option).toBe(option);
    }
  });

  it("needs a key only on OpenCode Go and words the missing model per option", () => {
    expect(API_OPTIONS.filter(keyRequired)).toEqual(["opencodeGo"]);
    expect(noModelText("opencodeGo")).toBe("Choose a model first.");
    expect(noModelText("anthropicApi")).toBe("Type a model first.");
    expect(noModelText("openaiApi")).toBe("Type a model first.");
  });

  it("knows the default addresses and protocols", () => {
    expect(API_PROTOCOL).toEqual({
      opencodeGo: "anthropic",
      anthropicApi: "anthropic",
      openaiApi: "openai",
    });
    expect(isGoAddress(API_DEFAULT_BASE_URL.opencodeGo)).toBe(true);
    expect(isGoAddress(API_DEFAULT_BASE_URL.openaiApi)).toBe(true);
    expect(isGoAddress(API_DEFAULT_BASE_URL.anthropicApi)).toBe(false);
    expect(isGoAddress("https://example.com/go/v2")).toBe(false);
  });

  it("recognizes OpenCode's own host", () => {
    expect(isOpencodeHost("https://opencode.ai/inference/go/v1")).toBe(true);
    expect(isOpencodeHost("https://api.opencode.ai")).toBe(true);
    expect(isOpencodeHost("https://notopencode.ai")).toBe(false);
    expect(isOpencodeHost("not a url")).toBe(false);
  });
});

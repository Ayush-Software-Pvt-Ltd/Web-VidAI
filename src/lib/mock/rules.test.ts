import { describe, expect, it } from "vitest";
import type { JobState, VideoAction } from "../types";
import {
  checkChannelName,
  checkVideoName,
  computeActions,
  isActiveState,
  isReservedChannelEntry,
  resolveVideoType,
  type ActionFacts,
} from "./rules";

const facts = (extra: Partial<ActionFacts> = {}): ActionFacts => ({
  archived: false,
  job: null,
  edited: false,
  workingFiles: false,
  uploading: false,
  admin: false,
  ...extra,
});
const job = (state: JobState, startsAt: number | null = null) => ({ state, startsAt });

describe("computeActions", () => {
  const cases: [string, Partial<ActionFacts>, VideoAction[]][] = [
    ["a new video", {}, ["startEdit", "upload"]],
    [
      "a new video with working files",
      { workingFiles: true },
      ["startEdit", "upload", "diskCleanup"],
    ],
    ["an archived video", { archived: true, edited: true }, ["unarchive"]],
    ["a queued edit", { job: job("queued") }, ["stop", "upload"]],
    ["a queued edit held by the delay (user)", { job: job("queued", 5) }, ["stop", "upload"]],
    [
      "a queued edit held by the delay (admin)",
      { job: job("queued", 5), admin: true },
      ["startNow", "stop", "upload"],
    ],
    ["a running edit", { job: job("running") }, ["pause", "stop", "upload"]],
    ["a pausing edit", { job: job("pausing") }, ["upload"]],
    ["a stopping edit", { job: job("stopping") }, ["upload"]],
    ["a paused edit", { job: job("paused") }, ["continue", "stop", "upload"]],
    [
      "a running re-edit",
      { job: job("running"), edited: true },
      ["pause", "stop", "review", "upload"],
    ],
    ["a failed first edit", { job: job("failed") }, ["continue", "startEdit", "upload", "archive"]],
    [
      "a failed re-edit",
      { job: job("failed"), edited: true },
      ["continue", "reEdit", "renderFinal", "review", "upload", "archive"],
    ],
    ["a stopped first edit", { job: job("stopped") }, ["startEdit", "upload"]],
    [
      "an edited video",
      { job: job("completed"), edited: true, workingFiles: true },
      ["reEdit", "renderFinal", "review", "upload", "diskCleanup", "archive"],
    ],
    ["an upload running", { uploading: true }, ["upload"]],
  ];
  it.each(cases)("%s", (_name, extra, expected) => {
    expect(computeActions(facts(extra))).toEqual(expected);
  });

  it("offers neither disk cleanup nor archive while a job is active", () => {
    const actions = computeActions(facts({ job: job("paused"), edited: true, workingFiles: true }));
    expect(actions).not.toContain("diskCleanup");
    expect(actions).not.toContain("archive");
  });
});

describe("isActiveState", () => {
  it("is true until a job ends", () => {
    for (const state of ["queued", "running", "pausing", "paused", "stopping"] as const) {
      expect(isActiveState(state)).toBe(true);
    }
    for (const state of ["stopped", "failed", "completed"] as const) {
      expect(isActiveState(state)).toBe(false);
    }
    expect(isActiveState(null)).toBe(false);
  });
});

describe("resolveVideoType", () => {
  it("prefers the override, then the channel, then the detected type, then Long", () => {
    expect(resolveVideoType("short", "long", "long")).toEqual({
      videoType: "short",
      typeSource: "override",
    });
    expect(resolveVideoType(null, "short", "long")).toEqual({
      videoType: "short",
      typeSource: "channel",
    });
    expect(resolveVideoType(null, "auto", "short")).toEqual({
      videoType: "short",
      typeSource: "detected",
    });
    expect(resolveVideoType(null, "auto", null)).toEqual({
      videoType: "long",
      typeSource: "assumed",
    });
  });
});

describe("names", () => {
  it("trims channel names and refuses empty, long and control-character ones", () => {
    expect(checkChannelName("  Cooking ")).toEqual({ name: "Cooking" });
    expect(checkChannelName("   ")).toHaveProperty("error");
    expect(checkChannelName("x".repeat(61))).toHaveProperty("error");
    expect(checkChannelName("bad\u0007name")).toHaveProperty("error");
  });

  it("refuses video names that are paths, hidden or reserved", () => {
    expect(checkVideoName(" Good Name ")).toEqual({ name: "Good Name" });
    for (const bad of [
      "",
      "..",
      "a/b",
      "a:b",
      ".hidden",
      "CLAUDE_VE_ALL",
      "Style",
      "x".repeat(121),
    ]) {
      expect(checkVideoName(bad)).toHaveProperty("error");
    }
    expect(isReservedChannelEntry("CLAUDE_VE")).toBe(true);
    expect(isReservedChannelEntry("Holiday")).toBe(false);
  });
});

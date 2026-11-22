import { describe, expect, it } from "vitest";
import type { JobState, VideoAction } from "../types";
import {
  checkChannelName,
  computeActions,
  isActiveState,
  isNeverAVideo,
  resolveVideoType,
  uploadNameProblem,
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

  it("knows which folders of a channel directory are never videos", () => {
    for (const name of [
      ".hidden",
      "CLAUDE_VE",
      "CLAUDE_VE_ALL",
      "upload",
      "Upload",
      "UPLOAD",
      "Style",
      "samples",
      "Host Pictures",
    ]) {
      expect(isNeverAVideo(name), name).toBe(true);
    }
    for (const name of ["Holiday", "uploads", "my upload", "Day 1"]) {
      expect(isNeverAVideo(name), name).toBe(false);
    }
  });

  it("accepts any file name an upload may have", () => {
    for (const name of [
      "a.mp4",
      "notes.pdf",
      "no extension",
      "Report 2026.final.zip",
      "x".repeat(200),
    ]) {
      expect(uploadNameProblem(name), name).toBeNull();
    }
  });

  it("refuses upload names with separators, control characters, dots, spaces and Windows names", () => {
    for (const bad of [
      "",
      "x".repeat(201),
      "a/b.mp4",
      "a\\b.mp4",
      "a\u0007b.mp4",
      ".hidden",
      "..",
      "name.",
      "name ",
      "CON",
      "con.txt",
      "LPT1",
      "nul.tar.gz",
    ]) {
      expect(uploadNameProblem(bad), JSON.stringify(bad)).toEqual(expect.any(String));
    }
    expect(uploadNameProblem("console.txt")).toBeNull();
    expect(uploadNameProblem("COM10")).toBeNull();
  });
});

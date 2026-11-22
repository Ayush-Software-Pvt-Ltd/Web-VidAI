import { describe, expect, it } from "vitest";
import type { Channel } from "@/lib/types";
import { profile } from "@/lib/mock/seed/workspace";
import {
  afterSave,
  buildUpdate,
  changedFields,
  channelNameProblem,
  describeFields,
  hasInvalidSlotName,
  isFieldChanged,
} from "./draft";

const channel: Channel = {
  id: "c0ffee00000000000000000000000001",
  name: "Beauty",
  dir: "/media/me/Beauty",
  videoType: "auto",
  long: profile("long"),
  short: profile("short"),
  available: true,
};

describe("channel name", () => {
  it("must have 1 to 60 characters", () => {
    expect(channelNameProblem("a")).toBeNull();
    expect(channelNameProblem("x".repeat(60))).toBeNull();
    expect(channelNameProblem("   ")).toMatch(/1 to 60/);
    expect(channelNameProblem("x".repeat(61))).toMatch(/1 to 60/);
    // Characters, not UTF-16 units.
    expect(channelNameProblem("😀".repeat(60))).toBeNull();
  });

  it("a changed invalid name cannot be saved", () => {
    expect(hasInvalidSlotName(channel, { name: "" })).toBe(true);
    expect(hasInvalidSlotName(channel, { name: "Fine" })).toBe(false);
  });
});

describe("buildUpdate", () => {
  it("is null when nothing changed, also after typing the saved text again", () => {
    expect(buildUpdate(channel, {})).toBeNull();
    expect(buildUpdate(channel, { name: "  Beauty ", videoType: "auto" })).toBeNull();
    expect(changedFields(channel, { name: "Beauty" })).toEqual([]);
  });

  it("sends only the changed fields, the name trimmed", () => {
    expect(buildUpdate(channel, { name: " Glow " })).toEqual({
      name: "Glow",
      videoType: null,
      long: null,
      short: null,
    });
    expect(buildUpdate(channel, { videoType: "short" })).toEqual({
      name: null,
      videoType: "short",
      long: null,
      short: null,
    });
  });

  it("sends a changed profile whole and leaves the other one out", () => {
    const update = buildUpdate(channel, {
      "long.prompt.1": "Second",
      "long.prompt.1.name": " Reviews ",
    });
    expect(update?.short).toBeNull();
    expect(update?.long?.prompts).toHaveLength(5);
    expect(update?.long?.prompts[1]).toEqual({ name: "Reviews", text: "Second" });
    expect(update?.long?.prompts[0]).toEqual(channel.long.prompts[0]);
    expect(update?.long?.styles).toEqual(channel.long.styles);
  });
});

describe("afterSave and describeFields", () => {
  it("keeps what changed while saving", () => {
    expect(
      afterSave({ name: "B", "long.style.0": "x" }, { name: "B", "long.style.0": "y" }),
    ).toEqual({ "long.style.0": "x" });
  });

  it("describes the changed parts once each", () => {
    const draft = { name: "B", videoType: "short", "long.prompt.0": "p", "long.prompt.1": "q" };
    expect(isFieldChanged(channel, draft, "videoType")).toBe(true);
    expect(describeFields(changedFields(channel, draft))).toEqual([
      "name",
      "video type",
      "Long 16:9 prompt",
    ]);
  });
});

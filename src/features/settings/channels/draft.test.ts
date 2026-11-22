import { describe, expect, it } from "vitest";
import type { Channel } from "@/lib/types";
import { profile } from "@/lib/mock/seed/workspace";
import {
  afterSave,
  buildUpdate,
  changedFields,
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

describe("slot names", () => {
  it("a changed invalid slot name cannot be saved", () => {
    expect(hasInvalidSlotName(channel, { "long.prompt.1.name": "  " })).toBe(true);
    expect(hasInvalidSlotName(channel, { "long.prompt.1.name": "x".repeat(41) })).toBe(true);
    expect(hasInvalidSlotName(channel, { "long.prompt.1.name": "Fine" })).toBe(false);
  });
});

describe("buildUpdate", () => {
  it("is null when nothing changed, also after typing the saved text again", () => {
    expect(buildUpdate(channel, {})).toBeNull();
    expect(buildUpdate(channel, { videoType: "auto" })).toBeNull();
    expect(changedFields(channel, { "long.prompt.1.name": " Prompt 2 " })).toEqual([]);
  });

  it("sends only the changed fields and never a name", () => {
    expect(buildUpdate(channel, { videoType: "short" })).toEqual({
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
      afterSave(
        { videoType: "long", "long.style.0": "x" },
        { videoType: "long", "long.style.0": "y" },
      ),
    ).toEqual({ "long.style.0": "x" });
  });

  it("describes the changed parts once each", () => {
    const draft = { videoType: "short", "long.prompt.0": "p", "long.prompt.1": "q" };
    expect(isFieldChanged(channel, draft, "videoType")).toBe(true);
    expect(describeFields(changedFields(channel, draft))).toEqual([
      "video type",
      "Long 16:9 prompt",
    ]);
  });
});

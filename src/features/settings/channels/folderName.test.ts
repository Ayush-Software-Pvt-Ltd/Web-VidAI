import { describe, expect, it } from "vitest";
import { folderNameFor, newChannelPath } from "./folderName";

describe("folderNameFor", () => {
  it("keeps an ordinary name, in any script", () => {
    expect(folderNameFor("Glow Naturals")).toBe("Glow Naturals");
    expect(folderNameFor("हिंदी चैनल")).toBe("हिंदी चैनल");
  });

  it("turns separators and control characters into dashes", () => {
    expect(folderNameFor("Q/A\\tips")).toBe("Q-A-tips");
    expect(folderNameFor("a\u0000b\u007fc")).toBe("a-b-c");
    expect(folderNameFor("one‮two")).toBe("one-two");
  });

  it("drops leading dots, trailing dots and spaces, and outer spaces", () => {
    expect(folderNameFor("  ..hidden. . ")).toBe("hidden");
  });

  it("falls back to Channel when nothing is left or the name is too long", () => {
    expect(folderNameFor("...")).toBe("Channel");
    expect(folderNameFor("   ")).toBe("Channel");
    // 120 characters of 2 bytes each are more than 200 bytes.
    expect(folderNameFor("é".repeat(120))).toBe("Channel");
    expect(folderNameFor("x".repeat(130))).toBe("x".repeat(120));
  });
});

describe("newChannelPath", () => {
  it("joins the folder name onto the parent", () => {
    expect(newChannelPath("/media/me", "Q/A")).toBe("/media/me/Q-A");
  });
});

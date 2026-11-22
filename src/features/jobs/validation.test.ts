import { describe, expect, it } from "vitest";
import { changesProblem, fileName, normalizeLinks, productLinksProblem } from "./validation";

describe("product links", () => {
  it("accepts empty text and one link per line, with or without a scheme", () => {
    expect(productLinksProblem("")).toBeNull();
    expect(productLinksProblem("\n  \n")).toBeNull();
    expect(
      productLinksProblem("https://example.com/a\n\nshop.example.in/p?id=1\nhttp://x.co"),
    ).toBeNull();
  });

  it("names the first line that is not a link", () => {
    expect(productLinksProblem("hair oil")).toBe(
      "This does not look like a link. Put one link per line.",
    );
    expect(productLinksProblem("https://a.com\nhttps://b.com, https://c.com")).toBe(
      "Line 2 does not look like a link. Put one link per line.",
    );
    expect(productLinksProblem("https://a.com\nlocalhost")).toMatch(/^Line 2/);
  });

  it("normalizes to trimmed lines without blanks", () => {
    expect(normalizeLinks("  https://a.com  \r\n\n b.com \n")).toBe("https://a.com\nb.com");
  });
});

describe("other checks", () => {
  it("requires the re-edit changes", () => {
    expect(changesProblem("   \n")).toBe("Describe what should change.");
    expect(changesProblem("Shorter intro")).toBeNull();
  });

  it("limits the Re-Edit text to 8000 characters", () => {
    expect(changesProblem("a".repeat(8000))).toBeNull();
    expect(changesProblem("a".repeat(8001))).toBe("Keep the text under 8000 characters.");
  });

  it("takes the file name of a path", () => {
    expect(fileName("/Users/me/Desktop/Timeline Export.fcpxml")).toBe("Timeline Export.fcpxml");
    expect(fileName("/Users/me/Bundle.fcpxmld/")).toBe("Bundle.fcpxmld");
  });
});

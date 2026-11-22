import { describe, expect, it } from "vitest";
import {
  channelIdOf,
  decodeVideoId,
  encodeVideoId,
  folderNameOf,
  makeVideoId,
  splitVideoId,
  videoLabel,
} from "./videoId";

describe("video ids", () => {
  it("makes and splits at the first slash only", () => {
    const id = makeVideoId("ab12", "Trip 2025/05 (final)");
    expect(id).toBe("ab12/Trip 2025/05 (final)");
    expect(splitVideoId(id)).toEqual({ channelId: "ab12", folderName: "Trip 2025/05 (final)" });
  });

  it("refuses text that is not a video id", () => {
    expect(splitVideoId("nochannel")).toBeNull();
    expect(splitVideoId("/folder")).toBeNull();
    expect(splitVideoId("channel/")).toBeNull();
    expect(channelIdOf("x")).toBeNull();
  });

  it("encodes the slash and round-trips every kind of folder name", () => {
    for (const folder of ["Plain", "with space", "100% sure", "a/b", "Ünï cödé ✓", "a?b#c&d=e"]) {
      const id = makeVideoId("c0ffee", folder);
      const encoded = encodeVideoId(id);
      expect(encoded).not.toContain("/");
      expect(decodeVideoId(encoded)).toBe(id);
    }
  });

  it("answers null for a broken or foreign segment", () => {
    expect(decodeVideoId("%E0%A4%A")).toBeNull();
    expect(decodeVideoId("settings")).toBeNull();
  });

  it("names a video for people", () => {
    const id = makeVideoId("c1", "Hair Oil");
    expect(folderNameOf(id)).toBe("Hair Oil");
    expect(videoLabel(id)).toBe("Hair Oil");
    expect(videoLabel(id, "Beauty")).toBe("Beauty / Hair Oil");
    expect(videoLabel("odd")).toBe("odd");
  });
});

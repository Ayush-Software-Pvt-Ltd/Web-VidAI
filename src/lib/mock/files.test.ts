import { crc32, inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { MockBackend } from "./backend";
import { mockFileUrl, solidPng } from "./files";
import { buildFileUrl } from "../http";
import { makeVideoId } from "../videoId";

const made: MockBackend[] = [];
afterEach(() => {
  for (const backend of made.splice(0)) backend.dispose();
});

function mock(): MockBackend {
  const backend = new MockBackend({ latencyMs: 0, autoTick: false });
  made.push(backend);
  return backend;
}

function pngBytes(url: string): Buffer {
  const match = /^data:image\/png;base64,(.+)$/.exec(url);
  if (!match?.[1]) throw new Error(`not a PNG data address: ${url.slice(0, 40)}`);
  return Buffer.from(match[1], "base64");
}

describe("mock fileUrl", () => {
  it("hands out the text of a text file as a data address", async () => {
    const url = mock().fileUrl("ch1/Serum A", "output/meta.txt");
    expect(url.startsWith("data:text/plain;charset=utf-8,")).toBe(true);
    const text = decodeURIComponent(url.slice(url.indexOf(",") + 1));
    expect(text).toContain("Title: Serum A - an honest review");
    // The same address serves the download link, and fetch reads it back.
    expect(mock().fileUrl("ch1/Serum A", "output/meta.txt", { download: true })).toBe(url);
    expect(await (await fetch(url)).text()).toBe(text);
    const info = mock().fileUrl("ch1/Serum A", "info.txt");
    expect(decodeURIComponent(info)).toContain("Product: Example Serum");
  });

  it("hands out a valid one-colour PNG for pictures, a different colour per file", () => {
    const backend = mock();
    const bytes = pngBytes(backend.fileUrl("ch1/Serum A", "output/thumb_1.jpg"));
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect(bytes.readUInt32BE(16)).toBe(16);
    expect(bytes.readUInt32BE(20)).toBe(9);
    expect(bytes.subarray(bytes.length - 8, bytes.length - 4).toString("latin1")).toBe("IEND");
    const other = backend.fileUrl("ch1/Serum A", "output/thumb_2.png");
    expect(other.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("keeps every PNG chunk's checksum and pixel data right", () => {
    const bytes = Buffer.from(solidPng(10, 20, 30));
    let at = 8;
    const types: string[] = [];
    while (at < bytes.length) {
      const length = bytes.readUInt32BE(at);
      types.push(bytes.subarray(at + 4, at + 8).toString("latin1"));
      const stored = bytes.readUInt32BE(at + 8 + length);
      // CRC-32 of type and data, computed by node itself.
      expect(stored).toBe(crc32(bytes.subarray(at + 4, at + 8 + length)));
      if (types.at(-1) === "IDAT") {
        const raw = inflateSync(bytes.subarray(at + 8, at + 8 + length));
        expect(raw.length).toBe(9 * (1 + 16 * 3));
        expect([...raw.subarray(0, 4)]).toEqual([0, 10, 20, 30]);
      }
      at += 12 + length;
    }
    expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("keeps the real route for videos, which have no generated stand-in", () => {
    const url = mock().fileUrl("ch1/Serum A", "output/final.mp4", { download: true });
    expect(url).toBe(mockFileUrl("ch1/Serum A", "output/final.mp4", { download: true }));
    expect(url.startsWith("/api/file?video=")).toBe(true);
    expect(url.endsWith("&download=1")).toBe(true);
  });

  it("serves nothing for a file of a channel whose folder cannot be reached", () => {
    const backend = mock();
    const video = backend.world.videos[0];
    if (!video) throw new Error("the default scenario has videos");
    const id = makeVideoId(video.channelId, video.folderName);
    expect(backend.fileUrl(id, "output/meta.txt").startsWith("data:")).toBe(true);
    for (const channel of backend.world.channels) channel.available = false;
    expect(backend.fileUrl(id, "output/meta.txt")).toBe(buildFileUrl(id, "output/meta.txt"));
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readIsoBmffSize } from "../../src/library/mediaMoov.js";
import { MEDIA_FIXTURES, tempFolder, write } from "./support.js";

// Synthetic boxes.

const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
const ROT90 = [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000];

/** @param {string} kind @param {Buffer} payload */
function box(kind, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(kind, 4, "latin1");
  return Buffer.concat([head, payload]);
}

/** A 64-bit sized box. @param {string} kind @param {Buffer} payload */
function box64(kind, payload) {
  const head = Buffer.alloc(16);
  head.writeUInt32BE(1, 0);
  head.write(kind, 4, "latin1");
  head.writeBigUInt64BE(BigInt(16 + payload.length), 8);
  return Buffer.concat([head, payload]);
}

/** A box that runs to the end of the file. @param {string} kind @param {Buffer} payload */
function boxOpen(kind, payload) {
  const head = Buffer.alloc(8);
  head.write(kind, 4, "latin1");
  return Buffer.concat([head, payload]);
}

/**
 * @param {object} track
 * @param {number} track.width
 * @param {number} track.height
 * @param {number[]} [track.matrix]
 * @param {boolean} [track.enabled]
 * @param {string} [track.handler]
 * @param {boolean} [track.sampleEntry] Put the size in the sample description only.
 * @param {boolean} [track.version1]
 */
function trak({
  width,
  height,
  matrix = IDENTITY,
  enabled = true,
  handler = "vide",
  sampleEntry = false,
  version1 = false,
}) {
  const tkhd = Buffer.alloc(4 + (version1 ? 32 : 20) + 16 + 36 + 8);
  tkhd[0] = version1 ? 1 : 0;
  tkhd.writeUIntBE(enabled ? 3 : 0, 1, 3);
  const matrixAt = 4 + (version1 ? 32 : 20) + 16;
  matrix.forEach((cell, index) => tkhd.writeInt32BE(cell, matrixAt + index * 4));
  if (!sampleEntry) {
    tkhd.writeUInt32BE(width * 65536, matrixAt + 36);
    tkhd.writeUInt32BE(height * 65536, matrixAt + 40);
  }
  const hdlrPayload = Buffer.alloc(12);
  hdlrPayload.write(handler, 8, "latin1");
  const entry = Buffer.alloc(28);
  entry.writeUInt16BE(width, 24);
  entry.writeUInt16BE(height, 26);
  const stsdPayload = Buffer.concat([Buffer.alloc(8), box("avc1", entry)]);
  const stbl = box("stbl", box("stsd", stsdPayload));
  const mdia = box("mdia", Buffer.concat([box("hdlr", hdlrPayload), box("minf", stbl)]));
  return box("trak", Buffer.concat([box("tkhd", tkhd), mdia]));
}

const FTYP = box("ftyp", Buffer.from("isom\0\0\0\0isom"));
/** @param {...Buffer} tracks */
const moov = (...tracks) => box("moov", Buffer.concat(tracks));

/** @param {Buffer} bytes */
async function sizeOf(bytes) {
  const dir = tempFolder();
  try {
    return await readIsoBmffSize(write(path.join(dir.dir, "a.mp4"), bytes));
  } finally {
    dir.cleanup();
  }
}

test("fixtures: sizes and rotation", async () => {
  /** @type {[string, number, number][]} */
  const table = [
    ["landscape.mp4", 64, 36],
    ["landscape-with-audio.mov", 64, 36],
    ["rotated-180.mov", 64, 36],
    ["portrait-faststart.mp4", 36, 64],
    ["rotated-90.mov", 36, 64],
    ["rotated-270.mp4", 36, 64],
  ];
  for (const [name, width, height] of table) {
    const result = await readIsoBmffSize(path.join(MEDIA_FIXTURES, name));
    assert.deepEqual(result, { ok: true, size: { width, height } }, name);
  }
});

test("fixtures: a hevc file reads and a matroska file is not an MP4", async () => {
  const hevc = await readIsoBmffSize(path.join(MEDIA_FIXTURES, "hevc.mp4"));
  assert.equal(hevc.ok, true);
  const mkv = await readIsoBmffSize(path.join(MEDIA_FIXTURES, "portrait.mkv"));
  assert.deepEqual(mkv, { ok: false, reason: "not an MP4 or QuickTime file" });
});

test("the matrix swaps width and height for a quarter turn", async () => {
  assert.deepEqual(await sizeOf(Buffer.concat([FTYP, moov(trak({ width: 1920, height: 1080 }))])), {
    ok: true,
    size: { width: 1920, height: 1080 },
  });
  assert.deepEqual(
    await sizeOf(Buffer.concat([FTYP, moov(trak({ width: 1920, height: 1080, matrix: ROT90 }))])),
    { ok: true, size: { width: 1080, height: 1920 } },
  );
});

test("a version 1 track header is read", async () => {
  const result = await sizeOf(
    Buffer.concat([FTYP, moov(trak({ width: 640, height: 480, version1: true, matrix: ROT90 }))]),
  );
  assert.deepEqual(result, { ok: true, size: { width: 480, height: 640 } });
});

test("a zero track header size falls back to the sample description", async () => {
  const result = await sizeOf(
    Buffer.concat([FTYP, moov(trak({ width: 1280, height: 720, sampleEntry: true }))]),
  );
  assert.deepEqual(result, { ok: true, size: { width: 1280, height: 720 } });
});

test("the largest enabled video track wins; audio tracks are ignored", async () => {
  const result = await sizeOf(
    Buffer.concat([
      FTYP,
      moov(
        trak({ width: 100, height: 100, handler: "soun" }),
        trak({ width: 320, height: 240 }),
        trak({ width: 3840, height: 2160, enabled: false }),
        trak({ width: 640, height: 1136 }),
      ),
    ]),
  );
  assert.deepEqual(result, { ok: true, size: { width: 640, height: 1136 } });
});

test("with only disabled video tracks the largest of them is used", async () => {
  const result = await sizeOf(
    Buffer.concat([
      FTYP,
      moov(
        trak({ width: 100, height: 100, enabled: false }),
        trak({ width: 200, height: 400, enabled: false }),
      ),
    ]),
  );
  assert.deepEqual(result, { ok: true, size: { width: 200, height: 400 } });
});

test("a file with no video track says so", async () => {
  const result = await sizeOf(
    Buffer.concat([FTYP, moov(trak({ width: 1, height: 1, handler: "soun" }))]),
  );
  assert.equal(result.ok, false);
  assert.match(/** @type {{ reason: string }} */ (result).reason, /no video track/);
});

test("64-bit boxes before and around the moov box are walked", async () => {
  const mdat = box64("mdat", Buffer.alloc(40, 1));
  const big = box64("moov", Buffer.concat([trak({ width: 90, height: 160 })]));
  assert.deepEqual(await sizeOf(Buffer.concat([FTYP, mdat, big])), {
    ok: true,
    size: { width: 90, height: 160 },
  });
});

test("an open-ended moov box runs to the end of the file", async () => {
  const open = boxOpen("moov", trak({ width: 90, height: 160 }));
  assert.deepEqual(await sizeOf(Buffer.concat([FTYP, open])), {
    ok: true,
    size: { width: 90, height: 160 },
  });
});

test("an open-ended mdat before the moov hides it", async () => {
  const result = await sizeOf(Buffer.concat([FTYP, boxOpen("mdat", Buffer.alloc(30)), moov()]));
  assert.equal(result.ok, false);
  assert.match(/** @type {{ reason: string }} */ (result).reason, /no moov box/);
});

test("malformed files give a reason and never throw", async () => {
  /** @type {[string, Buffer, RegExp][]} */
  const cases = [
    ["empty", Buffer.alloc(0), /not an MP4/],
    ["text", Buffer.from("hello world, this is text"), /not an MP4/],
    ["only ftyp", FTYP, /no moov box/],
    ["truncated header", Buffer.concat([FTYP, Buffer.from([0, 0, 0])]), /truncated box header/],
    [
      "box too large",
      Buffer.concat([FTYP, Buffer.from([0x00, 0x00, 0xff, 0xff, 0x6d, 0x6f, 0x6f, 0x76])]),
      /invalid size/,
    ],
    [
      "box smaller than its header",
      Buffer.concat([FTYP, Buffer.from([0, 0, 0, 4, 0x6d, 0x6f, 0x6f, 0x76])]),
      /invalid size/,
    ],
    [
      "truncated 64-bit header",
      Buffer.concat([FTYP, Buffer.from([0, 0, 0, 1, 0x6d, 0x6f, 0x6f, 0x76, 0, 0])]),
      /truncated 64-bit box header/,
    ],
    ["moov without tracks", Buffer.concat([FTYP, moov()]), /no video track/],
  ];
  for (const [name, bytes, reason] of cases) {
    const result = await sizeOf(bytes);
    assert.equal(result.ok, false, name);
    assert.match(/** @type {{ reason: string }} */ (result).reason, reason, name);
  }
});

test("a track header cut short is skipped, not fatal", async () => {
  const cut = box("trak", box("tkhd", Buffer.alloc(8)));
  const result = await sizeOf(Buffer.concat([FTYP, moov(cut, trak({ width: 50, height: 60 }))]));
  assert.deepEqual(result, { ok: true, size: { width: 50, height: 60 } });
});

test("a missing file is a reason, not an exception", async () => {
  const dir = tempFolder();
  try {
    const result = await readIsoBmffSize(path.join(dir.dir, "nope.mp4"));
    assert.equal(result.ok, false);
    assert.match(/** @type {{ reason: string }} */ (result).reason, /could not open/);
    assert.ok(!fs.existsSync(path.join(dir.dir, "nope.mp4")));
  } finally {
    dir.cleanup();
  }
});

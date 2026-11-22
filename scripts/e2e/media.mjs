// Test media for the end-to-end runs: tiny A-roll videos and PNG thumbnails.
//
// The A-rolls are made with ffmpeg when it is installed (real, playable videos, which the macOS
// picture check can decode). Without ffmpeg (the Windows CI image has none) they are written here
// as header-only MP4 files: a `moov` with one video track whose header carries the size and the
// rotation matrix, which is everything VidAI's own MP4 parser reads (src-tauri/src/media.rs).
// PNG thumbnails are always written here; they need no tool.
import { execFile as execFileCb } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

const execFile = promisify(execFileCb);

/** The A-roll kinds every scenario can use. */
export const MEDIA = /** @type {const} */ (["landscape", "portrait", "rotated"]);

/** Whether ffmpeg runs here. */
async function hasFfmpeg() {
  try {
    await execFile("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes landscape.mp4 (320x180), portrait.mp4 (180x320) and rotated.mp4 (coded 320x180, shown
 * turned by 90 degrees: a vertical video) into `dir`.
 * @param {string} dir @returns {Promise<"ffmpeg" | "header-only">}
 */
export async function makeMedia(dir) {
  await mkdir(dir, { recursive: true });
  if (!(await hasFfmpeg())) {
    await writeFile(path.join(dir, "landscape.mp4"), mp4(320, 180, false));
    await writeFile(path.join(dir, "portrait.mp4"), mp4(180, 320, false));
    await writeFile(path.join(dir, "rotated.mp4"), mp4(320, 180, true));
    return "header-only";
  }
  const make = async (/** @type {string} */ name, /** @type {string} */ size) => {
    const out = path.join(dir, name);
    await execFile("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=${size}:rate=10:duration=1`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      out,
    ]);
    return out;
  };
  const landscape = await make("landscape.mp4", "320x180");
  await make("portrait.mp4", "180x320");
  await execFile("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-display_rotation",
    "90",
    "-i",
    landscape,
    "-c",
    "copy",
    path.join(dir, "rotated.mp4"),
  ]);
  return "ffmpeg";
}

// ---------------------------------------------------------------------------------------------
// Header-only MP4 (ISO BMFF)
// ---------------------------------------------------------------------------------------------

const u16 = (/** @type {number} */ n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (/** @type {number} */ n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const zeros = (/** @type {number} */ n) => Buffer.alloc(n);
const text = (/** @type {string} */ s) => Buffer.from(s, "latin1");

/** A box: size, type, payload. @param {string} type @param {Buffer[]} parts */
function box(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), text(type), body]);
}

/** A full box: a box whose payload starts with a version and flags. */
function fullBox(
  /** @type {string} */ type,
  /** @type {number} */ version,
  /** @type {number} */ flags,
  /** @type {Buffer[]} */ ...parts
) {
  return box(type, u32((version << 24) | flags), ...parts);
}

/** A transformation matrix of 16.16 fixed point numbers (u, v and w are 2.30). */
function matrix(/** @type {number[]} */ values) {
  return Buffer.concat(values.map((v) => u32(v)));
}

const ONE = 0x10000;
const IDENTITY = [ONE, 0, 0, 0, ONE, 0, 0, 0, 0x40000000];

/**
 * A moov-only MP4 with one enabled video track of `width` x `height`, turned by 90 degrees
 * clockwise when `rotated` (the matrix ffmpeg writes for `-display_rotation 90`, as players and
 * VidAI read it: the picture is shown `height` wide and `width` tall).
 * @param {number} width @param {number} height @param {boolean} rotated
 */
export function mp4(width, height, rotated) {
  const trackMatrix = rotated ? [0, ONE, 0, -ONE, 0, 0, height * ONE, 0, 0x40000000] : IDENTITY;
  const ftyp = box("ftyp", text("isom"), u32(512), text("isomiso2avc1mp41"));
  const mvhd = fullBox(
    "mvhd",
    0,
    0,
    u32(0), // creation time
    u32(0), // modification time
    u32(1000), // time scale
    u32(1000), // duration: one second
    u32(ONE), // rate 1.0
    u16(0x0100), // volume 1.0
    zeros(10),
    matrix(IDENTITY),
    zeros(24),
    u32(2), // next track id
  );
  const tkhd = fullBox(
    "tkhd",
    0,
    3, // enabled, in movie
    u32(0),
    u32(0),
    u32(1), // track id
    zeros(4),
    u32(1000), // duration
    zeros(8),
    u16(0), // layer
    u16(0), // alternate group
    u16(0), // volume (video)
    zeros(2),
    matrix(trackMatrix),
    u32(width * ONE),
    u32(height * ONE),
  );
  const mdhd = fullBox("mdhd", 0, 0, u32(0), u32(0), u32(1000), u32(1000), u16(0x55c4), u16(0));
  const hdlr = fullBox("hdlr", 0, 0, u32(0), text("vide"), zeros(12), text("VideoHandler\0"));
  const avc1 = box(
    "avc1",
    zeros(6),
    u16(1), // data reference index
    zeros(16),
    u16(width),
    u16(height),
    u32(0x00480000), // 72 dpi
    u32(0x00480000),
    zeros(4),
    u16(1), // frames per sample
    zeros(32), // compressor name
    u16(0x18), // depth
    u16(0xffff), // pre-defined -1
  );
  const stbl = box(
    "stbl",
    fullBox("stsd", 0, 0, u32(1), avc1),
    fullBox("stts", 0, 0, u32(0)),
    fullBox("stsc", 0, 0, u32(0)),
    fullBox("stsz", 0, 0, u32(0), u32(0)),
    fullBox("stco", 0, 0, u32(0)),
  );
  const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
  const minf = box("minf", fullBox("vmhd", 0, 1, zeros(8)), dinf, stbl);
  const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, minf));
  return Buffer.concat([ftyp, box("moov", mvhd, trak)]);
}

// ---------------------------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------------------------

/** @type {number[] | null} */
let crcTable = null;

function crc32(/** @type {Buffer} */ data) {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of data) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(/** @type {string} */ type, /** @type {Buffer} */ data) {
  const typed = Buffer.concat([text(type), data]);
  return Buffer.concat([u32(data.length), typed, u32(crc32(typed))]);
}

/**
 * A PNG test card of `width` x `height`: seven colour bars over a grey ramp.
 * @param {number} width @param {number} height
 */
export function png(width, height) {
  const bars = [
    [192, 192, 192],
    [192, 192, 0],
    [0, 192, 192],
    [0, 192, 0],
    [192, 0, 192],
    [192, 0, 0],
    [0, 0, 192],
  ];
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // no filter
    for (let x = 0; x < width; x++) {
      const grey = Math.round((x / Math.max(1, width - 1)) * 255);
      const colour =
        y < (height * 3) / 4
          ? (bars[Math.min(bars.length - 1, Math.floor((x * bars.length) / width))] ?? [0, 0, 0])
          : [grey, grey, grey];
      colour.forEach((value, i) => {
        raw[row + 1 + x * 3 + i] = value;
      });
    }
  }
  const header = Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

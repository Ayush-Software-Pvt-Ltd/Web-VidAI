// The display size of an MP4, MOV or M4V file read in this process, without any external tool
// (docs/SPEC.md section 6, "Videos"). The `moov` box holds the
// track headers: width, height and the rotation matrix of each video track.
//
// The box walk reads only box headers and jumps over everything else, so a multi-GB file with
// `moov` at the end costs a handful of small reads.

import fsp from "node:fs/promises";

/**
 * @typedef {object} DisplaySize Width and height as the video is shown (rotation applied).
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {{ ok: true, size: DisplaySize } | { ok: false, reason: string }} MoovResult
 */

/**
 * The `moov` box holds only metadata (a few KB to a few MB even for hours of footage). Anything
 * larger is treated as corrupt rather than read into memory.
 */
export const MAX_MOOV_BYTES = 256 * 1024 * 1024;

const PLAUSIBLE_FIRST_BOXES = [
  "ftyp",
  "moov",
  "mdat",
  "wide",
  "free",
  "skip",
  "pnot",
  "uuid",
  "styp",
];

/**
 * @typedef {object} BoxHeader
 * @property {string} kind
 * @property {number} headerLen
 * @property {number | null} payloadLen `null`: to the end of the enclosing range.
 */

/**
 * Parses one box header from `head` (at least 16 bytes or what is left). `remaining` is how many
 * bytes are left in the enclosing range, starting at the header.
 * @param {Buffer} head
 * @param {number} remaining
 * @returns {BoxHeader | null} `null` at a clean end.
 * @throws {Error} A malformed header (the message says what is wrong).
 */
function parseBoxHeader(head, remaining) {
  if (remaining === 0) return null;
  if (remaining < 8 || head.length < 8) throw new Error("truncated box header");
  const size32 = head.readUInt32BE(0);
  const kind = head.toString("latin1", 4, 8);
  let headerLen = 8;
  /** @type {bigint | null} */
  let total = null;
  if (size32 === 1) {
    if (remaining < 16 || head.length < 16) throw new Error("truncated 64-bit box header");
    headerLen = 16;
    total = head.readBigUInt64BE(8);
  } else if (size32 !== 0) {
    total = BigInt(size32);
  }
  if (total === null) return { kind, headerLen, payloadLen: null };
  if (total < BigInt(headerLen) || total > BigInt(remaining)) {
    throw new Error(`box ${kind} has an invalid size ${total}`);
  }
  return { kind, headerLen, payloadLen: Number(total) - headerLen };
}

/**
 * Finds the top-level `moov` box and returns its payload.
 * @param {string} file
 * @returns {Promise<Buffer>}
 * @throws {Error} With a sentence saying why the file has none.
 */
async function readMoov(file) {
  /** @type {import("node:fs/promises").FileHandle} */
  let handle;
  try {
    handle = await fsp.open(file, "r");
  } catch (error) {
    throw new Error(`could not open the file: ${error instanceof Error ? error.message : error}`, {
      cause: error,
    });
  }
  try {
    const fileLen = (await handle.stat()).size;
    const head = Buffer.alloc(16);
    /** @param {number} at */
    const readHead = async (at) => {
      const { bytesRead } = await handle.read(head, 0, 16, at);
      return head.subarray(0, bytesRead);
    };
    // Recognise the container by its first box type before trusting any box size.
    const first = await readHead(0);
    if (first.length < 8 || !PLAUSIBLE_FIRST_BOXES.includes(first.toString("latin1", 4, 8))) {
      throw new Error("not an MP4 or QuickTime file");
    }
    let pos = 0;
    for (;;) {
      const header = parseBoxHeader(await readHead(pos), fileLen - pos);
      if (header === null) break;
      const payloadLen = header.payloadLen ?? fileLen - pos - header.headerLen;
      if (header.kind === "moov") {
        if (payloadLen > MAX_MOOV_BYTES) throw new Error("the moov box is implausibly large");
        const moov = Buffer.alloc(payloadLen);
        const { bytesRead } = await handle.read(moov, 0, payloadLen, pos + header.headerLen);
        if (bytesRead < payloadLen) throw new Error("could not read the moov box: short read");
        return moov;
      }
      pos += header.headerLen + payloadLen;
    }
    throw new Error("no moov box (the file may still be copying or recording)");
  } finally {
    await handle.close();
  }
}

/**
 * The child boxes of an in-memory payload as `[kind, payload]`. A malformed box ends the list.
 * @param {Buffer} data
 * @returns {Generator<[string, Buffer]>}
 */
function* childBoxes(data) {
  let rest = data;
  for (;;) {
    /** @type {BoxHeader | null} */
    let header;
    try {
      header = parseBoxHeader(rest.subarray(0, 16), rest.length);
    } catch {
      return;
    }
    if (header === null) return;
    const length = header.payloadLen ?? rest.length - header.headerLen;
    yield [header.kind, rest.subarray(header.headerLen, header.headerLen + length)];
    rest = rest.subarray(header.headerLen + length);
  }
}

/**
 * @param {Buffer} data
 * @param {string} kind
 * @returns {Buffer | null}
 */
function findChild(data, kind) {
  for (const [candidate, payload] of childBoxes(data)) {
    if (candidate === kind) return payload;
  }
  return null;
}

/**
 * @param {Buffer} data
 * @param {number} at
 * @returns {number | null}
 */
const beU32 = (data, at) => (at >= 0 && at + 4 <= data.length ? data.readUInt32BE(at) : null);
/**
 * @param {Buffer} data
 * @param {number} at
 * @returns {number | null}
 */
const beI32 = (data, at) => (at >= 0 && at + 4 <= data.length ? data.readInt32BE(at) : null);
/**
 * @param {Buffer} data
 * @param {number} at
 * @returns {number | null}
 */
const beU16 = (data, at) => (at >= 0 && at + 2 <= data.length ? data.readUInt16BE(at) : null);

/**
 * The coded size from the first sample description (visual sample entry: 6 reserved bytes, 2 data
 * reference bytes, 16 predefined bytes, then width and height).
 * @param {Buffer} mdia
 * @returns {[number, number] | null}
 */
function sampleEntrySize(mdia) {
  const minf = findChild(mdia, "minf");
  const stbl = minf && findChild(minf, "stbl");
  const stsd = stbl && findChild(stbl, "stsd");
  if (!stsd) return null;
  // version and flags (4), entry count (4), then the first entry box.
  const first = childBoxes(stsd.subarray(8)).next();
  if (first.done) return null;
  const entry = first.value[1];
  const width = beU16(entry, 24);
  const height = beU16(entry, 26);
  return width === null || height === null ? null : [width, height];
}

/**
 * @typedef {object} TrackSize
 * @property {boolean} enabled
 * @property {DisplaySize} display
 */

/**
 * One `trak` payload; `null` for tracks that are not video or whose header is cut short.
 * @param {Buffer} trak
 * @returns {TrackSize | null}
 */
function parseVideoTrack(trak) {
  const mdia = findChild(trak, "mdia");
  const hdlr = mdia && findChild(mdia, "hdlr");
  // version and flags (4), predefined or component type (4), handler type (4).
  if (!mdia || !hdlr || hdlr.length < 12 || hdlr.toString("latin1", 8, 12) !== "vide") return null;
  const tkhd = findChild(trak, "tkhd");
  if (!tkhd || tkhd.length < 1) return null;
  const version = tkhd[0];
  const flags = (beU32(tkhd, 0) ?? 0) & 0x00ffffff;
  // After version and flags: times, track id, reserved, duration (20 or 32 bytes), then reserved
  // (8), layer, alternate group, volume, reserved (8): the matrix follows.
  const matrixAt = 4 + (version === 1 ? 32 : 20) + 16;
  const cells = [0, 1, 3, 4].map((index) => beI32(tkhd, matrixAt + index * 4));
  const fixedWidth = beU32(tkhd, matrixAt + 36);
  const fixedHeight = beU32(tkhd, matrixAt + 40);
  const [a, b, c, d] = cells;
  if (
    a === null ||
    b === null ||
    c === null ||
    d === null ||
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    fixedWidth === null ||
    fixedHeight === null
  ) {
    return null;
  }
  let width = fixedWidth / 65536;
  let height = fixedHeight / 65536;
  if (width < 1 || height < 1) {
    // Some writers leave the track header size empty; the sample description has the coded size.
    const coded = sampleEntrySize(mdia);
    if (coded === null) return null;
    [width, height] = coded;
  }
  // A point (x, y) maps to (a*x + c*y, b*x + d*y); the matrix entries are 16.16 fixed point, so
  // the 65536 scale is divided back out of the size.
  const displayW = Math.abs(a * width) + Math.abs(c * height);
  const displayH = Math.abs(b * width) + Math.abs(d * height);
  return {
    enabled: (flags & 1) === 1,
    display: { width: Math.round(displayW / 65536), height: Math.round(displayH / 65536) },
  };
}

/** @param {DisplaySize} size */
const area = (size) => size.width * size.height;

/**
 * The display size of the main video track of an MP4, MOV or M4V file: the largest enabled video
 * track, else the largest video track.
 * @param {string} file
 * @returns {Promise<MoovResult>} A reason when the file is not readable this way.
 */
export async function readIsoBmffSize(file) {
  try {
    const moov = await readMoov(file);
    if (findChild(moov, "cmov")) return { ok: false, reason: "compressed movie header" };
    /** @type {TrackSize[]} */
    const tracks = [];
    for (const [kind, trak] of childBoxes(moov)) {
      if (kind !== "trak") continue;
      const track = parseVideoTrack(trak);
      if (track && track.display.width > 0 && track.display.height > 0) tracks.push(track);
    }
    /** @param {TrackSize[]} list */
    const largest = (list) =>
      list.reduce(
        (best, track) =>
          best === null || area(track.display) >= area(best.display) ? track : best,
        /** @type {TrackSize | null} */ (null),
      );
    const best = largest(tracks.filter((track) => track.enabled)) ?? largest(tracks);
    return best ? { ok: true, size: best.display } : { ok: false, reason: "no video track" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

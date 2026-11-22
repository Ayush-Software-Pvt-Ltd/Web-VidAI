// What makes a video file "heavy" for a browser, and how that is read from ffprobe (docs/SPEC.md
// section 11, Preview, Preview copies).
//
// A file is heavy when it is not H.264 with AAC (or no sound) in MP4 or MOV, is taller or wider than
// 1920, has more than 2 seconds between key frames, or has more than 12 Mbit/s. Beyond the SPEC's
// four, a file is also heavy when browsers fail on it or the copy must change what is seen: 10-bit
// or non-4:2:0 H.264, HDR, interlaced pictures and a rotated file (the display matrix).
//
// One ffprobe call reads the streams, the format and the packet flags of the first 10 seconds only
// (`-read_intervals %+10`), never a scan of the whole file.

/** Where the key frame distance is measured: the first seconds of the file. */
export const KEYFRAME_WINDOW_SECONDS = 10;
/** SPEC: more than this between key frames is heavy (seconds). */
export const MAX_KEYFRAME_GAP_SECONDS = 2;
/** SPEC: taller or wider than this is heavy. */
export const MAX_SIDE = 1920;
/** SPEC: more than this is heavy (bits per second). */
export const MAX_BIT_RATE = 12_000_000;

/** Pictures and sound are never copied; they are not even probed. */
const NOT_VIDEO_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".avif",
  ".svg",
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".flac",
  ".ogg",
  ".oga",
  ".opus",
  ".aif",
  ".aiff",
  ".wma",
]);

/**
 * Whether the file name says it is a picture or sound (so it is never probed).
 * @param {string} file
 * @returns {boolean}
 */
export function isNotVideoName(file) {
  const dot = file.lastIndexOf(".");
  return dot >= 0 && NOT_VIDEO_EXTENSIONS.has(file.slice(dot).toLowerCase());
}

/**
 * @typedef {object} MediaFacts What the copy needs to know about a video file. Stored beside the
 *   copy, so it is plain data.
 * @property {string} container ffprobe's `format_name` (`mov,mp4,m4a,3gp,3g2,mj2`).
 * @property {number} videoIndex The stream that is copied.
 * @property {string} videoCodec
 * @property {string} pixFmt
 * @property {number} width Coded size.
 * @property {number} height
 * @property {number} sar Pixel shape (width over height of one pixel), 1 when square.
 * @property {number} rotation Degrees of the display matrix, 0 when none (counter-clockwise, as
 *   ffprobe says it).
 * @property {string} fps `num/den` of the average frame rate.
 * @property {boolean} hdr PQ or HLG.
 * @property {string | null} colorSpace
 * @property {boolean} interlaced
 * @property {number | null} audioIndex The first sound stream, if any.
 * @property {string[]} audioCodecs Of every sound stream.
 * @property {number | null} bitRate Bits per second of the whole file.
 * @property {number | null} keyframeGap The longest time between key frames in the first
 *   seconds, the end of the window counted as one; `null` when unknown.
 * @property {number | null} duration Seconds.
 */

/** @param {unknown} value @returns {number | null} */
function numberOf(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} value @returns {Record<string, unknown>[]} */
function asRecords(value) {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

/**
 * `num/den` that is a usable frame rate, else null.
 * @param {unknown} text
 * @returns {string | null}
 */
function rateOf(text) {
  if (typeof text !== "string") return null;
  const [n, d] = text.split("/").map(Number);
  if (n === undefined || d === undefined || !Number.isFinite(n) || !Number.isFinite(d)) return null;
  if (n <= 0 || d <= 0) return null;
  return `${n}/${d}`;
}

/** @param {unknown} text @returns {number} The pixel shape from `w:h`, 1 when square or unknown. */
function sarOf(text) {
  if (typeof text !== "string") return 1;
  const [w, h] = text.split(":").map(Number);
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return 1;
  const ratio = w / h;
  return Math.abs(ratio - 1) < 1e-3 ? 1 : ratio;
}

/**
 * The turn of the display matrix: the side data's `rotation`, else the old `rotate` tag.
 * @param {Record<string, unknown>} stream
 * @returns {number}
 */
function rotationOf(stream) {
  const side = asRecords(stream["side_data_list"]).find((d) => d["rotation"] !== undefined);
  const turn = numberOf(side?.["rotation"]) ?? numberOf(asRecord(stream["tags"])["rotate"]) ?? 0;
  return turn % 360 === 0 ? 0 : turn;
}

/**
 * The longest gap between key frames in the packets read, in seconds. The end of the window counts
 * as a key frame: a clip with a single key frame has its whole length as distance, which is what a
 * seek costs there.
 * @param {Record<string, unknown>[]} packets
 * @param {number} videoIndex
 * @returns {number | null}
 */
export function keyframeGapOf(packets, videoIndex) {
  /** @type {number[]} */
  const keys = [];
  let last = null;
  for (const packet of packets) {
    if (numberOf(packet["stream_index"]) !== videoIndex) continue;
    const time = numberOf(packet["pts_time"]) ?? numberOf(packet["dts_time"]);
    if (time === null) continue;
    if (last === null || time > last) last = time;
    if (typeof packet["flags"] === "string" && packet["flags"].includes("K")) keys.push(time);
  }
  if (last === null) return null;
  if (keys.length === 0) return KEYFRAME_WINDOW_SECONDS;
  keys.sort((a, b) => a - b);
  let gap = last - (keys[keys.length - 1] ?? last);
  for (let i = 1; i < keys.length; i += 1) {
    gap = Math.max(gap, (keys[i] ?? 0) - (keys[i - 1] ?? 0));
  }
  return Math.round(gap * 1000) / 1000;
}

/**
 * The arguments of the one ffprobe call.
 * @param {string} file
 * @returns {string[]}
 */
export function probeArgs(file) {
  const stream = [
    "index",
    "codec_type",
    "codec_name",
    "pix_fmt",
    "width",
    "height",
    "sample_aspect_ratio",
    "avg_frame_rate",
    "r_frame_rate",
    "field_order",
    "color_space",
    "color_transfer",
    "bit_rate",
  ].join(",");
  return [
    "-v",
    "error",
    "-of",
    "json",
    "-read_intervals",
    `%+${KEYFRAME_WINDOW_SECONDS}`,
    "-show_entries",
    `format=format_name,duration,bit_rate:stream=${stream}:stream_disposition=attached_pic:stream_side_data=rotation:stream_tags=rotate:packet=stream_index,pts_time,dts_time,flags`,
    file,
  ];
}

/**
 * Reads the JSON of `probeArgs`.
 * @param {unknown} json
 * @returns {MediaFacts | null} `null` when the file has no moving picture (sound only, a picture,
 *   something ffprobe cannot read): such files are never copied.
 */
export function parseProbe(json) {
  const root = asRecord(json);
  const format = asRecord(root["format"]);
  const container = typeof format["format_name"] === "string" ? format["format_name"] : "";
  const streams = asRecords(root["streams"]);
  const isCover = (/** @type {Record<string, unknown>} */ s) =>
    numberOf(asRecord(s["disposition"])["attached_pic"]) === 1;
  const video = streams.find((s) => s["codec_type"] === "video" && !isCover(s));
  if (!video) return null;
  // A still picture is one video stream of an image demuxer.
  if (/image2|_pipe|^gif$|^webp/.test(container)) return null;
  const width = numberOf(video["width"]);
  const height = numberOf(video["height"]);
  const videoIndex = numberOf(video["index"]);
  if (width === null || height === null || videoIndex === null || width < 2 || height < 2) {
    return null;
  }
  const audios = streams.filter((s) => s["codec_type"] === "audio" && !isCover(s));
  const transfer = typeof video["color_transfer"] === "string" ? video["color_transfer"] : "";
  const field = typeof video["field_order"] === "string" ? video["field_order"] : "progressive";
  const rate = rateOf(video["avg_frame_rate"]) ?? rateOf(video["r_frame_rate"]) ?? "30/1";
  const bitRate = numberOf(format["bit_rate"]) ?? numberOf(video["bit_rate"]);
  const space = typeof video["color_space"] === "string" ? video["color_space"] : null;
  return {
    container,
    videoIndex,
    videoCodec: typeof video["codec_name"] === "string" ? video["codec_name"] : "",
    pixFmt: typeof video["pix_fmt"] === "string" ? video["pix_fmt"] : "",
    width,
    height,
    sar: sarOf(video["sample_aspect_ratio"]),
    rotation: rotationOf(video),
    fps: rate,
    hdr: transfer === "smpte2084" || transfer === "arib-std-b67",
    colorSpace: space === "unknown" ? null : space,
    interlaced: ["tt", "bb", "tb", "bt"].includes(field),
    audioIndex: numberOf(audios[0]?.["index"]),
    audioCodecs: audios.map((s) => (typeof s["codec_name"] === "string" ? s["codec_name"] : "")),
    bitRate,
    keyframeGap: keyframeGapOf(asRecords(root["packets"]), videoIndex),
    duration: numberOf(format["duration"]),
  };
}

/**
 * Why a file is heavy; an empty list means it plays well as it is.
 * @param {MediaFacts} facts
 * @returns {string[]}
 */
export function heavyReasons(facts) {
  /** @type {string[]} */
  const reasons = [];
  const tokens = facts.container.split(",");
  if (!tokens.includes("mp4") && !tokens.includes("mov")) reasons.push("container");
  if (facts.videoCodec !== "h264") reasons.push("codec");
  else if (facts.pixFmt !== "yuv420p" && facts.pixFmt !== "yuvj420p") reasons.push("pixel format");
  if (facts.audioCodecs.some((codec) => codec !== "aac")) reasons.push("audio codec");
  if (facts.width > MAX_SIDE || facts.height > MAX_SIDE) reasons.push("size");
  if (facts.keyframeGap !== null && facts.keyframeGap > MAX_KEYFRAME_GAP_SECONDS) {
    reasons.push("key frame distance");
  }
  if (facts.bitRate !== null && facts.bitRate > MAX_BIT_RATE) reasons.push("bit rate");
  if (facts.rotation !== 0) reasons.push("rotation");
  if (facts.hdr) reasons.push("hdr");
  if (facts.interlaced) reasons.push("interlaced");
  return reasons;
}

/**
 * Probes one file.
 * @param {{ command: string, file: string, helper: (options: { command: string, args: readonly string[], timeoutMs: number }) => Promise<{ code: number | null, stdout: string, timedOut: boolean }> }} options
 * @returns {Promise<MediaFacts | null>} `null` for a file without moving picture; throws when
 *   ffprobe cannot be run or fails, which the caller treats as "try again later".
 */
export async function probeFile({ command, file, helper }) {
  const result = await helper({ command, args: probeArgs(file), timeoutMs: 60_000 });
  if (result.timedOut) throw new Error("ffprobe took too long");
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    // A file ffprobe cannot read at all (not a video) answers with an error and no JSON.
    if (result.code !== 0) return null;
    throw new Error("ffprobe answered something that is not JSON");
  }
  return parseProbe(json);
}

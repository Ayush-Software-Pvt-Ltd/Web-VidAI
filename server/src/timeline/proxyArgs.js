// The ffmpeg arguments of a preview copy (docs/SPEC.md section 11, Preview copies): H.264 8-bit
// 4:2:0, at most 1280 on the long side with even sizes and never upscaled, the same frame rate at a
// constant rate, one key frame per second, AAC 160k stereo 48 kHz, fast start.
//
// The copy keeps the original's timing, so the same time shows the same picture: no `-ss`, the
// frame rate filter keeps the first frame's time, no edit list is dropped by hand.
//
// Rotation and pixel shape are baked in: ffmpeg applies a display matrix by itself (as the
// renderer's frame extraction does, so the copy shows what the render shows), and the target size is
// computed from the displayed size (rotation and pixel shape included).
import { videoEncoderArgs } from "../platform/encoders.js";

/** SPEC: the long side of a copy. */
export const COPY_LONG_SIDE = 1280;

/** @param {number} value @returns {number} The nearest even number, at least 2. */
function even(value) {
  return Math.max(2, 2 * Math.round(value / 2));
}

/**
 * The size of the copy: the displayed size scaled down so the long side is at most 1280, even in
 * both directions, never upscaled.
 * @param {Pick<import("./proxyProbe.js").MediaFacts, "width" | "height" | "sar" | "rotation">} facts
 * @returns {{ width: number, height: number }}
 */
export function copySize(facts) {
  const shownWidth = facts.sar === 1 ? facts.width : Math.round(facts.width * facts.sar);
  const turned = Math.abs(facts.rotation) % 180 === 90;
  const w = turned ? facts.height : shownWidth;
  const h = turned ? shownWidth : facts.height;
  const factor = Math.min(1, COPY_LONG_SIDE / Math.max(w, h));
  return { width: even(w * factor), height: even(h * factor) };
}

/**
 * The key frame distance in frames: one per second.
 * @param {string} fps `num/den`
 * @returns {number}
 */
export function gopFrames(fps) {
  const [n, d] = fps.split("/").map(Number);
  const rate = n && d ? n / d : 30;
  return Math.max(1, Math.round(rate));
}

/**
 * The tone mapping of an HDR picture to SDR (BT.709): linear light, BT.709 primaries, Hable curve,
 * back to BT.709. This is ffmpeg's documented recipe and needs `zscale` (libzimg).
 */
const TONE_MAP = [
  "zscale=t=linear:npl=100",
  "format=gbrpf32le",
  "zscale=p=bt709",
  "tonemap=tonemap=hable:desat=0",
  "zscale=t=bt709:m=bt709:r=tv",
];

/**
 * The picture filters.
 * @param {import("./proxyProbe.js").MediaFacts} facts
 * @param {{ pixFmt: string, toneMapping: boolean }} options
 * @returns {string}
 */
export function videoFilter(facts, { pixFmt, toneMapping }) {
  const size = copySize(facts);
  const scale = [`scale=${size.width}:${size.height}:flags=bicubic`];
  const filters = [];
  if (facts.interlaced) filters.push("yadif=deint=interlaced");
  filters.push(`fps=${facts.fps}`);
  if (facts.hdr && toneMapping) {
    filters.push(...scale, ...TONE_MAP);
  } else if (facts.hdr) {
    // Without zscale the colors are only converted, not tone-mapped: flat, but they play.
    filters.push(`${scale[0]}:in_color_matrix=bt2020:out_color_matrix=bt709`);
  } else if (facts.colorSpace === "bt470bg" || facts.colorSpace === "smpte170m") {
    filters.push(`${scale[0]}:in_color_matrix=bt601:out_color_matrix=bt709`);
  } else {
    filters.push(...scale);
  }
  filters.push("setsar=1", `format=${pixFmt}`);
  return filters.join(",");
}

/**
 * @typedef {object} CopyRequest
 * @property {string} input The original.
 * @property {string} output Where to write (a temporary name; the format is given explicitly).
 * @property {import("./proxyProbe.js").MediaFacts} facts
 * @property {import("../platform/encoders.js").EncoderChoice} encoder
 * @property {number} threads From the job's CPU budget.
 * @property {boolean} toneMapping Whether ffmpeg can tone-map (`zscale`).
 */

/**
 * @param {CopyRequest} request
 * @returns {string[]}
 */
export function copyArgs({ input, output, facts, encoder, threads, toneMapping }) {
  const cores = String(Math.max(1, Math.floor(threads)));
  const colorTags =
    facts.hdr || facts.colorSpace === "bt470bg" || facts.colorSpace === "smpte170m"
      ? ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]
      : [];
  return [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    input,
    "-map",
    `0:${facts.videoIndex}`,
    ...(facts.audioIndex === null ? [] : ["-map", `0:${facts.audioIndex}`]),
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-dn",
    "-sn",
    "-filter_threads",
    cores,
    "-vf",
    videoFilter(facts, { pixFmt: encoder.pixFmt, toneMapping }),
    "-fps_mode",
    "cfr",
    "-force_key_frames",
    "expr:gte(t,n_forced*1)",
    ...videoEncoderArgs(encoder, { gop: gopFrames(facts.fps), threads }),
    ...colorTags,
    ...(facts.audioIndex === null
      ? []
      : ["-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000"]),
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    output,
  ];
}

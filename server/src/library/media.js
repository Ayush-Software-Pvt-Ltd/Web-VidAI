// Long or Short from the A-roll (docs/SPEC.md section 6, "Videos").
//
// - The main A-roll's display size is its coded size with the rotation applied.
// - MP4, MOV and M4V are read in this process (`mediaMoov.js`); other containers, and MP4 family
//   files the parser cannot read, go through `ffprobe` (15 s limit). A missing `ffprobe` is not
//   remembered, so installing it fixes the detection without touching the file.
// - Taller than wide is Short, otherwise Long; an empty size is "unknown" (shown as assumed Long).
// - Results are remembered per file by path, size and modified time, in a bounded cache.
//
// There is no face-based picture check and no `arollRotation`.

import { runHelper } from "../platform/process.js";
import { findFfprobe } from "../platform/tools.js";
import { extensionOf } from "./entries.js";
import { readIsoBmffSize } from "./mediaMoov.js";

/** @typedef {import("../../../src/lib/wire/channels.ts").VideoType} VideoType */
/** @typedef {import("../../../src/lib/wire/channels.ts").ChannelVideoType} ChannelVideoType */
/** @typedef {import("../../../src/lib/wire/library.ts").TypeSource} TypeSource */
/** @typedef {import("./mediaMoov.js").DisplaySize} DisplaySize */

/**
 * @typedef {{ kind: "size", size: DisplaySize } | { kind: "unreadable", reason: string } | { kind: "toolMissing" }} ProbeResult
 *   `unreadable`: the file was examined and has no readable video track, which is final for this
 *   version of the file. `toolMissing`: `ffprobe` is not installed, worth trying again later.
 */

/** How long one `ffprobe` call may take before it is ended. */
export const FFPROBE_TIMEOUT_MS = 15_000;

/** The most files whose detection is remembered. */
export const DEFAULT_CACHE_LIMIT = 5000;

const ISO_BMFF_EXTENSIONS = ["mp4", "mov", "m4v"];

/**
 * Taller than wide is Short, otherwise Long; `null` for a degenerate size.
 * @param {DisplaySize} size
 * @returns {VideoType | null}
 */
export function videoTypeOfSize(size) {
  if (!(size.width > 0) || !(size.height > 0)) return null;
  return size.height > size.width ? "short" : "long";
}

/**
 * A video's effective type and where it comes from: the video's own override, else the channel's
 * setting when it is not `auto`, else the detected type, else Long.
 * @param {VideoType | null} typeOverride
 * @param {ChannelVideoType} channelType
 * @param {VideoType | null} detectedType
 * @returns {{ videoType: VideoType, typeSource: TypeSource }}
 */
export function resolveVideoType(typeOverride, channelType, detectedType) {
  if (typeOverride !== null) return { videoType: typeOverride, typeSource: "override" };
  if (channelType === "long" || channelType === "short") {
    return { videoType: channelType, typeSource: "channel" };
  }
  if (detectedType !== null) return { videoType: detectedType, typeSource: "detected" };
  return { videoType: "long", typeSource: "assumed" };
}

/**
 * The display size from `ffprobe -of json` output: the first video stream, rotation applied (from
 * the display matrix side data, else the `rotate` tag).
 * @param {string} text
 * @returns {DisplaySize | null}
 */
export function parseFfprobeJson(text) {
  /** @type {unknown} */
  let root;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof root !== "object" || root === null) return null;
  const streams = /** @type {{ streams?: unknown }} */ (root).streams;
  if (!Array.isArray(streams) || streams.length === 0) return null;
  const stream = /** @type {Record<string, unknown> | null} */ (streams[0]);
  if (typeof stream !== "object" || stream === null) return null;
  const { width, height } = stream;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (/** @type {number} */ (width) < 0 || /** @type {number} */ (height) < 0) return null;
  let rotation = 0;
  const sideData = stream.side_data_list;
  const side = Array.isArray(sideData)
    ? sideData.find(
        (entry) =>
          typeof entry === "object" && entry !== null && typeof entry.rotation === "number",
      )
    : undefined;
  if (side) {
    rotation = side.rotation;
  } else {
    const tags = /** @type {{ rotate?: unknown } | undefined} */ (stream.tags);
    if (tags && typeof tags.rotate === "string") {
      const parsed = Number(tags.rotate.trim());
      if (tags.rotate.trim() !== "" && Number.isFinite(parsed)) rotation = parsed;
    }
  }
  // Half a quarter turn rounds away from zero.
  const quarterTurns = Math.sign(rotation) * Math.round(Math.abs(rotation) / 90);
  const odd = Math.abs(quarterTurns % 2) === 1;
  const w = /** @type {number} */ (width);
  const h = /** @type {number} */ (height);
  return odd ? { width: h, height: w } : { width: w, height: h };
}

/**
 * @typedef {object} MediaDeps
 * @property {Readonly<Record<string, string | undefined>>} [env] Environment for finding and
 *   running `ffprobe` (`VIDAI_FFPROBE_BIN`, `PATH`).
 * @property {number} [ffprobeTimeoutMs]
 * @property {number} [cacheLimit]
 * @property {(env: Readonly<Record<string, string | undefined>>) => string | null} [locate]
 * @property {typeof runHelper} [run] Starts `ffprobe` (tests).
 */

/**
 * @param {MediaDeps} [deps]
 */
export function createMedia({
  env = process.env,
  ffprobeTimeoutMs = FFPROBE_TIMEOUT_MS,
  cacheLimit = DEFAULT_CACHE_LIMIT,
  locate = findFfprobe,
  run = runHelper,
} = {}) {
  /** @type {Map<string, VideoType | null>} */
  const cache = new Map();
  /** @type {Map<string, Promise<VideoType | null>>} */
  const inflight = new Map();

  /**
   * @param {string} file
   * @returns {Promise<ProbeResult>}
   */
  async function ffprobeSize(file) {
    const ffprobe = locate(env);
    if (ffprobe === null) return { kind: "toolMissing" };
    /** @type {import("../platform/process.js").HelperResult} */
    let result;
    try {
      result = await run({
        command: ffprobe,
        args: [
          "-v",
          "error",
          "-select_streams",
          "V:0",
          "-show_entries",
          "stream=width,height:stream_tags=rotate:stream_side_data=rotation",
          "-of",
          "json",
          file,
        ],
        env,
        timeoutMs: ffprobeTimeoutMs,
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { kind: "unreadable", reason: `could not run ffprobe: ${why}` };
    }
    if (result.timedOut) return { kind: "unreadable", reason: "ffprobe timed out" };
    const size = parseFfprobeJson(result.stdout);
    return size
      ? { kind: "size", size }
      : { kind: "unreadable", reason: "ffprobe found no video stream" };
  }

  /**
   * Reads the display size of a video file: MP4 family in this process, anything else (or an MP4
   * family file that cannot be parsed) through `ffprobe`.
   * @param {string} file
   * @returns {Promise<ProbeResult>}
   */
  async function probeDisplaySize(file) {
    if (!ISO_BMFF_EXTENSIONS.includes(extensionOf(file))) return ffprobeSize(file);
    const parsed = await readIsoBmffSize(file);
    if (parsed.ok) return { kind: "size", size: parsed.size };
    const fallback = await ffprobeSize(file);
    // The parser's reason is more useful than "ffprobe is missing", and it is final for the file.
    return fallback.kind === "toolMissing"
      ? { kind: "unreadable", reason: parsed.reason }
      : fallback;
  }

  /** @param {string} key @param {VideoType | null} type */
  function remember(key, type) {
    cache.delete(key);
    cache.set(key, type);
    if (cache.size > cacheLimit) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
  }

  return {
    probeDisplaySize,

    /**
     * The detected type of a file: `null` when nothing can be read. Remembered per path, size and
     * modified time, except when `ffprobe` is missing. Concurrent calls for one file share one
     * probe.
     * @param {{ path: string, size: number, modifiedMs: number }} file
     * @returns {Promise<VideoType | null>}
     */
    async detectType(file) {
      const key = `${file.path}\0${file.size}\0${file.modifiedMs}`;
      if (cache.has(key)) {
        const hit = /** @type {VideoType | null} */ (cache.get(key));
        remember(key, hit);
        return hit;
      }
      const running = inflight.get(key);
      if (running) return running;
      const job = (async () => {
        const probed = await probeDisplaySize(file.path);
        if (probed.kind === "toolMissing") return null;
        const type = probed.kind === "size" ? videoTypeOfSize(probed.size) : null;
        remember(key, type);
        return type;
      })().finally(() => inflight.delete(key));
      inflight.set(key, job);
      return job;
    },

    /** How many files are remembered (tests). */
    cacheSize: () => cache.size,
  };
}

/** @typedef {ReturnType<typeof createMedia>} Media */

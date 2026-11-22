// Which H.264 encoder this computer has, for the preview copies of heavy video files (docs/SPEC.md
// section 11, Preview, Preview copies; the same choice the toolkit makes, `vekit/resources.py`).
//
// The hardware encoders are VideoToolbox on a Mac, NVENC, Quick Sync and AMF on Windows (and on
// Linux where ffmpeg has them). An encoder counts only when it really starts here: ffmpeg lists
// encoders its machine cannot use, so each candidate encodes two tiny frames first. The answer is
// found once per server run and kept.
//
// The pure parts (candidate order, parsing, arguments) are exported for tests of both systems; the
// probe takes `helper` (runs a short program, `runHelper` of `process.js`) so tests need no ffmpeg.

/** @typedef {"videotoolbox" | "nvenc" | "qsv" | "amf"} Backend */

/** The hardware encoder of each backend. */
export const H264_ENCODER_NAMES = Object.freeze({
  videotoolbox: "h264_videotoolbox",
  nvenc: "h264_nvenc",
  qsv: "h264_qsv",
  amf: "h264_amf",
});

/** The pixel format each hardware encoder takes: VideoToolbox and Quick Sync want NV12. */
const PIXEL_FORMATS = Object.freeze({
  videotoolbox: "nv12",
  nvenc: "yuv420p",
  qsv: "nv12",
  amf: "yuv420p",
});

/** What the software encoder takes. */
export const SOFTWARE_PIXEL_FORMAT = "yuv420p";

/**
 * @typedef {object} EncoderChoice
 * @property {Backend | "software"} backend
 * @property {string} name The ffmpeg encoder (`h264_videotoolbox`, `libx264`).
 * @property {string} pixFmt The pixel format to give it.
 */

/** @type {EncoderChoice} */
export const SOFTWARE_ENCODER = Object.freeze({
  backend: "software",
  name: "libx264",
  pixFmt: SOFTWARE_PIXEL_FORMAT,
});

/**
 * The backends worth trying on a system, in the order they are tried.
 * @param {string} platform `process.platform`
 * @returns {Backend[]}
 */
export function candidateBackends(platform) {
  if (platform === "darwin") return ["videotoolbox"];
  if (platform === "win32") return ["nvenc", "qsv", "amf"];
  return ["nvenc", "qsv"];
}

/**
 * The candidates after the `VE_HW` setting the toolkit also reads: `none` (or `software`, `off`)
 * turns hardware off, a backend name allows only that one, anything else changes nothing.
 * @param {Backend[]} candidates
 * @param {string | undefined} forced
 * @returns {Backend[]}
 */
export function applyForced(candidates, forced) {
  const wanted = (forced ?? "").trim().toLowerCase();
  if (wanted === "none" || wanted === "software" || wanted === "off") return [];
  const only = candidates.filter((backend) => backend === wanted);
  return only.length > 0 ? only : candidates;
}

/**
 * The encoder names in the output of `ffmpeg -hide_banner -encoders`.
 * @param {string} text
 * @returns {Set<string>}
 */
export function parseEncoderNames(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[VAS][.\w]{5}\s+(\w\S*)\s/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

/**
 * The filter names in the output of `ffmpeg -hide_banner -filters`.
 * @param {string} text
 * @returns {Set<string>}
 */
export function parseFilterNames(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[T.][S.][C.]\s+(\w\S*)\s/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

/** @param {Backend} backend @returns {EncoderChoice} */
export function hardwareChoice(backend) {
  return { backend, name: H264_ENCODER_NAMES[backend], pixFmt: PIXEL_FORMATS[backend] };
}

/**
 * The ffmpeg arguments that select and set up the encoder for a preview copy: constant quality
 * where the encoder has it, High profile, one key frame per `gop` frames and no extra ones from
 * scene changes (SPEC: one key frame per second). `threads` only matters for the software one.
 * @param {EncoderChoice} choice
 * @param {{ gop: number, threads: number }} options
 * @returns {string[]}
 */
export function videoEncoderArgs(choice, { gop, threads }) {
  const common = ["-profile:v", "high", "-pix_fmt", choice.pixFmt, "-g", String(gop)];
  switch (choice.backend) {
    case "videotoolbox":
      // `-allow_sw 0` so that a missing hardware encoder is an error and not a slow software one.
      return ["-c:v", choice.name, "-allow_sw", "0", "-q:v", "60", ...common];
    case "nvenc":
      return [
        "-c:v",
        choice.name,
        "-preset",
        "p4",
        "-rc",
        "vbr",
        "-cq",
        "24",
        "-b:v",
        "0",
        "-no-scenecut",
        "1",
        ...common,
      ];
    case "qsv":
      return [
        "-c:v",
        choice.name,
        "-preset",
        "veryfast",
        "-global_quality",
        "24",
        "-adaptive_i",
        "0",
        ...common,
      ];
    case "amf":
      return [
        "-c:v",
        choice.name,
        "-quality",
        "speed",
        "-rc",
        "cqp",
        "-qp_i",
        "24",
        "-qp_p",
        "26",
        ...common,
      ];
    default:
      return [
        "-c:v",
        choice.name,
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-sc_threshold",
        "0",
        "-threads",
        String(Math.max(1, Math.floor(threads))),
        ...common,
      ];
  }
}

/**
 * The arguments of the short test encode of one hardware encoder.
 * @param {EncoderChoice} choice
 * @returns {string[]}
 */
export function probeArgs(choice) {
  return [
    "-hide_banner",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=black:s=256x256:r=25:d=0.2",
    "-frames:v",
    "2",
    "-pix_fmt",
    choice.pixFmt,
    "-c:v",
    choice.name,
    "-f",
    "null",
    "-",
  ];
}

/**
 * @typedef {object} EncodersDeps
 * @property {() => string | null} ffmpeg The program to run, or null when there is none.
 * @property {(options: { command: string, args: readonly string[], timeoutMs: number }) => Promise<{ code: number | null, stdout: string }>} helper
 * @property {string} platform
 * @property {string} [forced] `VE_HW`.
 * @property {import("../log.js").Logger} [log]
 */

/**
 * What this computer's ffmpeg can do for preview copies, found at the first question and kept.
 * @param {EncodersDeps} deps
 */
export function createEncoders(deps) {
  const { helper, platform } = deps;
  /** @type {Promise<EncoderChoice | null> | null} */
  let hardware = null;
  /** @type {Promise<boolean> | null} */
  let toneMap = null;

  /**
   * @param {string} command
   * @param {string[]} args
   * @param {number} timeoutMs
   * @returns {Promise<{ code: number | null, stdout: string }>}
   */
  async function ask(command, args, timeoutMs) {
    try {
      return await helper({ command, args, timeoutMs });
    } catch (error) {
      deps.log?.warn("preview copies: ffmpeg could not be asked about its encoders", error);
      return { code: null, stdout: "" };
    }
  }

  async function findHardware() {
    const command = deps.ffmpeg();
    if (command === null) return null;
    const candidates = applyForced(candidateBackends(platform), deps.forced);
    if (candidates.length === 0) return null;
    const listed = await ask(command, ["-hide_banner", "-encoders"], 30_000);
    const names = parseEncoderNames(listed.stdout);
    for (const backend of candidates) {
      const choice = hardwareChoice(backend);
      if (!names.has(choice.name)) continue;
      const tried = await ask(command, probeArgs(choice), 60_000);
      if (tried.code === 0) return choice;
    }
    return null;
  }

  async function findToneMapping() {
    const command = deps.ffmpeg();
    if (command === null) return false;
    const listed = await ask(command, ["-hide_banner", "-filters"], 30_000);
    const names = parseFilterNames(listed.stdout);
    return names.has("zscale") && names.has("tonemap");
  }

  return {
    /**
     * The hardware H.264 encoder that works here, or null for the software one. Probed once.
     * @returns {Promise<EncoderChoice | null>}
     */
    h264() {
      hardware ??= findHardware();
      return hardware;
    },

    /**
     * Whether ffmpeg has the filters that tone-map HDR to SDR properly (`zscale`, from libzimg,
     * and `tonemap`). Probed once.
     * @returns {Promise<boolean>}
     */
    toneMapping() {
      toneMap ??= findToneMapping();
      return toneMap;
    },
  };
}

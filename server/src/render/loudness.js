// Levelling the sound of a finished render (docs/SPEC.md section 12): the project's sound is not
// levelled (a voice track, music and effects are mixed as they are), so the final file's audio
// goes through a two-pass `loudnorm` to -14 LUFS integrated with a true peak of -1 dBTP. The
// video stream is copied untouched. Pure functions here; `runner.js` runs ffmpeg.

/** The target loudness, in LUFS (integrated). */
export const TARGET_LUFS = -14;
/** The ceiling of the true peak, in dBTP. */
export const TARGET_TRUE_PEAK = -1;
/** The loudness range loudnorm aims for (its default; speech with music stays natural). */
export const TARGET_LRA = 11;
/** A file already this close to the target (in LU) with a fine peak is left as it is. */
export const SKIP_WITHIN_LU = 0.5;
/** The audio of a levelled file. */
export const AUDIO_BITRATE = "320k";
export const AUDIO_RATE = 48000;

const FILTER = `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TRUE_PEAK}:LRA=${TARGET_LRA}`;

/**
 * @typedef {object} Measured What the first pass saw.
 * @property {number} input_i Integrated loudness, LUFS.
 * @property {number} input_tp True peak, dBTP.
 * @property {number} input_lra Loudness range, LU.
 * @property {number} input_thresh Gate threshold, LUFS.
 * @property {number} target_offset Gain loudnorm suggests, LU.
 */

/**
 * First pass: measure the audio only and print the numbers as JSON on stderr.
 * @param {string} file
 * @returns {string[]}
 */
export function measureArgs(file) {
  return [
    "-hide_banner",
    "-nostdin",
    "-i",
    file,
    "-map",
    "0:a:0",
    "-vn",
    "-af",
    `${FILTER}:print_format=json`,
    "-f",
    "null",
    "-",
  ];
}

/**
 * The JSON block loudnorm prints at the end of stderr.
 * @param {string} stderr
 * @returns {Measured | null} `null` when there is none or a value is not a finite number (silent
 *   sound measures `-inf`: there is nothing to level).
 */
export function parseMeasured(stderr) {
  const end = stderr.lastIndexOf("}");
  const start = end === -1 ? -1 : stderr.lastIndexOf("{", end);
  if (start === -1) return null;
  try {
    const value = /** @type {Record<string, unknown>} */ (JSON.parse(stderr.slice(start, end + 1)));
    const read = (/** @type {string} */ key) => {
      const raw = value[key];
      const number = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
      return Number.isFinite(number) ? number : null;
    };
    const input_i = read("input_i");
    const input_tp = read("input_tp");
    const input_lra = read("input_lra");
    const input_thresh = read("input_thresh");
    const target_offset = read("target_offset");
    if (
      input_i === null ||
      input_tp === null ||
      input_lra === null ||
      input_thresh === null ||
      target_offset === null
    ) {
      return null;
    }
    return { input_i, input_tp, input_lra, input_thresh, target_offset };
  } catch {
    return null;
  }
}

/**
 * Whether the second pass is needed: not when the loudness is within 0.5 LU of the target and the
 * peak is already at or under the ceiling.
 * @param {Measured} measured
 * @returns {boolean}
 */
export function needsLevelling(measured) {
  const close = Math.abs(measured.input_i - TARGET_LUFS) <= SKIP_WITHIN_LU + 1e-9;
  const peakFine = measured.input_tp <= TARGET_TRUE_PEAK + 1e-9;
  return !(close && peakFine);
}

/** @param {number} n @returns {string} A number as ffmpeg reads it. */
const num = (n) => String(Math.round(n * 100) / 100);

/**
 * Second pass: the video is copied, the audio is levelled with the measured values (so the
 * gain is one straight line, `linear=true`), AAC 320k at 48 kHz (loudnorm works at 192 kHz
 * inside), the index at the front for playing while downloading.
 * @param {string} input
 * @param {string} output
 * @param {Measured} measured
 * @returns {string[]}
 */
export function levelArgs(input, output, measured) {
  const filter =
    `${FILTER}:measured_I=${num(measured.input_i)}:measured_TP=${num(measured.input_tp)}` +
    `:measured_LRA=${num(measured.input_lra)}:measured_thresh=${num(measured.input_thresh)}` +
    `:offset=${num(measured.target_offset)}:linear=true:print_format=summary`;
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c:v",
    "copy",
    "-af",
    filter,
    "-c:a",
    "aac",
    "-b:a",
    AUDIO_BITRATE,
    "-ar",
    String(AUDIO_RATE),
    "-movflags",
    "+faststart",
    output,
  ];
}

/**
 * The `ffprobe` call that tells the streams and the video's frame count (counted from packets,
 * which is fast).
 * @param {string} file
 * @returns {string[]}
 */
export function probeArgs(file) {
  return [
    "-v",
    "error",
    "-count_packets",
    "-show_entries",
    "stream=codec_type,codec_name,nb_read_packets,width,height,r_frame_rate",
    "-of",
    "json",
    file,
  ];
}

/**
 * @typedef {object} FileFacts
 * @property {boolean} hasVideo
 * @property {boolean} hasAudio
 * @property {number | null} videoFrames
 * @property {number | null} width
 * @property {number | null} height
 */

/**
 * @param {string} stdout The output of `probeArgs`.
 * @returns {FileFacts | null} `null` when it is not ffprobe's JSON.
 */
export function parseProbe(stdout) {
  try {
    const value = /** @type {{ streams?: unknown }} */ (JSON.parse(stdout));
    if (!Array.isArray(value.streams)) return null;
    const streams = /** @type {Record<string, unknown>[]} */ (value.streams);
    const video = streams.find((s) => s.codec_type === "video");
    const frames = video === undefined ? Number.NaN : Number(video.nb_read_packets);
    return {
      hasVideo: video !== undefined,
      hasAudio: streams.some((s) => s.codec_type === "audio"),
      videoFrames: Number.isFinite(frames) ? frames : null,
      width: typeof video?.width === "number" ? video.width : null,
      height: typeof video?.height === "number" ? video.height : null,
    };
  } catch {
    return null;
  }
}

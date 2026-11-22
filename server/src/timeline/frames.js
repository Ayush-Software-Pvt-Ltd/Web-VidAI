// Seconds and whole frames (docs/SPEC.md sections 10 and 11).
//
// Frame rate representation: `Fps = { num, den }`, two positive integers with no common factor, so
// 30 is `{ 30, 1 }` and 29.97 is `{ 30000, 1001 }`. Frame n starts at n * den / num seconds, computed
// with integer arithmetic (BigInt) wherever a decision depends on it.
// Accepted texts for `data-fps`: an integer ("30"), a rational ("30000/1001"), or a decimal ("29.97").
// A decimal that is within 0.0006 of k * 1000 / 1001 (23.976, 29.97, 59.94 ...) means that rational,
// because nobody means 2997/100 fps; any other decimal is the exact decimal fraction ("12.5" is 25/2).
//
// Reading: a time is a plain decimal number of seconds ("12", "0.5", "1.033333333"). It "falls on a
// frame boundary" when it is within FRAME_TOLERANCE_PERCENT / 100 of a frame (1/100 frame), which is
// far more than any rounding of a text with 6 decimals (files written by older tools still parse).
// Writing: `framesToSecondsText` gives the shortest text of at most 9 decimals whose value is within
// 1e-9 seconds of the exact frame time. Six decimals measurably made the renderer show a source frame
// one early at 30 and 24000/1001 fps, nine did not (coordinator render test, 2026-11-22).

/** @typedef {{ num: number, den: number }} Fps */

/** A time is on a frame boundary when it is within this many percent of a frame of one. */
export const FRAME_TOLERANCE_PERCENT = 1n;
/** Largest number of decimals written for a time. */
export const MAX_DECIMALS = 9;
/** Written text is never further than this many seconds from the exact frame time. */
export const WRITE_TOLERANCE_SECONDS = 1e-9;

const MIN_FPS = 1;
const MAX_FPS = 240;

/** @param {number} a @param {number} b */
function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * @param {number} num
 * @param {number} den
 * @returns {Fps | null} The reduced rate, or null unless both are positive integers and the rate
 *   is between 1 and 240 frames per second.
 */
export function makeFps(num, den) {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) return null;
  const g = gcd(num, den);
  const fps = { num: num / g, den: den / g };
  const value = fps.num / fps.den;
  return value >= MIN_FPS && value <= MAX_FPS ? fps : null;
}

/**
 * Reads a frame rate from the text of `data-fps` or `edit.json` (see the top of this file).
 * @param {string | number | null | undefined} value
 * @returns {Fps | null}
 */
export function parseFps(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    if (Number.isInteger(value)) return makeFps(value, 1);
    return parseFps(String(value));
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  let match = /^(\d{1,9})\s*\/\s*(\d{1,9})$/.exec(text);
  if (match) return makeFps(Number(match[1]), Number(match[2]));
  match = /^(\d{1,9})$/.exec(text);
  if (match) return makeFps(Number(match[1]), 1);
  match = /^(\d{1,4})\.(\d{1,12})$/.exec(text);
  if (match) {
    const x = Number(text);
    const k = Math.round(x);
    if (!Number.isInteger(x) && Math.abs(x - (k * 1000) / 1001) <= 0.0006)
      return makeFps(k * 1000, 1001);
    if (match[2].length > 6) return null;
    return makeFps(Number(match[1] + match[2]), 10 ** match[2].length);
  }
  return null;
}

/** @param {Fps} fps @returns {string} `30` or `30000/1001`. */
export function fpsToString(fps) {
  return fps.den === 1 ? String(fps.num) : `${fps.num}/${fps.den}`;
}

/** @param {Fps} fps @returns {number} */
export function fpsToNumber(fps) {
  return fps.num / fps.den;
}

/** @param {Fps | null} a @param {Fps | null} b */
export function sameFps(a, b) {
  return a !== null && b !== null && a.num === b.num && a.den === b.den;
}

/**
 * A plain decimal as `int / scale`, or null.
 * @param {string | number} value
 * @returns {{ int: bigint, scale: bigint } | null}
 */
function parseDecimal(value) {
  let text;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    text = value.toFixed(9);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return null;
  }
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match) return null;
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (whole === "" && fraction === "") return null;
  if (whole.length + fraction.length > 30) return null;
  return { int: BigInt(whole + fraction || "0"), scale: 10n ** BigInt(fraction.length) };
}

/**
 * @typedef {Object} FrameReading
 * @property {number} exact The time in frames, fractional when it is between two frames.
 * @property {number} frames The nearest whole frame.
 * @property {boolean} onFrame Whether the time falls on a frame boundary (within the tolerance).
 */

/**
 * Reads a time in seconds as frames.
 * @param {string | number | null | undefined} value Plain decimal seconds ("12", "0.5"); no units.
 * @param {Fps} fps
 * @returns {FrameReading | null} Null when the text is not a plain non-negative decimal number.
 */
export function readSeconds(value, fps) {
  if (value === null || value === undefined) return null;
  const decimal = parseDecimal(value);
  if (!decimal) return null;
  const a = decimal.int * BigInt(fps.num);
  const b = decimal.scale * BigInt(fps.den);
  const floor = a / b;
  const frames = 2n * (a % b) >= b ? floor + 1n : floor;
  const distance = a > frames * b ? a - frames * b : frames * b - a;
  return {
    exact: Number(a) / Number(b),
    frames: Number(frames),
    onFrame: distance * 100n <= b * FRAME_TOLERANCE_PERCENT,
  };
}

/**
 * The whole frame a time in seconds falls on (rounded to the nearest), or null for a bad text.
 * @param {string | number | null | undefined} value
 * @param {Fps} fps
 * @returns {number | null}
 */
export function secondsToFrames(value, fps) {
  return readSeconds(value, fps)?.frames ?? null;
}

/**
 * Whether a time falls on a frame boundary within the tolerance (false for a bad text).
 * @param {string | number | null | undefined} value
 * @param {Fps} fps
 * @returns {boolean}
 */
export function isOnFrameBoundary(value, fps) {
  return readSeconds(value, fps)?.onFrame ?? false;
}

/**
 * The start of frame `frames` in seconds as a number (for display and arithmetic, never for files).
 * @param {number} frames
 * @param {Fps} fps
 * @returns {number}
 */
export function framesToSeconds(frames, fps) {
  return (frames * fps.den) / fps.num;
}

/**
 * Seconds as text for a file: the shortest decimal (at most 9 places) within 1e-9 seconds of the
 * start of frame `frames`, so it reads back to the same frame and renders on it. A fractional frame
 * count (a media in-point between two frames) is written the same way.
 * @param {number} frames A non-negative number of frames; whole in nearly every case.
 * @param {Fps} fps
 * @returns {string} For example `0`, `0.04`, `0.033333333`.
 */
export function framesToSecondsText(frames, fps) {
  if (!Number.isFinite(frames) || frames < 0) throw new RangeError("frames must be 0 or more");
  if (Number.isInteger(frames)) return wholeFramesText(BigInt(frames), fps);
  const seconds = framesToSeconds(frames, fps);
  for (let d = 0; d <= MAX_DECIMALS; d++) {
    const scaled = Math.round(seconds * 10 ** d);
    if (Math.abs(scaled / 10 ** d - seconds) <= WRITE_TOLERANCE_SECONDS || d === MAX_DECIMALS) {
      return decimalText(BigInt(scaled), d);
    }
  }
  /* c8 ignore next */
  return String(seconds);
}

/** @param {bigint} frames @param {Fps} fps */
function wholeFramesText(frames, fps) {
  const num = BigInt(fps.num);
  const numerator = frames * BigInt(fps.den);
  for (let d = 0; d <= MAX_DECIMALS; d++) {
    const pow = 10n ** BigInt(d);
    const scaled = (2n * numerator * pow + num) / (2n * num);
    const error =
      scaled * num > numerator * pow
        ? scaled * num - numerator * pow
        : numerator * pow - scaled * num;
    // error / (num * pow) seconds <= 1e-9
    if (error * 1_000_000_000n <= num * pow || d === MAX_DECIMALS) return decimalText(scaled, d);
  }
  /* c8 ignore next */
  return "0";
}

/** @param {bigint} scaled @param {number} decimals */
function decimalText(scaled, decimals) {
  if (decimals === 0) return scaled.toString();
  const digits = scaled.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/**
 * The length of a source in project frames (fractional when the rates differ).
 * @param {{ frames: number, fps: Fps }} source
 * @param {Fps} projectFps
 * @returns {number}
 */
export function sourceLengthFrames(source, projectFps) {
  return (
    Number(BigInt(source.frames) * BigInt(projectFps.num) * BigInt(source.fps.den)) /
    Number(BigInt(projectFps.den) * BigInt(source.fps.num))
  );
}

// What the toolkit's speech recognition and video encoding really run on, for the System page
// (docs/SPEC.md section 5, "System page"): the answer of `ve.py hardware` (the same logic as
// `ve.py doctor`), turned into two plain lines each with a problem sentence when this computer
// has an NVIDIA GPU that is not used. Asked at most once per Prepare and per 30 seconds, because
// the answer costs a trial encode and loading the speech package.

import { HARDWARE_UNKNOWN } from "../system.js";

/** @typedef {import("../../../src/lib/wire/system.ts").SystemHardware} SystemHardware */
/** @typedef {import("../../../src/lib/wire/system.ts").SystemAcceleration} SystemAcceleration */

/** How long an answer is reused when nothing was prepared in between. */
const TTL_MS = 30_000;

/**
 * The last JSON object printed by `ve.py hardware`.
 * @param {readonly string[]} lines
 * @returns {unknown}
 */
export function parseHardwareLines(lines) {
  for (const line of [...lines].reverse()) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      return JSON.parse(text);
    } catch {
      // Not the answer; look further up.
    }
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value
 * @returns {string | null}
 */
const textOf = (value) => (typeof value === "string" && value !== "" ? value : null);

/**
 * Turns the toolkit's answer into the page's lines.
 * @param {unknown} answer `{ speech: { device, summary, problem }, video: { encoder, hevc, decoder, hardware, failed } | null }`
 * @param {string | null} nvidia The NVIDIA GPU of this computer, if any.
 * @returns {SystemHardware}
 */
export function hardwareView(answer, nvidia) {
  if (!isRecord(answer)) return { ...HARDWARE_UNKNOWN, nvidia };
  /** @type {SystemAcceleration} */
  let speech = HARDWARE_UNKNOWN.speech;
  if (isRecord(answer.speech)) {
    const device = answer.speech.device === "gpu" ? "gpu" : "cpu";
    speech = {
      using: device,
      summary: textOf(answer.speech.summary) ?? (device === "gpu" ? "GPU" : "CPU"),
      problem: textOf(answer.speech.problem),
    };
  }
  /** @type {SystemAcceleration} */
  let video = HARDWARE_UNKNOWN.video;
  if (isRecord(answer.video)) {
    const v = answer.video;
    const hardware = v.hardware === true;
    const encoder = textOf(v.encoder) ?? "libx264";
    const hevc = textOf(v.hevc);
    const decoder = textOf(v.decoder) ?? "software";
    const failed = Array.isArray(v.failed) ? v.failed.filter(isRecord) : [];
    const names = hevc !== null && hevc !== encoder ? `${encoder} and ${hevc}` : encoder;
    /** @type {string | null} */
    let problem = null;
    if (!hardware && nvidia !== null) {
      const why = failed.find((f) => String(f.encoder).includes("nvenc"));
      problem = why
        ? `${nvidia} is installed but ffmpeg could not start ${String(why.encoder)}: ${String(why.error)}. Update the NVIDIA driver or use an ffmpeg build that matches it.`
        : `${nvidia} is installed but this ffmpeg has no NVENC encoder. Install a full ffmpeg build (with NVENC) and press Prepare.`;
    }
    video = {
      using: hardware ? "gpu" : "cpu",
      summary: hardware
        ? `${names}, decoding with ${decoder}`
        : `${names} (software), decoding ${decoder === "software" ? "in software" : `with ${decoder}`}`,
      problem,
    };
  }
  return { nvidia, speech, video };
}

/**
 * @typedef {object} HardwareProbeDeps
 * @property {ReturnType<typeof import("./paths.js").toolkitPaths>} paths
 * @property {import("./run.js").Runner} runner
 * @property {() => Record<string, string | undefined>} env The environment of the toolkit's programs.
 * @property {import("../db/open.js").Clock} clock
 * @property {() => string | null} nvidia The NVIDIA GPU's name, or `null`.
 * @property {() => string} generation Changes whenever a Prepare ends (a new answer is needed).
 * @property {(file: string) => boolean} exists
 * @property {number} [timeoutMs]
 */

/**
 * @param {HardwareProbeDeps} deps
 * @returns {() => Promise<SystemHardware>}
 */
export function createHardwareProbe(deps) {
  /** @type {{ at: number, generation: string, value: Promise<SystemHardware> } | null} */
  let cached = null;

  /** @returns {Promise<SystemHardware>} */
  async function ask() {
    const nvidia = deps.nvidia();
    if (!deps.exists(deps.paths.python) || !deps.exists(deps.paths.driver)) {
      return { ...HARDWARE_UNKNOWN, nvidia };
    }
    const result = await deps.runner({
      command: deps.paths.python,
      args: [deps.paths.driver, "hardware"],
      cwd: deps.paths.root,
      env: deps.env(),
      timeoutMs: deps.timeoutMs ?? 90_000,
    });
    if (result.code !== 0) return { ...HARDWARE_UNKNOWN, nvidia };
    return hardwareView(parseHardwareLines(result.tail), nvidia);
  }

  return () => {
    const generation = deps.generation();
    if (cached && cached.generation === generation && deps.clock.now() - cached.at < TTL_MS) {
      return cached.value;
    }
    const value = ask().catch(() => ({ ...HARDWARE_UNKNOWN, nvidia: deps.nvidia() }));
    cached = { at: deps.clock.now(), generation, value };
    return value;
  };
}

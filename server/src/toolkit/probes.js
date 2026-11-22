// The System page's probes for the programs this area owns: ffmpeg, ffprobe and Python
// (docs/SPEC.md section 5, "System page"). The probes of Claude Code, OpenCode 2 and HyperFrames
// come from their own modules.

import fs from "node:fs";
import { runHelper } from "../platform/process.js";
import {
  VERSION_ARGS,
  formatPythonVersion,
  isSupportedPython,
  parsePythonVersion,
  pythonCandidates as defaultCandidates,
  pythonInstallHint,
} from "../platform/python.js";
import { findFfmpeg, findFfprobe } from "../platform/tools.js";

/** @typedef {import("../system.js").Probe} Probe */

/** The hardware encoders ffmpeg may list, by the word that names them. */
const HARDWARE = ["videotoolbox", "nvenc", "qsv", "amf"];

/**
 * @typedef {object} ProbeDeps
 * @property {ReturnType<typeof import("./paths.js").toolkitPaths>} paths
 * @property {Readonly<Record<string, string | undefined>>} [env]
 * @property {NodeJS.Platform} [platform]
 * @property {() => string | null} [findFfmpeg]
 * @property {() => string | null} [findFfprobe]
 * @property {() => import("../platform/python.js").PythonCandidate[]} [pythonCandidates]
 * @property {(file: string) => boolean} [exists]
 * @property {(command: string, args: readonly string[]) => Promise<string | null>} [output]
 *   Runs a program and returns its stdout, `null` when it failed (tests replace it).
 */

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {Promise<string | null>}
 */
async function runOutput(command, args) {
  try {
    const result = await runHelper({ command, args, timeoutMs: 10_000 });
    return result.code === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

/**
 * The version in the first line of `ffmpeg -version` ("ffmpeg version 7.1.1 Copyright ...").
 * @param {string} text
 * @returns {string | null}
 */
export function parseFfVersion(text) {
  return /version\s+(\S+)/.exec(text.split("\n")[0] ?? "")?.[1] ?? null;
}

/**
 * The hardware encoders in the output of `ffmpeg -encoders`.
 * @param {string} text
 * @returns {string[]}
 */
export function parseHardware(text) {
  const found = new Set();
  for (const word of HARDWARE) {
    if (new RegExp(`\\b\\w+_${word}\\b`).test(text)) found.add(word);
  }
  return [...found];
}

/**
 * The probes for ffmpeg, ffprobe and Python.
 * @param {ProbeDeps} deps
 * @returns {{ ffmpeg: Probe, ffprobe: Probe, python: Probe }}
 */
export function createToolProbes(deps) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const output = deps.output ?? runOutput;
  const exists = deps.exists ?? ((file) => fs.existsSync(file));
  const ffmpegFinder = deps.findFfmpeg ?? (() => findFfmpeg(env));
  const ffprobeFinder = deps.findFfprobe ?? (() => findFfprobe(env));
  const candidates = deps.pythonCandidates ?? (() => defaultCandidates(env, { platform }));

  return {
    async ffmpeg() {
      const file = ffmpegFinder();
      if (file === null) return { found: false, note: "ffmpeg was not found. Install it and press Prepare." };
      const [version, encoders] = await Promise.all([
        output(file, ["-version"]),
        output(file, ["-hide_banner", "-encoders"]),
      ]);
      const hardware = encoders === null ? [] : parseHardware(encoders);
      return {
        found: true,
        path: file,
        version: version === null ? null : parseFfVersion(version),
        note:
          hardware.length > 0
            ? `Hardware encoders found: ${hardware.join(", ")}.`
            : "No hardware encoder found; video is encoded in software.",
      };
    },

    async ffprobe() {
      const file = ffprobeFinder();
      if (file === null) return { found: false, note: "ffprobe was not found. It comes with ffmpeg." };
      const version = await output(file, ["-version"]);
      return { found: true, path: file, version: version === null ? null : parseFfVersion(version) };
    },

    async python() {
      // The toolkit's own environment when it exists, else the first Python it could be made from.
      /** @type {{ command: string, args: string[], label: string }[]} */
      const list = exists(deps.paths.python)
        ? [{ command: deps.paths.python, args: [], label: deps.paths.python }]
        : candidates();
      for (const candidate of list) {
        const text = await output(candidate.command, [...candidate.args, ...VERSION_ARGS]);
        const version = text === null ? null : parsePythonVersion(text);
        if (version === null || !isSupportedPython(version)) continue;
        return {
          found: true,
          path: candidate.label,
          version: formatPythonVersion(version),
          note: list[0]?.command === deps.paths.python ? "The toolkit's environment." : null,
        };
      }
      return { found: false, note: pythonInstallHint(platform) };
    },
  };
}

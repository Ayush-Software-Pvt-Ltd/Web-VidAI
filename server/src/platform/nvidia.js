// Finding out whether this computer has an NVIDIA GPU (docs/SPEC.md section 7, "Toolkit"): the
// toolkit installs the CUDA libraries for speech recognition only then. The driver brings
// `nvidia-smi` with it on Windows and Linux; its answer is the one fact used. macOS has no NVIDIA
// GPU the toolkit can use, so nothing is run there.

import fs from "node:fs";
import { runHelper } from "./process.js";

/** The arguments that make `nvidia-smi` print one GPU name per line. */
export const SMI_ARGS = Object.freeze(["--query-gpu=name", "--format=csv,noheader"]);

/**
 * @typedef {object} NvidiaFacts
 * @property {boolean} present An NVIDIA GPU is installed and its driver answers.
 * @property {string | null} name The first GPU's name, for example `NVIDIA GeForce RTX 5060 Ti`.
 */

/**
 * The places `nvidia-smi` may be, in the order to try. A bare name is looked up in the PATH.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {string} platform
 * @returns {string[]}
 */
export function smiCandidates(env, platform) {
  if (platform === "win32") {
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
    const programs = env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files";
    return [
      `${root}\\System32\\nvidia-smi.exe`,
      `${programs}\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe`,
      "nvidia-smi.exe",
    ];
  }
  if (platform === "linux")
    return ["nvidia-smi", "/usr/bin/nvidia-smi", "/usr/local/nvidia/bin/nvidia-smi"];
  return [];
}

/**
 * The GPU names in the answer of `SMI_ARGS`.
 * @param {string | null} stdout
 * @returns {string[]}
 */
export function parseGpuNames(stdout) {
  return (stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line !== "" && !/^(failed|nvidia-smi has failed|no devices)/iu.test(line));
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<string | null>}
 */
async function runWithHelper(command, args, timeoutMs) {
  try {
    const result = await runHelper({ command, args, timeoutMs });
    return result.code === 0 && !result.timedOut ? result.stdout : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {object} NvidiaDeps
 * @property {string} [platform] Default: this computer's.
 * @property {Readonly<Record<string, string | undefined>>} [env]
 * @property {(command: string, args: readonly string[], timeoutMs: number) => Promise<string | null>} [run]
 * @property {(file: string) => boolean} [exists]
 */

/**
 * Whether an NVIDIA GPU is installed, by asking `nvidia-smi`. Never throws; not being able to ask
 * means "none".
 * @param {NvidiaDeps} [deps]
 * @returns {Promise<NvidiaFacts>}
 */
export async function detectNvidia(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const run = deps.run ?? runWithHelper;
  const exists = deps.exists ?? ((/** @type {string} */ file) => fs.existsSync(file));
  for (const command of smiCandidates(env, platform)) {
    const isPath = command.includes("\\") || command.includes("/");
    if (isPath && !exists(command)) continue;
    const names = parseGpuNames(await run(command, SMI_ARGS, 15_000));
    if (names.length > 0) return { present: true, name: names[0] ?? null };
  }
  return { present: false, name: null };
}

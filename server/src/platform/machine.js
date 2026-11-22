// The facts about this computer that the agent's first message states in one line (docs/SPEC.md
// section 8, "Prompt"): operating system and version, processor model and logical processors,
// memory and graphics adapter. Asked once, kept for the life of the probe, and never a reason for
// a job to fail: a part that cannot be found is left out (`null`).

import nodeOs from "node:os";
import { runHelper } from "./process.js";
import * as macos from "./machine.macos.js";
import * as windows from "./machine.windows.js";

/**
 * @typedef {object} MachineFacts
 * @property {string} os `macOS`, `Windows`, `Linux` (or the platform name).
 * @property {string | null} osVersion For example `15.4.1`, `11 Pro (10.0.26100)`.
 * @property {string | null} cpu The processor model, without (R) and (TM).
 * @property {number | null} logicalCores Logical processors.
 * @property {number | null} memoryGb Installed memory in whole gigabytes.
 * @property {string | null} gpu The graphics adapter names, `; ` between several.
 */

/**
 * Runs a short program and returns what it printed, or `null` when it failed, was not found or
 * ran out of time.
 * @typedef {(command: string, args: readonly string[], timeoutMs: number) => Promise<string | null>} RunProgram
 */

/**
 * @typedef {object} OsModule The part of `node:os` that is used.
 * @property {() => { model: string }[]} cpus
 * @property {() => number} totalmem
 * @property {() => string} release
 */

/**
 * @typedef {object} MachineDeps
 * @property {string} [platform] Default: this computer's (`process.platform`).
 * @property {OsModule} [os]
 * @property {RunProgram} [run]
 * @property {Readonly<Record<string, string | undefined>>} [env]
 * @property {number} [timeoutMs] Limit of each program (default 10 seconds).
 */

/** @type {RunProgram} */
async function runWithHelper(command, args, timeoutMs) {
  try {
    const result = await runHelper({ command, args, timeoutMs });
    return result.code === 0 && !result.timedOut ? result.stdout : null;
  } catch {
    return null;
  }
}

/**
 * A processor model as people write it: no (R) and (TM), single spaces.
 * @param {string | undefined} model
 * @returns {string | null}
 */
export function tidyCpuName(model) {
  const text = (model ?? "")
    .replace(/\((R|TM|tm|r)\)/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return text === "" ? null : text;
}

/**
 * The name of the operating system for a Node platform name.
 * @param {string} platform
 * @returns {string}
 */
export function osName(platform) {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

/**
 * @param {string[]} names
 * @returns {string | null}
 */
const joinNames = (names) => (names.length === 0 ? null : names.join("; "));

/**
 * Makes a probe with its own cache.
 * @param {MachineDeps} [deps]
 * @returns {{ facts(): Promise<MachineFacts> }}
 */
export function createMachineProbe(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const os = deps.os ?? nodeOs;
  const run = deps.run ?? runWithHelper;
  const env = deps.env ?? process.env;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  /** @type {Promise<MachineFacts> | null} */
  let cached = null;

  /** The parts that need a program. @returns {Promise<{ osVersion: string | null, gpus: string[] }>} */
  async function fromPrograms() {
    if (platform === "darwin") {
      const [version, gpus] = await Promise.all([
        run(macos.SW_VERS, macos.VERSION_ARGS, timeoutMs),
        run(macos.SYSTEM_PROFILER, macos.GPU_ARGS, timeoutMs),
      ]);
      return { osVersion: macos.parseVersion(version), gpus: macos.parseGpuNames(gpus) };
    }
    if (platform === "win32") {
      const answer = await run(windows.powershellPath(env), windows.ARGS, timeoutMs);
      return windows.parseWindowsFacts(answer);
    }
    return { osVersion: null, gpus: [] };
  }

  async function collect() {
    /** @type {{ osVersion: string | null, gpus: string[] }} */
    let found = { osVersion: null, gpus: [] };
    try {
      found = await fromPrograms();
    } catch {
      // Unknown parts are left out; a job never fails because of this.
    }
    /** @type {{ model: string }[]} */
    let cpus = [];
    try {
      cpus = os.cpus();
    } catch {
      // No processor list: the processor is left out.
    }
    let memory = 0;
    try {
      memory = os.totalmem();
    } catch {
      // No memory size.
    }
    /** @type {string | null} */
    let release = null;
    if (platform !== "darwin" && platform !== "win32") {
      try {
        release = os.release();
      } catch {
        // No release.
      }
    }
    /** @type {MachineFacts} */
    const facts = {
      os: osName(platform),
      osVersion: found.osVersion ?? release,
      cpu: tidyCpuName(cpus[0]?.model),
      logicalCores: cpus.length > 0 ? cpus.length : null,
      memoryGb: memory > 0 ? Math.max(1, Math.round(memory / 1024 ** 3)) : null,
      gpu: joinNames(found.gpus),
    };
    return facts;
  }

  return {
    /** The facts of this computer; asked on the first call, then the same answer. */
    facts() {
      cached ??= collect();
      return cached;
    },
  };
}

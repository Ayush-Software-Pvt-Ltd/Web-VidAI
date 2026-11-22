// Makes the renderer's browser use the high-performance GPU on a Windows computer with an NVIDIA
// card (docs/SPEC.md section 9, "Graphics in the browser").
//
// HyperFrames draws graphics and timeline frames in headless Chrome, which on Windows starts
// ANGLE on Direct3D 11 without choosing an adapter, so it gets the default one: often the
// processor's integrated GPU, with the NVIDIA card idle. The official way to choose is the
// per-program preference of Settings > System > Display > Graphics, which Windows keeps in
// HKCU\Software\Microsoft\DirectX\UserGpuPreferences (value name: the full path of the program,
// data: `GpuPreference=2;`, "high performance"). This file writes it with the system's `reg.exe`.
// Nothing here does anything on another system, and nothing here throws.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHelper } from "./process.js";
import { detectNvidia } from "./nvidia.js";

/** The registry key of the per-program graphics preferences (the current user's). */
export const PREFERENCE_KEY = "HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences";
/** The value Windows writes for "High performance". */
export const PREFERENCE_DATA = "GpuPreference=2;";

const REG_TIMEOUT_MS = 10_000;
const win = path.win32;

/**
 * @typedef {object} RegResult
 * @property {number | null} code
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} [timedOut]
 */

/**
 * @typedef {object} GpuPreferenceDeps
 * @property {string} [platform] Default: this computer's.
 * @property {Readonly<Record<string, string | undefined>>} [env]
 * @property {string} [home] The user's home folder (default: this user's).
 * @property {(command: string, args: readonly string[]) => Promise<RegResult>} [run] Runs `reg.exe`.
 * @property {() => Promise<{ present: boolean, name: string | null }>} [nvidia]
 * @property {(file: string) => boolean} [exists]
 * @property {(dir: string) => string[]} [list] The names in a folder (empty when it is missing).
 * @property {import("../log.js").Logger} [log]
 */

/**
 * @typedef {object} GpuPreferenceResult
 * @property {string[]} applied Programs whose preference was written now.
 * @property {string[]} already Programs that had it.
 * @property {string[]} failed Programs that could not be set.
 * @property {string | null} skipped Why nothing was done (not Windows, no NVIDIA GPU), else `null`.
 */

/**
 * The path of `reg.exe`.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {string}
 */
export function regCommand(env) {
  return `${env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows"}\\System32\\reg.exe`;
}

/**
 * Every browser program HyperFrames may start on Windows, in its order of preference: the cache
 * of its own installed headless shell, the cache of Puppeteer, and Google Chrome. Only those that
 * exist.
 * @param {object} options
 * @param {Readonly<Record<string, string | undefined>>} options.env
 * @param {string} options.home
 * @param {(file: string) => boolean} options.exists
 * @param {(dir: string) => string[]} options.list
 * @returns {string[]}
 */
export function browserPrograms({ env, home, exists, list }) {
  /** @type {string[]} */
  const found = [];
  const named = env.HYPERFRAMES_CACHE_DIR;
  const bases = new Set([
    win.join(
      named ? win.resolve(named) : win.join(home, ".cache", "hyperframes"),
      "chrome",
      "chrome-headless-shell",
    ),
    win.join(home, ".cache", "hyperframes", "chrome", "chrome-headless-shell"),
    win.join(home, ".cache", "puppeteer", "chrome-headless-shell"),
  ]);
  for (const base of bases) {
    for (const version of list(base)) {
      for (const folder of ["chrome-headless-shell-win64", "chrome-headless-shell-win32"]) {
        const exe = win.join(base, version, folder, "chrome-headless-shell.exe");
        if (exists(exe)) found.push(exe);
      }
    }
  }
  const programs = env.ProgramW6432 ?? env.PROGRAMFILES ?? "C:\\Program Files";
  const programsX86 = env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
  const chrome = ["Google", "Chrome", "Application", "chrome.exe"];
  for (const base of [programs, programsX86, env.LOCALAPPDATA]) {
    if (!base) continue;
    const exe = win.join(base, ...chrome);
    if (exists(exe)) found.push(exe);
  }
  return found;
}

/**
 * The data of the value in the output of `reg query <key> /v <name>`, or `null`.
 * @param {string} stdout
 * @returns {string | null}
 */
export function parseRegValue(stdout) {
  const m = /\bREG_SZ\s+(.*?)\s*$/mu.exec(stdout);
  return m ? (m[1] ?? "") : null;
}

/** @param {string} dir @returns {string[]} */
function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {Promise<RegResult>}
 */
async function runReg(command, args) {
  const r = await runHelper({ command, args, timeoutMs: REG_TIMEOUT_MS });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
}

/**
 * @param {GpuPreferenceDeps} [deps]
 */
export function createGpuPreference(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const run = deps.run ?? runReg;
  const exists = deps.exists ?? ((/** @type {string} */ file) => fs.existsSync(file));
  const list = deps.list ?? listDir;
  const askNvidia = deps.nvidia ?? (() => detectNvidia({ platform, env }));
  const log = deps.log;
  /** @type {Promise<{ present: boolean, name: string | null }> | null} */
  let nvidia = null;

  /** @param {string} program @returns {Promise<"applied" | "already" | "failed">} */
  async function setOne(program) {
    const reg = regCommand(env);
    try {
      const asked = await run(reg, ["query", PREFERENCE_KEY, "/v", program]);
      if (asked.code === 0 && /GpuPreference=2;/u.test(parseRegValue(asked.stdout) ?? "")) {
        return "already";
      }
      const set = await run(reg, [
        "add",
        PREFERENCE_KEY,
        "/v",
        program,
        "/t",
        "REG_SZ",
        "/d",
        PREFERENCE_DATA,
        "/f",
      ]);
      if (set.code === 0) return "applied";
      log?.warn(
        `Could not set the graphics preference of ${program}: ${(set.stderr || set.stdout).trim().slice(0, 200)}`,
      );
    } catch (error) {
      log?.warn(`Could not set the graphics preference of ${program}`, error);
    }
    return "failed";
  }

  return {
    /**
     * Sets "High performance" for the renderer's browser programs (those that exist and the extra
     * ones named), on Windows with an NVIDIA GPU. Safe to call at any time, as often as wanted:
     * a program that has the preference is not written again. Never throws.
     * @param {readonly string[]} [extra] More programs, for example the browser Prepare found.
     * @returns {Promise<GpuPreferenceResult>}
     */
    async apply(extra = []) {
      /** @type {GpuPreferenceResult} */
      const result = { applied: [], already: [], failed: [], skipped: null };
      try {
        if (platform !== "win32") {
          result.skipped = "this is not Windows";
          return result;
        }
        nvidia ??= askNvidia().catch(() => ({ present: false, name: null }));
        const gpu = await nvidia;
        if (!gpu.present) {
          result.skipped = "this computer has no NVIDIA GPU";
          return result;
        }
        const home = deps.home ?? os.homedir();
        const programs = [
          ...new Set([
            ...extra.filter((p) => p !== "" && win.isAbsolute(p)),
            ...browserPrograms({ env, home, exists, list }),
          ]),
        ];
        for (const program of programs) result[await setOne(program)].push(program);
        if (programs.length > 0) {
          const name = gpu.name ?? "the NVIDIA GPU";
          log?.info(
            `Graphics preference "high performance" (${name}) for the renderer's browser: ${result.applied.length} set, ${result.already.length} already set, ${result.failed.length} failed.`,
          );
        }
      } catch (error) {
        log?.warn("Could not set the graphics preference of the renderer's browser", error);
      }
      return result;
    },
  };
}

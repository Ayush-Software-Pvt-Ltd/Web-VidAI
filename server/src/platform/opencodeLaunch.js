// The parts of starting an OpenCode 2 server that differ between macOS/Linux and Windows
// (docs/SPEC.md section 5, "Harness, program and model").
//
// How the program itself is launched (an `.exe`, an npm shim, a script with a `#!` line) and the
// absence of a console window are `process.js` and `launch.js`. What is left, and lives here:
//
// - Windows environment variable names have no letter case, so removing `OPENCODE_CONFIG` must
//   remove `opencode_config` too.
// - The user's home folder is `HOME` on a Mac and `USERPROFILE` on Windows.
// - The files named as instructions are written with the separators of the system.
// - The terminal named in the advice for a server that stays silent.
//
// Everything is a pure function of its arguments, so the Windows forms are unit tested on every
// system. `platform` is what `process.platform` says.

import path from "node:path";

/** @typedef {Readonly<Record<string, string | undefined>>} Env */

/**
 * The path functions of `platform`.
 * @param {NodeJS.Platform} platform
 * @returns {typeof path.posix}
 */
function pathsOf(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * The terminal that advice to run a command by hand names.
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function terminalName(platform = process.platform) {
  return platform === "win32" ? "PowerShell" : "Terminal";
}

/**
 * The value of an environment variable; on Windows the name is matched without letter case.
 * @param {Env} env
 * @param {string} name
 * @param {NodeJS.Platform} [platform]
 * @returns {string | undefined}
 */
export function envValue(env, name, platform = process.platform) {
  if (platform !== "win32") return env[name];
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted) return value;
  }
  return undefined;
}

/**
 * The user's home folder: `HOME`, on Windows `USERPROFILE` (then `HOMEDRIVE` and `HOMEPATH`, then
 * `HOME`). `null` when none is set.
 * @param {Env} env
 * @param {NodeJS.Platform} [platform]
 * @returns {string | null}
 */
export function userHome(env, platform = process.platform) {
  /** @param {string | undefined} value */
  const usable = (value) => (value !== undefined && value !== "" ? value : null);
  if (platform !== "win32") return usable(env["HOME"]);
  const profile = usable(envValue(env, "USERPROFILE", platform));
  if (profile !== null) return profile;
  const drive = envValue(env, "HOMEDRIVE", platform) ?? "";
  const rest = envValue(env, "HOMEPATH", platform) ?? "";
  if (drive !== "" && rest !== "") return `${drive}${rest}`;
  return usable(envValue(env, "HOME", platform));
}

/**
 * `env` as a new plain object without `names` (letter case ignored on Windows) and without
 * variables that have no value.
 * @param {Env} env
 * @param {readonly string[]} names
 * @param {NodeJS.Platform} [platform]
 * @returns {Record<string, string>}
 */
export function withoutVars(env, names, platform = process.platform) {
  const drop = new Set(platform === "win32" ? names.map((n) => n.toUpperCase()) : names);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (drop.has(platform === "win32" ? key.toUpperCase() : key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The `CLAUDE.md` files OpenCode 2 is told to read as instructions (it does not read them on its
 * own): the Editing Folder's, then the user's `.claude/CLAUDE.md` when the home folder is known.
 * @param {string} editingFolder
 * @param {string | null} home
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
export function instructionFiles(editingFolder, home, platform = process.platform) {
  const p = pathsOf(platform);
  const files = [p.join(editingFolder, "CLAUDE.md")];
  if (home !== null) files.push(p.join(home, ".claude", "CLAUDE.md"));
  return files;
}

/**
 * The private, empty folder that stands in for the user's own OpenCode configuration folder.
 * @param {string} jobDir The folder of this job's own files.
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function privateConfigDir(jobDir, platform = process.platform) {
  return pathsOf(platform).join(jobDir, "opencode2-config");
}

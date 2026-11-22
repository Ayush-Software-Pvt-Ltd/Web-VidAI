// Finding Claude Code (docs/SPEC.md section 5, "Finding and checking Claude Code").
//
// Where `claude` is looked for, in order:
//
// 1. `VIDAI_CLAUDE_BIN`. When it is set, it is the only candidate (the tests point it at a fake).
// 2. The folders of `PATH` (on Windows with the extensions of `PATHEXT`).
// 3. `~/.local/bin` (the native installer), `~/.claude/local` (the old self-installed copy),
//    on Windows `%APPDATA%\npm`, and on a Mac the Homebrew folders.
//
// A file for the other processor (a copied-over Intel binary on an Apple Silicon Mac without
// Rosetta 2, an arm64 binary on an Intel Mac) is skipped like a missing file. The first
// candidate that answers `--version` within 15 seconds is the one.
//
// Everything takes the environment and the machine as parameters, so it runs the same way in
// tests on any system.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runsHere } from "../../platform/macho.js";
import { findInDir, getVar, pathExtensions, isRegularFile } from "../../platform/launchLookup.js";
import { runHelper } from "../../platform/process.js";
import { expandHome, homebrewBins } from "./env.js";

/** The variable that names the `claude` program to use (tests, unusual installs). */
export const CLAUDE_BIN_VAR = "VIDAI_CLAUDE_BIN";

/** How long `claude --version` may take. */
export const VERSION_TIMEOUT_MS = 15_000;

/**
 * The computer and file system a lookup runs against. Every field is optional (default: this
 * computer).
 * @typedef {object} Machine
 * @property {NodeJS.Platform} [platform]
 * @property {string} [arch]
 * @property {string | null} [home]
 * @property {(file: string) => boolean} [isFile] Whether a file exists and can be started.
 * @property {(file: string) => boolean} [runsHere] Whether a file is for this processor.
 */

/**
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {Machine} machine
 */
function resolveMachine(env, machine) {
  const platform = machine.platform ?? process.platform;
  const home =
    machine.home !== undefined
      ? machine.home
      : (getVar(env, platform === "win32" ? "USERPROFILE" : "HOME") ?? os.homedir());
  return {
    platform,
    arch: machine.arch ?? process.arch,
    home,
    isFile: machine.isFile ?? ((/** @type {string} */ file) => isExecutable(file, platform)),
    runsHere: machine.runsHere ?? ((/** @type {string} */ file) => runsHere(file, { platform })),
  };
}

/**
 * Whether `file` is a regular file that can be started: on Windows any file (the extension
 * decides), elsewhere one with an execute permission for this user.
 * @param {string} file
 * @param {NodeJS.Platform} [platform]
 * @returns {boolean}
 */
export function isExecutable(file, platform = process.platform) {
  if (!isRegularFile(file)) return false;
  if (platform === "win32") return true;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every existing program called one of `names` in `dirs`, in order. On Windows a name without
 * an extension also matches with each extension of `pathext`.
 * @param {readonly string[]} dirs
 * @param {readonly string[]} names
 * @param {{ platform?: NodeJS.Platform, isFile?: (file: string) => boolean, pathext?: string | null }} [options]
 * @returns {string[]}
 */
export function inDirs(dirs, names, options = {}) {
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? ((/** @type {string} */ f) => isExecutable(f, platform));
  const extensions = pathExtensions(options.pathext);
  /** @type {string[]} */
  const found = [];
  for (const dir of dirs) {
    for (const name of names) {
      if (platform === "win32") {
        const hit = findInDir(dir, name, extensions, isFile);
        if (hit !== null) found.push(hit);
      } else {
        const candidate = path.posix.join(dir, name);
        if (isFile(candidate)) found.push(candidate);
      }
    }
  }
  return found;
}

/**
 * The folders of a search path (`:` or `;` separated); empty and relative entries are dropped.
 * @param {string | null | undefined} searchPath
 * @param {NodeJS.Platform} platform
 * @returns {string[]}
 */
function splitPath(searchPath, platform) {
  if (!searchPath) return [];
  const win = platform === "win32";
  return searchPath
    .split(win ? ";" : ":")
    .map((p) => (win ? p.trim().replace(/^"+|"+$/g, "") : p))
    .filter((p) => p !== "" && (win ? path.win32.isAbsolute(p) : path.posix.isAbsolute(p)));
}

/**
 * Every program called `name` on the search path `searchPath`, in order.
 * @param {string} name
 * @param {string | null | undefined} searchPath
 * @param {{ platform?: NodeJS.Platform, isFile?: (file: string) => boolean, pathext?: string | null }} [options]
 * @returns {string[]}
 */
export function whichAllIn(name, searchPath, options = {}) {
  const platform = options.platform ?? process.platform;
  return inDirs(splitPath(searchPath, platform), [name], options);
}

/**
 * The first program called `name` on the search path `searchPath`, or `null`.
 * @param {string} name
 * @param {string | null | undefined} searchPath
 * @param {{ platform?: NodeJS.Platform, isFile?: (file: string) => boolean, pathext?: string | null }} [options]
 * @returns {string | null}
 */
export function whichIn(name, searchPath, options = {}) {
  return whichAllIn(name, searchPath, options)[0] ?? null;
}

/**
 * The first program called `name` on the `PATH` of `env`, or `null`.
 * @param {string} name
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {Machine} [machine]
 * @returns {string | null}
 */
export function which(name, env, machine = {}) {
  const m = resolveMachine(env, machine);
  return whichIn(name, getVar(env, "PATH"), {
    platform: m.platform,
    isFile: m.isFile,
    pathext: getVar(env, "PATHEXT"),
  });
}

/**
 * The folders beyond `PATH` where Claude Code is usually installed.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {Machine} [machine]
 * @returns {string[]}
 */
export function wellKnown(env, machine = {}) {
  const m = resolveMachine(env, machine);
  /** @type {string[]} */
  const dirs = [];
  const join = m.platform === "win32" ? path.win32.join : path.posix.join;
  if (m.home) {
    dirs.push(join(m.home, ".local", "bin"));
    dirs.push(join(m.home, ".claude", "local"));
    dirs.push(join(m.home, ".claude", "local", "node_modules", ".bin"));
  }
  if (m.platform === "win32") {
    const appData = getVar(env, "APPDATA");
    if (appData !== null) dirs.push(path.win32.join(appData, "npm"));
  } else if (m.platform === "darwin") {
    dirs.push(...homebrewBins(m.arch).filter((d) => d.endsWith("/bin")));
  } else {
    dirs.push("/usr/local/bin", "/usr/bin");
  }
  return dirs;
}

/**
 * The `claude` that `VIDAI_CLAUDE_BIN` names, or `null` when it is not set. A leading `~` is the
 * home folder.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {Machine} [machine]
 * @returns {string | null}
 */
export function overrideOf(env, machine = {}) {
  const value = getVar(env, CLAUDE_BIN_VAR);
  if (value === null) return null;
  return expandHome(value.trim(), resolveMachine(env, machine).home);
}

/**
 * Every `claude` that can be started here, in the order they are tried. With `VIDAI_CLAUDE_BIN`
 * set that is the file it names (or nothing when the file is missing or unusable).
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {Machine} [machine]
 * @returns {string[]}
 */
export function candidates(env, machine = {}) {
  const m = resolveMachine(env, machine);
  const override = overrideOf(env, machine);
  /** @type {string[]} */
  const all =
    override !== null
      ? m.isFile(override)
        ? [override]
        : []
      : [
          ...whichAllIn("claude", getVar(env, "PATH"), {
            platform: m.platform,
            isFile: m.isFile,
            pathext: getVar(env, "PATHEXT"),
          }),
          ...inDirs(wellKnown(env, machine), ["claude"], {
            platform: m.platform,
            isFile: m.isFile,
            pathext: getVar(env, "PATHEXT"),
          }),
        ];
  /** @type {string[]} */
  const unique = [];
  for (const file of all) {
    if (unique.includes(file)) continue;
    if (!m.runsHere(file)) continue;
    unique.push(file);
  }
  return unique;
}

/**
 * The first `claude` that can be started here (not yet asked for its version), or `null`.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {Machine} [machine]
 * @returns {string | null}
 */
export function findClaude(env, machine = {}) {
  return candidates(env, machine)[0] ?? null;
}

/**
 * The version number out of `claude --version` output (`2.1.319 (Claude Code)` is `2.1.319`;
 * a leading `v`, as in `opencode v2.2.6`, is not part of it), or `null` when there is none.
 * @param {string} text
 * @returns {string | null}
 */
export function parseVersion(text) {
  const m = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(text);
  return m === null ? null : /** @type {string} */ (m[1]);
}

/**
 * Asks a program for its version. `null` when it does not start, does not succeed or does not
 * answer within `timeoutMs`.
 * @param {string} program
 * @param {Readonly<Record<string, string | undefined>>} env The environment to run it in.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string | null>}
 */
export async function version(program, env, options = {}) {
  try {
    const result = await runHelper({
      command: program,
      args: ["--version"],
      env,
      timeoutMs: options.timeoutMs ?? VERSION_TIMEOUT_MS,
    });
    if (result.timedOut || result.code !== 0) return null;
    const text = result.stdout.trim() === "" ? result.stderr : result.stdout;
    return parseVersion(text) ?? (text.trim().split(/\r?\n/, 1)[0] || null);
  } catch {
    return null;
  }
}

/**
 * Finds `claude` and checks it: the first candidate that answers `--version` is returned with
 * its version. When candidates exist but none answers, the first is returned with
 * `version: null` (so the caller can say which file is broken); `null` when there is none.
 * @param {Readonly<Record<string, string | undefined>>} env The environment `claude` will run in.
 * @param {Machine & { timeoutMs?: number }} [machine]
 * @returns {Promise<{ path: string, version: string | null } | null>}
 */
export async function locateClaude(env, machine = {}) {
  const list = candidates(env, machine);
  for (const file of list) {
    const found = await version(file, env, { timeoutMs: machine.timeoutMs });
    if (found !== null) return { path: file, version: found };
  }
  const first = list[0];
  return first === undefined ? null : { path: first, version: null };
}

/**
 * A helper program (`ffmpeg`, `python3`) on the `PATH` of `env` or, failing that, in the
 * folders of `wellKnownDirs`-style places; `null` when it is nowhere.
 * @param {string} name
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {Machine} [machine]
 * @returns {string | null}
 */
export function whichTool(name, env, machine = {}) {
  const m = resolveMachine(env, machine);
  const onPath = which(name, env, machine);
  if (onPath !== null) return onPath;
  return (
    inDirs(wellKnown(env, machine), [name], {
      platform: m.platform,
      isFile: m.isFile,
      pathext: getVar(env, "PATHEXT"),
    })[0] ?? null
  );
}

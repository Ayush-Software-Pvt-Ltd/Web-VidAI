// Finding programs the way Windows does (docs/SPEC.md section 5, "Harness, program and
// model"): `PATHEXT`, case-insensitive variable names, and Git Bash. Used by `launch.js` (to
// start shims and scripts) and `agents/claude/locate.js` (to find `claude`).
//
// Everything here is written with `path.win32` and takes the file system as a parameter
// (`isFile`), so it is unit tested on every platform.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const win = path.win32;

/** The executable extensions used when `PATHEXT` is not set. */
export const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** Claude Code's own setting for where Git Bash is (see the Claude Code setup documentation). */
export const GIT_BASH_VAR = "CLAUDE_CODE_GIT_BASH_PATH";

/**
 * Whether `file` is a regular file (after following links).
 * @param {string} file
 * @returns {boolean}
 */
export function isRegularFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Looks up a variable the way Windows does: ignoring letter case. Empty values count as unset.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {string} name
 * @returns {string | null}
 */
export function getVar(env, name) {
  const exact = env[name];
  if (exact !== undefined && exact !== "") return exact;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lower && value !== undefined && value !== "") return value;
  }
  return null;
}

/**
 * The extensions of `PATHEXT` (lowercase, with the dot), or the Windows default.
 * @param {string | null | undefined} pathext
 * @returns {string[]}
 */
export function pathExtensions(pathext) {
  const text = pathext !== null && pathext !== undefined && pathext.trim() !== "";
  return (text ? /** @type {string} */ (pathext) : DEFAULT_PATHEXT)
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith(".") && e.length > 1);
}

/**
 * The program `name` in `dir` as Windows would start it from a terminal: `name` itself when it
 * already has one of the `extensions`, else `name` plus the first extension that exists.
 * @param {string} dir
 * @param {string} name
 * @param {string[]} extensions
 * @param {(file: string) => boolean} [isFile]
 * @returns {string | null}
 */
export function findInDir(dir, name, extensions, isFile = isRegularFile) {
  const lower = name.toLowerCase();
  if (extensions.some((e) => lower.endsWith(e))) {
    const candidate = win.join(dir, name);
    return isFile(candidate) ? candidate : null;
  }
  for (const ext of extensions) {
    const candidate = win.join(dir, `${name}${ext}`);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The first program called `name` on the `;`-separated folder list `searchPath`. Relative
 * entries are ignored.
 * @param {string} name
 * @param {string | null | undefined} searchPath
 * @param {string | null | undefined} pathext
 * @param {(file: string) => boolean} [isFile]
 * @returns {string | null}
 */
export function whichInWindows(name, searchPath, pathext, isFile = isRegularFile) {
  if (!searchPath) return null;
  const extensions = pathExtensions(pathext);
  for (const raw of searchPath.split(";")) {
    const dir = raw.trim().replace(/^"+|"+$/g, "");
    if (dir === "" || !win.isAbsolute(dir)) continue;
    const found = findInDir(dir, name, extensions, isFile);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The WSL launcher (`C:\Windows\System32\bash.exe`), which is not Git Bash.
 * @param {string} file
 * @returns {boolean}
 */
function isSystemBash(file) {
  return file.toLowerCase().replaceAll("/", "\\").endsWith("\\system32\\bash.exe");
}

/**
 * Where Git Bash may be, in the order Claude Code looks: its own setting, next to the `git` on
 * `PATH`, then the usual install folders. Never the `bash.exe` of WSL.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {(file: string) => boolean} [isFile]
 * @returns {string[]}
 */
export function gitBashCandidates(env, isFile = isRegularFile) {
  /** @type {string[]} */
  const out = [];
  const configured = getVar(env, GIT_BASH_VAR);
  if (configured !== null) out.push(configured);
  const git = whichInWindows("git", getVar(env, "PATH"), getVar(env, "PATHEXT"), isFile);
  if (git !== null) {
    // <root>\cmd\git.exe, <root>\bin\git.exe or <root>\mingw64\bin\git.exe: the root is two or
    // three levels up.
    let root = win.dirname(win.dirname(git));
    for (let i = 0; i < 2; i += 1) {
      out.push(win.join(root, "bin", "bash.exe"));
      const parent = win.dirname(root);
      if (parent === root) break;
      root = parent;
    }
  }
  /** @type {[string, string][]} */
  const known = [
    ["ProgramFiles", "Git\\bin\\bash.exe"],
    ["ProgramW6432", "Git\\bin\\bash.exe"],
    ["ProgramFiles(x86)", "Git\\bin\\bash.exe"],
    ["LOCALAPPDATA", "Programs\\Git\\bin\\bash.exe"],
    ["USERPROFILE", "scoop\\apps\\git\\current\\bin\\bash.exe"],
  ];
  for (const [variable, sub] of known) {
    const base = getVar(env, variable);
    if (base !== null) out.push(win.join(base, sub));
  }
  /** @type {string[]} */
  const unique = [];
  for (const candidate of out) {
    if (isSystemBash(candidate)) continue;
    if (!unique.some((u) => u.toLowerCase() === candidate.toLowerCase())) unique.push(candidate);
  }
  return unique;
}

/**
 * Git Bash (`bash.exe` of Git for Windows), which Claude Code uses for its Bash tool on Windows
 * and VidAI uses to run `#!` scripts.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {(file: string) => boolean} [isFile]
 * @returns {string | null}
 */
export function gitBash(env, isFile = isRegularFile) {
  return gitBashCandidates(env, isFile).find((candidate) => isFile(candidate)) ?? null;
}

/**
 * An App Execution Alias in `...\Microsoft\WindowsApps`: a placeholder that only opens the
 * Microsoft Store unless the program is really installed.
 * @param {string} file
 * @returns {boolean}
 */
export function isStoreAlias(file) {
  return win.dirname(file).toLowerCase().endsWith("\\microsoft\\windowsapps");
}

/**
 * Whether `program --version` succeeds within a few seconds.
 * @param {string} program
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {boolean}
 */
function runs(program, env) {
  const result = spawnSync(program, ["--version"], {
    env: /** @type {NodeJS.ProcessEnv} */ (env),
    timeout: 5000,
    windowsHide: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

/**
 * A helper tool (`ffmpeg`, `python3`, `node`) on the `PATH` of `env`, on Windows.
 *
 * Python is usually `python.exe` (or the `py` launcher) rather than `python3.exe`, and
 * `%LOCALAPPDATA%\Microsoft\WindowsApps` holds placeholders that only open the Microsoft Store:
 * those count only when they really run.
 * @param {string} name
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {{ isFile?: (file: string) => boolean, runs?: (program: string) => boolean }} [deps]
 * @returns {string | null}
 */
export function whichToolWindows(name, env, deps = {}) {
  const isFile = deps.isFile ?? isRegularFile;
  const canRun = deps.runs ?? ((program) => runs(program, env));
  const names = name === "python3" ? ["python3", "python", "py"] : [name];
  for (const candidate of names) {
    const found = whichInWindows(candidate, getVar(env, "PATH"), getVar(env, "PATHEXT"), isFile);
    if (found !== null && (!isStoreAlias(found) || canRun(found))) return found;
  }
  return null;
}

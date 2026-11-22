// Finding helper programs the server needs (docs/SPEC.md section 6: Long or Short comes from
// the A-roll's metadata, through `ffprobe` for containers the server cannot read itself; section
// 12: the render runner checks and levels the finished file with `ffprobe` and `ffmpeg`).
//
// Where `ffprobe` (and `ffmpeg`, the same way) is looked for, in order:
//
// 1. `VIDAI_FFPROBE_BIN` (`VIDAI_FFMPEG_BIN`). When it is set, it is the only candidate (the tests
//    point it at a fake).
// 2. The folders of `PATH` (on Windows with the extensions of `PATHEXT`).
// 3. The usual install folders: Homebrew and MacPorts on a Mac, `/usr/local/bin` and `/usr/bin`
//    on Linux, Chocolatey, WinGet, Scoop and a few `ffmpeg` folders on Windows.
//
// Everything takes the environment and the machine as parameters so the Windows half runs in
// tests on any system.

import fs from "node:fs";
import path from "node:path";
import { findInDir, getVar, isRegularFile, pathExtensions } from "./launchLookup.js";

/** The variable that names the `ffprobe` program to use (tests, unusual installs). */
export const FFPROBE_BIN_VAR = "VIDAI_FFPROBE_BIN";
/** The variable that names the `ffmpeg` program to use (tests, unusual installs). */
export const FFMPEG_BIN_VAR = "VIDAI_FFMPEG_BIN";

/**
 * @typedef {object} Machine
 * @property {NodeJS.Platform} [platform]
 * @property {(file: string) => boolean} [isFile] Whether a file can be started (tests).
 */

/**
 * Whether `file` is a regular file that can be started: on Windows any file (the extension
 * decides), elsewhere one with an execute permission for this user.
 * @param {string} file
 * @param {NodeJS.Platform} platform
 * @returns {boolean}
 */
function canStart(file, platform) {
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
 * The folders of a search path; empty and relative entries are dropped.
 * @param {string | null} searchPath
 * @param {NodeJS.Platform} platform
 * @returns {string[]}
 */
function splitPath(searchPath, platform) {
  if (searchPath === null) return [];
  const win = platform === "win32";
  return searchPath
    .split(win ? ";" : ":")
    .map((entry) => (win ? entry.trim().replace(/^"+|"+$/g, "") : entry))
    .filter(
      (entry) =>
        entry !== "" && (win ? path.win32.isAbsolute(entry) : path.posix.isAbsolute(entry)),
    );
}

/**
 * The folders beyond `PATH` where `ffprobe` is usually installed.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {NodeJS.Platform} platform
 * @returns {string[]}
 */
export function ffprobeFolders(env, platform) {
  if (platform === "win32") {
    /** @type {string[]} */
    const folders = [];
    const local = getVar(env, "LOCALAPPDATA");
    const profile = getVar(env, "USERPROFILE");
    const data = getVar(env, "ProgramData");
    const programs = getVar(env, "ProgramFiles");
    if (data !== null) folders.push(path.win32.join(data, "chocolatey", "bin"));
    if (local !== null) folders.push(path.win32.join(local, "Microsoft", "WinGet", "Links"));
    if (profile !== null) folders.push(path.win32.join(profile, "scoop", "shims"));
    if (programs !== null) folders.push(path.win32.join(programs, "ffmpeg", "bin"));
    folders.push("C:\\ffmpeg\\bin");
    return folders;
  }
  if (platform === "darwin") {
    return ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
  }
  return ["/usr/local/bin", "/usr/bin"];
}

/**
 * The first program called `name` in the given folders.
 * @param {string} name
 * @param {readonly string[]} folders
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {NodeJS.Platform} platform
 * @param {(file: string) => boolean} isFile
 * @returns {string | null}
 */
function inFolders(name, folders, env, platform, isFile) {
  const extensions = pathExtensions(getVar(env, "PATHEXT"));
  for (const folder of folders) {
    if (platform === "win32") {
      const found = findInDir(folder, name, extensions, isFile);
      if (found !== null) return found;
    } else {
      const candidate = path.posix.join(folder, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * @param {string} name `ffprobe` or `ffmpeg`.
 * @param {string} variable The variable that overrides the search.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {Machine} machine
 * @returns {string | null}
 */
function findTool(name, variable, env, machine) {
  const platform = machine.platform ?? process.platform;
  const isFile = machine.isFile ?? ((/** @type {string} */ file) => canStart(file, platform));
  const override = getVar(env, variable);
  if (override !== null) {
    const file = override.trim();
    return isFile(file) ? file : null;
  }
  return (
    inFolders(name, splitPath(getVar(env, "PATH"), platform), env, platform, isFile) ??
    inFolders(name, ffprobeFolders(env, platform), env, platform, isFile)
  );
}

/**
 * The `ffprobe` to run, or `null` when there is none. Not cached: installing ffprobe later must
 * take effect without a restart.
 * @param {Readonly<Record<string, string | undefined>>} [env]
 * @param {Machine} [machine]
 * @returns {string | null}
 */
export function findFfprobe(env = process.env, machine = {}) {
  return findTool("ffprobe", FFPROBE_BIN_VAR, env, machine);
}

/**
 * The `ffmpeg` to run, or `null` when there is none (same search as `findFfprobe`; the two come
 * in one package).
 * @param {Readonly<Record<string, string | undefined>>} [env]
 * @param {Machine} [machine]
 * @returns {string | null}
 */
export function findFfmpeg(env = process.env, machine = {}) {
  return findTool("ffmpeg", FFMPEG_BIN_VAR, env, machine);
}

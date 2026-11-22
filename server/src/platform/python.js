// Where Python is, and where the toolkit's Python environment keeps its programs, on macOS and
// Windows (docs/SPEC.md section 7). Everything is a pure function of the environment and the
// machine (passed as parameters), so the Windows half is tested on any system.
//
// Which Python the toolkit may use: 3.10 to 3.13. Older ones lack what the packages need; newer
// ones often have no wheels yet for the speech and numeric packages.
//
// Where a Python is looked for, in order:
//
// 1. `VIDAI_PYTHON_BIN`. When it is set, it is the only candidate (tests, unusual installs).
// 2. Versioned names first (`python3.13` down to `python3.10`), because a bare `python3` is often
//    Apple's 3.9 or the newest 3.x that has no wheels; then `python3` and `python`.
// 3. On a Mac: the folders of `PATH`, Homebrew, MacPorts and the python.org framework folders.
//    On Windows: the `py` launcher (`py -3.13`, ... `py -3`), `python` on `PATH` (never the Store
//    placeholder), then the python.org install folders.

import path from "node:path";
import { findInDir, getVar, isRegularFile, isStoreAlias, pathExtensions } from "./launchLookup.js";

/** The variable that names the Python to use (tests, unusual installs). */
export const PYTHON_BIN_VAR = "VIDAI_PYTHON_BIN";

/** The Python versions the toolkit supports, `[major, minor]` of the oldest and the newest. */
export const PYTHON_RANGE = { min: [3, 10], max: [3, 13] };

/** The minor versions tried, newest first. */
const MINORS = [13, 12, 11, 10];

/**
 * A Python program and the arguments that go before the caller's own (`py -3.13`).
 * @typedef {object} PythonCandidate
 * @property {string} command Path of the program (or `py`'s path).
 * @property {string[]} args
 * @property {string} label For logs: "/opt/homebrew/bin/python3.13", "py -3.13".
 */

/**
 * @typedef {object} PythonVersion
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 */

/** What the lookups need of the machine (tests pass fakes). */
/**
 * @typedef {object} PythonMachine
 * @property {NodeJS.Platform} [platform]
 * @property {(file: string) => boolean} [isFile] Whether a file exists and can be started.
 */

/** The arguments that make any Python print its version as `3.12.4`. */
export const VERSION_ARGS = ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"];

/**
 * @param {string} text What `VERSION_ARGS` printed (or `Python 3.12.4`).
 * @returns {PythonVersion | null}
 */
export function parsePythonVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text) ?? /(\d+)\.(\d+)/.exec(text);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
  };
}

/**
 * Whether the toolkit supports this Python version.
 * @param {PythonVersion} version
 * @returns {boolean}
 */
export function isSupportedPython(version) {
  const [minMajor, minMinor] = PYTHON_RANGE.min;
  const [maxMajor, maxMinor] = PYTHON_RANGE.max;
  const n = version.major * 1000 + version.minor;
  return (
    n >= /** @type {number} */ (minMajor) * 1000 + /** @type {number} */ (minMinor) &&
    n <= /** @type {number} */ (maxMajor) * 1000 + /** @type {number} */ (maxMinor)
  );
}

/** @param {PythonVersion} version */
export function formatPythonVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * The Python of the environment at `venvDir`.
 * @param {string} venvDir
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function venvPython(venvDir, platform = process.platform) {
  return platform === "win32"
    ? path.win32.join(venvDir, "Scripts", "python.exe")
    : path.posix.join(venvDir, "bin", "python");
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
 * Apple's own `/usr/bin/python3` (3.9 or older, never supported; starting it without the command
 * line tools opens an install dialog).
 * @param {string} file
 * @param {NodeJS.Platform} platform
 * @returns {boolean}
 */
function isApplePython(file, platform) {
  return platform === "darwin" && file === "/usr/bin/python3";
}

/**
 * The candidates on a Mac or another Unix, in the order they are tried.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {NodeJS.Platform} platform
 * @param {(file: string) => boolean} isFile
 * @returns {PythonCandidate[]}
 */
function posixCandidates(env, platform, isFile) {
  const fixed =
    platform === "darwin"
      ? ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"]
      : ["/usr/local/bin", "/usr/bin"];
  const folders = [...splitPath(getVar(env, "PATH"), platform), ...fixed];
  /** @type {string[]} */
  const files = [];
  const add = (/** @type {string} */ file) => {
    if (!files.includes(file) && !isApplePython(file, platform) && isFile(file)) files.push(file);
  };
  for (const minor of MINORS) {
    for (const folder of folders) add(path.posix.join(folder, `python3.${minor}`));
    if (platform === "darwin") {
      // python.org's installer: the framework folder and MacPorts' versioned folder.
      add(`/Library/Frameworks/Python.framework/Versions/3.${minor}/bin/python3`);
      add(`/opt/local/Library/Frameworks/Python.framework/Versions/3.${minor}/bin/python3`);
    }
  }
  for (const name of ["python3", "python"]) {
    for (const folder of folders) add(path.posix.join(folder, name));
  }
  return files.map((file) => ({ command: file, args: [], label: file }));
}

/**
 * The candidates on Windows, in the order they are tried.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {(file: string) => boolean} isFile
 * @returns {PythonCandidate[]}
 */
function windowsCandidates(env, isFile) {
  const win = path.win32;
  const extensions = pathExtensions(getVar(env, "PATHEXT"));
  const folders = splitPath(getVar(env, "PATH"), "win32");
  /** @type {PythonCandidate[]} */
  const out = [];
  const seen = new Set();
  /** @param {PythonCandidate} candidate */
  const add = (candidate) => {
    if (seen.has(candidate.label.toLowerCase())) return;
    seen.add(candidate.label.toLowerCase());
    out.push(candidate);
  };

  // The `py` launcher knows every installed version; ask it for each supported one.
  /** @type {string | null} */
  let py = null;
  const windir = getVar(env, "SystemRoot") ?? getVar(env, "windir");
  for (const folder of [...folders, ...(windir === null ? [] : [windir])]) {
    py = findInDir(folder, "py", extensions, isFile);
    if (py !== null) break;
  }
  if (py !== null) {
    for (const minor of MINORS) {
      add({ command: py, args: [`-3.${minor}`], label: `py -3.${minor}` });
    }
    add({ command: py, args: ["-3"], label: "py -3" });
  }

  // `python` on PATH (the Store placeholder only opens the Microsoft Store: skipped).
  for (const name of ["python", "python3"]) {
    for (const folder of folders) {
      const found = findInDir(folder, name, extensions, isFile);
      if (found !== null && !isStoreAlias(found)) add({ command: found, args: [], label: found });
    }
  }

  // The installers' own folders: python.org's "Python313" for 3.13, per user, per machine, or
  // at the root of C:.
  const local = getVar(env, "LOCALAPPDATA");
  const programs = getVar(env, "ProgramFiles");
  const roots = [local === null ? null : win.join(local, "Programs", "Python"), programs, "C:\\"];
  for (const minor of MINORS) {
    for (const root of roots) {
      if (root === null) continue;
      const file = win.join(root, `Python3${minor}`, "python.exe");
      if (isFile(file)) add({ command: file, args: [], label: file });
    }
  }
  return out;
}

/**
 * The Pythons to try, in order, each a program plus leading arguments. Only files that exist are
 * listed; the caller still runs each one to read its version.
 * @param {Readonly<Record<string, string | undefined>>} [env]
 * @param {PythonMachine} [machine]
 * @returns {PythonCandidate[]}
 */
export function pythonCandidates(env = process.env, machine = {}) {
  const platform = machine.platform ?? process.platform;
  const isFile = machine.isFile ?? isRegularFile;
  const override = getVar(env, PYTHON_BIN_VAR);
  if (override !== null) {
    const file = override.trim();
    return isFile(file) ? [{ command: file, args: [], label: file }] : [];
  }
  return platform === "win32"
    ? windowsCandidates(env, isFile)
    : posixCandidates(env, platform, isFile);
}

/**
 * The sentence that says what to install when no usable Python was found.
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function pythonInstallHint(platform = process.platform) {
  const [minMajor, minMinor] = PYTHON_RANGE.min;
  const [maxMajor, maxMinor] = PYTHON_RANGE.max;
  const range = `${minMajor}.${minMinor} to ${maxMajor}.${maxMinor}`;
  if (platform === "win32") {
    return `No Python ${range} was found on this computer. Install Python 3.12 from python.org (tick "Add python.exe to PATH") or run "winget install Python.Python.3.12", then press Prepare again.`;
  }
  if (platform === "darwin") {
    return `No Python ${range} was found on this computer. Install Python 3.12 with "brew install python@3.12" or from python.org, then press Prepare again.`;
  }
  return `No Python ${range} was found on this computer. Install Python 3.12 with your package manager, then press Prepare again.`;
}

/**
 * The sentence that says what to install when ffmpeg or ffprobe is missing.
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function ffmpegInstallHint(platform = process.platform) {
  if (platform === "win32") {
    return 'Install ffmpeg (for example with "winget install Gyan.FFmpeg"), make sure ffmpeg.exe and ffprobe.exe are on the PATH, then press Prepare again.';
  }
  if (platform === "darwin") {
    return 'Install ffmpeg with "brew install ffmpeg", then press Prepare again.';
  }
  return "Install ffmpeg with your package manager, then press Prepare again.";
}

/**
 * The arguments that create the environment (`python -m venv <dir>`); `clear` empties an
 * environment that is broken.
 * @param {string} venvDir
 * @param {{ clear?: boolean }} [options]
 * @returns {string[]}
 */
export function venvArgs(venvDir, { clear = false } = {}) {
  return ["-m", "venv", ...(clear ? ["--clear"] : []), venvDir];
}

/** The arguments that make pip print its version. */
export const PIP_VERSION_ARGS = ["-m", "pip", "--version"];

/** The arguments that upgrade pip itself. */
export const PIP_UPGRADE_ARGS = [
  "-m",
  "pip",
  "install",
  "--upgrade",
  "--no-input",
  "--disable-pip-version-check",
  "pip",
];

/**
 * The arguments that install the toolkit's packages.
 * @param {string} requirementsFile
 * @returns {string[]}
 */
export function pipInstallArgs(requirementsFile) {
  return [
    "-m",
    "pip",
    "install",
    "--no-input",
    "--disable-pip-version-check",
    "-r",
    requirementsFile,
  ];
}

/**
 * The environment of a Python or pip child: never asks a question, prints UTF-8, and does not
 * inherit a `PYTHONHOME` or `PYTHONPATH` that would break the new environment.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {Readonly<Record<string, string>>} [extra]
 * @returns {Record<string, string | undefined>}
 */
export function pythonEnv(env, extra = {}) {
  /** @type {Record<string, string | undefined>} */
  const out = { ...env };
  delete out.PYTHONHOME;
  delete out.PYTHONPATH;
  delete out.VIRTUAL_ENV;
  return {
    ...out,
    PIP_NO_INPUT: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_PROGRESS_BAR: "off",
    PYTHONUNBUFFERED: "1",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    ...extra,
  };
}

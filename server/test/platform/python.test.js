import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PIP_UPGRADE_ARGS,
  formatPythonVersion,
  ffmpegInstallHint,
  isSupportedPython,
  parsePythonVersion,
  pipInstallArgs,
  pythonCandidates,
  pythonEnv,
  pythonInstallHint,
  venvArgs,
  venvPython,
} from "../../src/platform/python.js";

/** @param {string[]} existing @returns {(file: string) => boolean} */
const filesOf = (existing) => (file) => existing.includes(file);

test("versions are parsed from what Python prints and checked against 3.10 to 3.13", () => {
  assert.deepEqual(parsePythonVersion("3.12.4\n"), { major: 3, minor: 12, patch: 4 });
  assert.deepEqual(parsePythonVersion("Python 3.10.0"), { major: 3, minor: 10, patch: 0 });
  assert.equal(parsePythonVersion("no version"), null);
  /** @param {string} text */
  const supported = (text) => isSupportedPython(/** @type {any} */ (parsePythonVersion(text)));
  assert.equal(supported("3.9.6"), false);
  assert.equal(supported("3.10.0"), true);
  assert.equal(supported("3.13.9"), true);
  assert.equal(supported("3.14.0"), false);
  assert.equal(supported("3.15.2"), false);
  assert.equal(supported("2.7.18"), false);
  assert.equal(formatPythonVersion({ major: 3, minor: 11, patch: 2 }), "3.11.2");
});

test("the environment's Python is where each system keeps it", () => {
  assert.equal(venvPython("/data/toolkit/venv", "darwin"), "/data/toolkit/venv/bin/python");
  assert.equal(
    venvPython("C:\\Data\\toolkit\\venv", "win32"),
    "C:\\Data\\toolkit\\venv\\Scripts\\python.exe",
  );
});

test("on a Mac versioned names come first, and Apple's own python3 is never tried", () => {
  const files = [
    "/usr/bin/python3",
    "/opt/homebrew/bin/python3",
    "/opt/homebrew/bin/python3.12",
    "/opt/homebrew/bin/python3.14",
    "/usr/local/bin/python3.13",
    "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3",
  ];
  const found = pythonCandidates(
    { PATH: "/usr/bin:/opt/homebrew/bin" },
    { platform: "darwin", isFile: filesOf(files) },
  );
  assert.deepEqual(
    found.map((c) => c.command),
    [
      "/usr/local/bin/python3.13",
      "/opt/homebrew/bin/python3.12",
      "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3",
      "/opt/homebrew/bin/python3",
    ],
  );
  assert.ok(found.every((c) => c.args.length === 0));
});

test("VIDAI_PYTHON_BIN is the only candidate when set", () => {
  assert.deepEqual(
    pythonCandidates(
      { VIDAI_PYTHON_BIN: "/x/python", PATH: "/opt/homebrew/bin" },
      { platform: "darwin", isFile: filesOf(["/x/python", "/opt/homebrew/bin/python3.12"]) },
    ),
    [{ command: "/x/python", args: [], label: "/x/python" }],
  );
  assert.deepEqual(
    pythonCandidates({ VIDAI_PYTHON_BIN: "/missing" }, { platform: "darwin", isFile: () => false }),
    [],
  );
});

test("on Windows the py launcher is asked for each version, then python, then the install folders", () => {
  const files = [
    "C:\\Windows\\py.exe",
    "C:\\Tools\\python.exe",
    "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe",
    "C:\\Users\\a\\AppData\\Local\\Programs\\Python\\Python311\\python.exe",
    "C:\\Program Files\\Python310\\python.exe",
  ];
  const found = pythonCandidates(
    {
      PATH: "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools",
      SystemRoot: "C:\\Windows",
      LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
      ProgramFiles: "C:\\Program Files",
    },
    { platform: "win32", isFile: filesOf(files) },
  );
  assert.deepEqual(
    found.map((c) => [c.command, ...c.args]),
    [
      ["C:\\Windows\\py.exe", "-3.13"],
      ["C:\\Windows\\py.exe", "-3.12"],
      ["C:\\Windows\\py.exe", "-3.11"],
      ["C:\\Windows\\py.exe", "-3.10"],
      ["C:\\Windows\\py.exe", "-3"],
      ["C:\\Tools\\python.exe"],
      ["C:\\Users\\a\\AppData\\Local\\Programs\\Python\\Python311\\python.exe"],
      ["C:\\Program Files\\Python310\\python.exe"],
    ],
  );
  assert.deepEqual(
    found.slice(0, 2).map((c) => c.label),
    ["py -3.13", "py -3.12"],
  );
});

test("on Windows without any Python nothing is listed, and the hint says what to install", () => {
  assert.deepEqual(
    pythonCandidates({ PATH: "C:\\Windows" }, { platform: "win32", isFile: () => false }),
    [],
  );
  assert.match(pythonInstallHint("win32"), /python\.org.*winget install Python\.Python\.3\.12/);
  assert.match(pythonInstallHint("darwin"), /brew install python@3\.12/);
  assert.match(pythonInstallHint("darwin"), /3\.10 to 3\.13/);
  assert.match(ffmpegInstallHint("darwin"), /brew install ffmpeg/);
  assert.match(ffmpegInstallHint("win32"), /ffmpeg\.exe and ffprobe\.exe/);
});

test("the command lines of venv and pip never ask a question", () => {
  assert.deepEqual(venvArgs("/d/venv"), ["-m", "venv", "/d/venv"]);
  assert.deepEqual(venvArgs("/d/venv", { clear: true }), ["-m", "venv", "--clear", "/d/venv"]);
  assert.deepEqual(pipInstallArgs("C:\\t\\requirements.txt"), [
    "-m",
    "pip",
    "install",
    "--no-input",
    "--disable-pip-version-check",
    "-r",
    "C:\\t\\requirements.txt",
  ]);
  assert.ok(PIP_UPGRADE_ARGS.includes("--no-input"));
  const env = pythonEnv(
    { PATH: "/bin", PYTHONHOME: "/x", PYTHONPATH: "/y", VIRTUAL_ENV: "/v" },
    { VE_X: "1" },
  );
  assert.equal(env.PIP_NO_INPUT, "1");
  assert.equal(env.PYTHONUTF8, "1");
  assert.equal(env.VE_X, "1");
  assert.equal(env.PATH, "/bin");
  assert.equal("PYTHONHOME" in env, false);
  assert.equal("PYTHONPATH" in env, false);
  assert.equal("VIRTUAL_ENV" in env, false);
});

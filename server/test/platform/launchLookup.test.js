import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_PATHEXT,
  findInDir,
  getVar,
  gitBash,
  gitBashCandidates,
  isStoreAlias,
  pathExtensions,
  whichInWindows,
  whichToolWindows,
} from "../../src/platform/launchLookup.js";

/** @param {string[]} files */
const fakeFs = (files) => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (/** @type {string} */ file) => set.has(file.toLowerCase());
};

describe("variables and extensions", () => {
  test("getVar ignores letter case and treats empty as unset", () => {
    assert.equal(getVar({ Path: "C:\\a" }, "PATH"), "C:\\a");
    assert.equal(getVar({ PATH: "x", Path: "y" }, "PATH"), "x");
    assert.equal(getVar({ PATH: "", Path: "y" }, "PATH"), "y");
    assert.equal(getVar({ PATH: "" }, "PATH"), null);
    assert.equal(getVar({}, "PATH"), null);
    assert.equal(getVar({ PATH: undefined }, "PATH"), null);
  });

  test("pathExtensions falls back to the Windows default", () => {
    assert.deepEqual(pathExtensions(".EXE;.Cmd; .bat ;;x;."), [".exe", ".cmd", ".bat"]);
    assert.deepEqual(pathExtensions(null), pathExtensions(DEFAULT_PATHEXT));
    assert.deepEqual(pathExtensions("  "), [".com", ".exe", ".bat", ".cmd"]);
    assert.deepEqual(pathExtensions(undefined), [".com", ".exe", ".bat", ".cmd"]);
  });
});

describe("finding programs", () => {
  const exts = [".exe", ".cmd"];

  test("findInDir takes the first extension that exists", () => {
    const isFile = fakeFs(["C:\\d\\tool.cmd", "C:\\d\\tool.exe"]);
    assert.equal(findInDir("C:\\d", "tool", exts, isFile), "C:\\d\\tool.exe");
    assert.equal(findInDir("C:\\d", "TOOL", [".cmd"], isFile), "C:\\d\\TOOL.cmd");
    assert.equal(findInDir("C:\\d", "none", exts, isFile), null);
  });

  test("a name that already has an executable extension is looked up as it is", () => {
    const isFile = fakeFs(["C:\\d\\tool.exe", "C:\\d\\tool.exe.exe"]);
    assert.equal(findInDir("C:\\d", "tool.exe", exts, isFile), "C:\\d\\tool.exe");
    assert.equal(findInDir("C:\\d", "TOOL.EXE", exts, isFile), "C:\\d\\TOOL.EXE");
  });

  test("whichInWindows walks the folders in order and ignores relative and quoted nonsense", () => {
    const isFile = fakeFs(["C:\\b\\node.exe", "C:\\c\\node.exe", "rel\\node.exe"]);
    assert.equal(
      whichInWindows("node", 'rel;;"C:\\a";"C:\\b";C:\\c', ".EXE", isFile),
      "C:\\b\\node.exe",
    );
    assert.equal(whichInWindows("node", "C:\\a", ".EXE", isFile), null);
    assert.equal(whichInWindows("node", "", ".EXE", isFile), null);
    assert.equal(whichInWindows("node", null, ".EXE", isFile), null);
  });
});

describe("Git Bash", () => {
  const PF = "C:\\Program Files";

  test("candidates: the setting, then next to git, then the install folders", () => {
    const isFile = fakeFs([`${PF}\\Git\\cmd\\git.exe`]);
    const list = gitBashCandidates(
      {
        CLAUDE_CODE_GIT_BASH_PATH: "D:\\mine\\bash.exe",
        Path: `${PF}\\Git\\cmd`,
        ProgramFiles: PF,
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
        USERPROFILE: "C:\\Users\\u",
      },
      isFile,
    );
    assert.equal(list[0], "D:\\mine\\bash.exe");
    assert.equal(list[1], `${PF}\\Git\\bin\\bash.exe`);
    assert.ok(list.includes("C:\\Users\\u\\AppData\\Local\\Programs\\Git\\bin\\bash.exe"));
    assert.ok(list.includes("C:\\Users\\u\\scoop\\apps\\git\\current\\bin\\bash.exe"));
    // No duplicates, whatever the letter case.
    assert.equal(new Set(list.map((c) => c.toLowerCase())).size, list.length);
  });

  test("a git in mingw64\\bin leads to the root two levels up", () => {
    const isFile = fakeFs([`${PF}\\Git\\mingw64\\bin\\git.exe`]);
    const list = gitBashCandidates({ Path: `${PF}\\Git\\mingw64\\bin` }, isFile);
    assert.ok(list.includes(`${PF}\\Git\\bin\\bash.exe`));
  });

  test("never the bash.exe of WSL", () => {
    const list = gitBashCandidates(
      { CLAUDE_CODE_GIT_BASH_PATH: "C:\\Windows\\System32\\bash.exe" },
      fakeFs([]),
    );
    assert.deepEqual(list, []);
  });

  test("gitBash is the first candidate that exists", () => {
    const isFile = fakeFs([`${PF}\\Git\\bin\\bash.exe`, "D:\\mine\\bash.exe"]);
    const env = { CLAUDE_CODE_GIT_BASH_PATH: "D:\\gone\\bash.exe", ProgramFiles: PF };
    assert.equal(gitBash(env, isFile), `${PF}\\Git\\bin\\bash.exe`);
    assert.equal(gitBash({}, fakeFs([])), null);
  });
});

describe("tools on Windows", () => {
  test("a Microsoft Store alias counts only when it runs", () => {
    assert.equal(
      isStoreAlias("C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe"),
      true,
    );
    assert.equal(isStoreAlias("C:\\Python\\python.exe"), false);
    const alias = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe";
    const env = { Path: "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps", PATHEXT: ".EXE" };
    const isFile = fakeFs([alias]);
    assert.equal(whichToolWindows("python3", env, { isFile, runs: () => false }), null);
    assert.equal(whichToolWindows("python3", env, { isFile, runs: () => true }), alias);
  });

  test("python3 is also python or the py launcher", () => {
    const env = { Path: "C:\\Python;C:\\Windows", PATHEXT: ".EXE" };
    assert.equal(
      whichToolWindows("python3", env, {
        isFile: fakeFs(["C:\\Python\\python.exe"]),
        runs: () => true,
      }),
      "C:\\Python\\python.exe",
    );
    assert.equal(
      whichToolWindows("python3", env, {
        isFile: fakeFs(["C:\\Windows\\py.exe"]),
        runs: () => true,
      }),
      "C:\\Windows\\py.exe",
    );
    assert.equal(whichToolWindows("ffmpeg", env, { isFile: fakeFs([]), runs: () => true }), null);
  });
});

// The parts of starting an OpenCode 2 server that differ between systems, on every system.

import assert from "node:assert/strict";
import test from "node:test";
import {
  envValue,
  instructionFiles,
  privateConfigDir,
  terminalName,
  userHome,
  withoutVars,
} from "../../src/platform/opencodeLaunch.js";

test("the terminal named in advice", () => {
  assert.equal(terminalName("darwin"), "Terminal");
  assert.equal(terminalName("linux"), "Terminal");
  assert.equal(terminalName("win32"), "PowerShell");
});

test("environment names have no letter case on Windows only", () => {
  const env = { Path: "C:\\bin" };
  assert.equal(envValue(env, "PATH", "win32"), "C:\\bin");
  assert.equal(envValue(env, "PATH", "darwin"), undefined);
});

test("the home folder", () => {
  assert.equal(userHome({ HOME: "/Users/e" }, "darwin"), "/Users/e");
  assert.equal(userHome({}, "darwin"), null);
  assert.equal(userHome({ HOME: "" }, "darwin"), null);
  assert.equal(userHome({ USERPROFILE: "C:\\Users\\e", HOME: "/x" }, "win32"), "C:\\Users\\e");
  assert.equal(userHome({ HOMEDRIVE: "D:", HOMEPATH: "\\Users\\e" }, "win32"), "D:\\Users\\e");
  assert.equal(userHome({ HOME: "/c/Users/e" }, "win32"), "/c/Users/e");
  assert.equal(userHome({ userprofile: "C:\\Users\\e" }, "win32"), "C:\\Users\\e");
  assert.equal(userHome({}, "win32"), null);
});

test("removing variables", () => {
  const env = { A: "1", b: "2", C: undefined, D: "4" };
  assert.deepEqual(withoutVars(env, ["A", "B"], "darwin"), { b: "2", D: "4" });
  assert.deepEqual(withoutVars(env, ["A", "B"], "win32"), { D: "4" });
});

test("the instruction files", () => {
  assert.deepEqual(instructionFiles("/E", "/Users/e", "darwin"), [
    "/E/CLAUDE.md",
    "/Users/e/.claude/CLAUDE.md",
  ]);
  assert.deepEqual(instructionFiles("/E", null, "darwin"), ["/E/CLAUDE.md"]);
  assert.deepEqual(instructionFiles("C:\\E", "C:\\Users\\e", "win32"), [
    "C:\\E\\CLAUDE.md",
    "C:\\Users\\e\\.claude\\CLAUDE.md",
  ]);
});

test("the private configuration folder", () => {
  assert.equal(
    privateConfigDir("/data/opencode/j1", "darwin"),
    "/data/opencode/j1/opencode2-config",
  );
  assert.equal(privateConfigDir("C:\\data\\j1", "win32"), "C:\\data\\j1\\opencode2-config");
});

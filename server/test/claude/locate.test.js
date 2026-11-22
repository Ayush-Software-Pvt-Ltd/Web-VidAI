import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  candidates,
  findClaude,
  inDirs,
  isExecutable,
  locateClaude,
  overrideOf,
  parseVersion,
  version,
  which,
  whichAllIn,
  whichIn,
  whichTool,
  wellKnown,
} from "../../src/agents/claude/locate.js";

const FAKE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "support",
  "fake-claude.sh",
);
const POSIX_ONLY = process.platform === "win32" ? "needs a POSIX shell" : false;

/** @type {string[]} */
const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-locate-"));
  dirs.push(fs.realpathSync(dir));
  return /** @type {string} */ (dirs.at(-1));
}
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** @param {Iterable<string>} files */
const fakeFs = (files) => {
  const set = new Set(files);
  return (/** @type {string} */ file) => set.has(file);
};

const MAC = {
  platform: /** @type {const} */ ("darwin"),
  arch: "arm64",
  home: "/Users/u",
  runsHere: () => true,
};

describe("candidates on a Mac", () => {
  test("PATH first, then the usual folders, without duplicates", () => {
    const files = [
      "/usr/local/bin/claude",
      "/Users/u/.local/bin/claude",
      "/Users/u/.claude/local/claude",
      "/opt/homebrew/bin/claude",
    ];
    const env = { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/u" };
    assert.deepEqual(candidates(env, { ...MAC, isFile: fakeFs(files) }), [
      "/opt/homebrew/bin/claude",
      "/Users/u/.local/bin/claude",
      "/Users/u/.claude/local/claude",
      "/usr/local/bin/claude",
    ]);
    assert.equal(findClaude(env, { ...MAC, isFile: fakeFs(files) }), "/opt/homebrew/bin/claude");
  });

  test("VIDAI_CLAUDE_BIN wins and is the only candidate", () => {
    const files = ["/fake/claude", "/opt/homebrew/bin/claude"];
    const env = { PATH: "/opt/homebrew/bin", VIDAI_CLAUDE_BIN: "/fake/claude" };
    assert.deepEqual(candidates(env, { ...MAC, isFile: fakeFs(files) }), ["/fake/claude"]);
    // A file that does not exist is no candidate, and nothing else is tried.
    const missing = { PATH: "/opt/homebrew/bin", VIDAI_CLAUDE_BIN: "/nope/claude" };
    assert.deepEqual(candidates(missing, { ...MAC, isFile: fakeFs(files) }), []);
    assert.equal(overrideOf(missing, MAC), "/nope/claude");
    assert.equal(overrideOf({}, MAC), null);
    // An empty value counts as unset; a leading ~ is the home folder.
    assert.equal(overrideOf({ VIDAI_CLAUDE_BIN: "" }, MAC), null);
    assert.equal(overrideOf({ VIDAI_CLAUDE_BIN: "~/bin/claude" }, MAC), "/Users/u/bin/claude");
  });

  test("a file for the other processor is skipped like a missing file", () => {
    const files = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
    const env = { PATH: "/opt/homebrew/bin:/usr/local/bin" };
    const list = candidates(env, {
      ...MAC,
      isFile: fakeFs(files),
      runsHere: (file) => file !== "/opt/homebrew/bin/claude",
    });
    assert.deepEqual(list, ["/usr/local/bin/claude"]);
    // The override is skipped as well when it cannot run here.
    assert.deepEqual(
      candidates(
        { VIDAI_CLAUDE_BIN: "/opt/homebrew/bin/claude" },
        { ...MAC, isFile: fakeFs(files), runsHere: () => false },
      ),
      [],
    );
  });

  test("relative PATH entries are ignored", () => {
    const env = { PATH: "bin:./x::/usr/bin" };
    assert.deepEqual(
      candidates(env, { ...MAC, isFile: fakeFs(["bin/claude", "/usr/bin/claude"]) }),
      ["/usr/bin/claude"],
    );
  });

  test("the Homebrew folders are listed for a Mac, not for Windows", () => {
    assert.ok(wellKnown({}, MAC).includes("/opt/homebrew/bin"));
    const win = wellKnown(
      { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      { platform: "win32", arch: "x64", home: "C:\\Users\\u" },
    );
    assert.ok(win.includes("C:\\Users\\u\\.local\\bin"));
    assert.ok(win.includes("C:\\Users\\u\\AppData\\Roaming\\npm"));
    assert.ok(!win.some((d) => d.includes("homebrew")));
  });
});

describe("candidates on Windows", () => {
  const WIN = {
    platform: /** @type {const} */ ("win32"),
    arch: "x64",
    home: "C:\\Users\\u",
    runsHere: () => true,
  };

  test("uses PATHEXT, one per folder, the first extension of PATHEXT that exists", () => {
    const files = ["C:\\tools\\claude.cmd", "C:\\apps\\claude.exe", "C:\\apps\\claude.cmd"];
    const env = { Path: "C:\\tools;C:\\apps", PATHEXT: ".EXE;.CMD" };
    // The variable names of Windows are case-insensitive.
    assert.deepEqual(candidates(env, { ...WIN, isFile: fakeFs(files) }), [
      "C:\\tools\\claude.cmd",
      "C:\\apps\\claude.exe",
    ]);
  });

  test("finds the npm shim and the native install", () => {
    const files = [
      "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd",
      "C:\\Users\\u\\.local\\bin\\claude.exe",
    ];
    const env = {
      Path: "C:\\Windows",
      APPDATA: "C:\\Users\\u\\AppData\\Roaming",
      USERPROFILE: "C:\\Users\\u",
    };
    assert.deepEqual(candidates(env, { ...WIN, home: undefined, isFile: fakeFs(files) }), [
      "C:\\Users\\u\\.local\\bin\\claude.exe",
      "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd",
    ]);
  });
});

describe("path searches", () => {
  test("whichIn, whichAllIn and inDirs", () => {
    const isFile = fakeFs(["/a/x", "/b/x", "/b/y"]);
    const options = { platform: /** @type {const} */ ("linux"), isFile };
    assert.equal(whichIn("x", "/a:/b", options), "/a/x");
    assert.deepEqual(whichAllIn("x", "/a:/b:/c", options), ["/a/x", "/b/x"]);
    assert.equal(whichIn("x", "", options), null);
    assert.equal(whichIn("x", null, options), null);
    assert.deepEqual(inDirs(["/a", "/b"], ["y", "x"], options), ["/a/x", "/b/y", "/b/x"]);
  });

  test("which and whichTool use the environment", () => {
    const isFile = fakeFs(["/usr/bin/ffmpeg", "/Users/u/.local/bin/tool"]);
    const machine = { ...MAC, isFile };
    assert.equal(which("ffmpeg", { PATH: "/usr/bin" }, machine), "/usr/bin/ffmpeg");
    assert.equal(which("ffmpeg", { PATH: "/bin" }, machine), null);
    assert.equal(whichTool("tool", { PATH: "/bin" }, machine), "/Users/u/.local/bin/tool");
    assert.equal(whichTool("nothing", { PATH: "/bin" }, machine), null);
  });
});

describe("the real file system", { skip: POSIX_ONLY }, () => {
  test("isExecutable needs a regular file with an execute bit", () => {
    const dir = tempDir();
    const run = path.join(dir, "run");
    const plain = path.join(dir, "plain");
    fs.writeFileSync(run, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(plain, "x", { mode: 0o644 });
    assert.equal(isExecutable(run), true);
    assert.equal(isExecutable(plain), false);
    assert.equal(isExecutable(dir), false);
    assert.equal(isExecutable(path.join(dir, "missing")), false);
  });

  test("a search through real folders skips files that cannot be started", () => {
    const a = tempDir();
    const b = tempDir();
    fs.writeFileSync(path.join(a, "claude"), "x", { mode: 0o644 });
    fs.writeFileSync(path.join(b, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    assert.deepEqual(candidates({ PATH: `${a}:${b}` }, { ...MAC, home: null, platform: "linux" }), [
      path.join(b, "claude"),
    ]);
  });
});

describe("the version", () => {
  test("parseVersion", () => {
    assert.equal(parseVersion("2.1.319 (Claude Code)\n"), "2.1.319");
    assert.equal(parseVersion("claude 3.0.0-beta.1 build"), "3.0.0-beta.1");
    assert.equal(parseVersion("no number"), null);
    assert.equal(parseVersion(""), null);
  });

  test("parseVersion accepts a leading v and keeps the v out of the number", () => {
    assert.equal(parseVersion("opencode v2.2.6\n"), "2.2.6");
    assert.equal(parseVersion("v1.0.0"), "1.0.0");
    assert.equal(parseVersion("tool v3.1.4-rc.1 (build 7)"), "3.1.4-rc.1");
    // A `v` inside a word is not a version prefix.
    assert.equal(parseVersion("dev2.0.1"), null);
    assert.equal(parseVersion("2.1.319 (Claude Code)"), "2.1.319");
  });

  test("the fake answers --version", { skip: POSIX_ONLY }, async () => {
    assert.equal(await version(FAKE, { PATH: "/usr/bin:/bin" }), "2.1.319");
    assert.deepEqual(await locateClaude({ VIDAI_CLAUDE_BIN: FAKE, PATH: "/usr/bin:/bin" }), {
      path: FAKE,
      version: "2.1.319",
    });
  });

  test(
    "a program that fails, hangs or is missing has no version",
    { skip: POSIX_ONLY },
    async () => {
      const dir = tempDir();
      const failing = path.join(dir, "failing");
      const hanging = path.join(dir, "hanging");
      fs.writeFileSync(failing, "#!/bin/sh\necho 'boom' >&2\nexit 1\n", { mode: 0o755 });
      fs.writeFileSync(hanging, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
      const env = { PATH: "/usr/bin:/bin" };
      assert.equal(await version(failing, env), null);
      const started = Date.now();
      assert.equal(await version(hanging, env, { timeoutMs: 300 }), null);
      assert.ok(Date.now() - started < 5000, "the limit ends the program");
      assert.equal(await version(path.join(dir, "missing"), env), null);
    },
  );

  test(
    "locateClaude takes the first candidate that answers, else reports the first",
    { skip: POSIX_ONLY },
    async () => {
      const dir = tempDir();
      const broken = path.join(dir, "broken", "claude");
      const good = path.join(dir, "good", "claude");
      fs.mkdirSync(path.dirname(broken));
      fs.mkdirSync(path.dirname(good));
      fs.writeFileSync(broken, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      fs.writeFileSync(good, "#!/bin/sh\necho '9.8.7 (Claude Code)'\n", { mode: 0o755 });
      const path1 = `${path.dirname(broken)}:${path.dirname(good)}:/usr/bin:/bin`;
      const machine = { platform: process.platform, home: null };
      assert.deepEqual(await locateClaude({ PATH: path1 }, machine), {
        path: good,
        version: "9.8.7",
      });
      // Only a broken one: it is returned so the caller can name the file.
      assert.deepEqual(await locateClaude({ PATH: path.dirname(broken) }, machine), {
        path: broken,
        version: null,
      });
      assert.equal(await locateClaude({ PATH: "/nonexistent" }, machine), null);
    },
  );
});

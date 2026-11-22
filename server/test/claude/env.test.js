import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  agentEnv,
  expandHome,
  homebrewBins,
  wellKnownDirs,
  withDirs,
} from "../../src/agents/claude/env.js";

const MAC_ARM = { platform: /** @type {const} */ ("darwin"), arch: "arm64", home: "/Users/u" };
const MAC_INTEL = { platform: /** @type {const} */ ("darwin"), arch: "x64", home: "/Users/u" };

describe("agentEnv", () => {
  test("strips every VIDAI_ADMIN_ variable, whatever its letter case", () => {
    const env = agentEnv(
      {
        PATH: "/usr/bin",
        VIDAI_ADMIN_PASSWORD: "secret",
        VIDAI_ADMIN_TOKEN: "t",
        vidai_admin_lower: "x",
        VIDAI_CLAUDE_BIN: "/x/claude",
        VIDAI_ADMIN: "no underscore after the prefix name",
        KEEP: "1",
      },
      MAC_ARM,
    );
    assert.equal(env["VIDAI_ADMIN_PASSWORD"], undefined);
    assert.equal(env["VIDAI_ADMIN_TOKEN"], undefined);
    assert.equal(env["vidai_admin_lower"], undefined);
    assert.equal(env["VIDAI_CLAUDE_BIN"], "/x/claude");
    assert.equal(env["VIDAI_ADMIN"], "no underscore after the prefix name");
    assert.equal(env["KEEP"], "1");
  });

  test("strips admin variables on Windows too and keeps PATH as it is", () => {
    const env = agentEnv(
      { Path: "C:\\Windows", VIDAI_ADMIN_X: "1", OTHER: "o" },
      { platform: "win32", arch: "x64", home: "C:\\Users\\u" },
    );
    assert.deepEqual(env, { Path: "C:\\Windows", OTHER: "o" });
    assert.deepEqual(agentEnv({}, { platform: "win32", arch: "x64" }), {});
  });

  test("extends a macOS PATH with the usual folders, Homebrew of this processor first", () => {
    const arm = agentEnv({ PATH: "/usr/bin:/bin" }, MAC_ARM)["PATH"];
    assert.equal(
      arm,
      [
        "/usr/bin",
        "/bin",
        "/Users/u/.local/bin",
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/opt/local/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
    );
    const intel = agentEnv({ PATH: "/usr/bin:/bin" }, MAC_INTEL)["PATH"];
    assert.equal(
      intel,
      [
        "/usr/bin",
        "/bin",
        "/Users/u/.local/bin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/opt/local/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
    );
  });

  test("builds a PATH when there is none and keeps the existing order and entries", () => {
    const built = /** @type {string} */ (agentEnv({}, MAC_ARM)["PATH"]).split(":");
    assert.equal(built[0], "/Users/u/.local/bin");
    assert.ok(built.includes("/opt/homebrew/bin") && built.includes("/sbin"));
    const mine = agentEnv({ PATH: "/custom/bin:/opt/homebrew/bin:/another" }, MAC_ARM)["PATH"];
    assert.ok(mine?.startsWith("/custom/bin:/opt/homebrew/bin:/another:/Users/u/.local/bin:"));
    assert.equal(mine?.split(":").filter((p) => p === "/opt/homebrew/bin").length, 1);
  });

  test("a Linux PATH gets the system folders but not Homebrew or MacPorts", () => {
    const path = /** @type {string} */ (
      agentEnv({ PATH: "/usr/bin" }, { platform: "linux", arch: "x64", home: "/home/u" })["PATH"]
    );
    assert.ok(path.includes("/home/u/.local/bin") && path.includes("/usr/local/bin"));
    assert.ok(!path.includes("homebrew") && !path.includes("/opt/local"));
  });

  test("sets HOME when it is missing and does not touch the one that is there", () => {
    assert.equal(agentEnv({}, MAC_ARM)["HOME"], "/Users/u");
    assert.equal(agentEnv({ HOME: "/h" }, { ...MAC_ARM, home: "/Users/u" })["HOME"], "/h");
  });

  test("leaves its input alone and drops undefined values", () => {
    const input = { PATH: "/usr/bin", GONE: undefined };
    const env = agentEnv(input, MAC_ARM);
    assert.deepEqual(input, { PATH: "/usr/bin", GONE: undefined });
    assert.ok(!("GONE" in env));
    assert.notEqual(env, input);
  });
});

describe("helpers", () => {
  test("homebrewBins keeps both layouts", () => {
    assert.deepEqual(homebrewBins("arm64").slice(0, 2), [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
    ]);
    assert.deepEqual(homebrewBins("x64").slice(0, 2), ["/usr/local/bin", "/usr/local/sbin"]);
    assert.equal(homebrewBins("arm64").length, 4);
  });

  test("wellKnownDirs", () => {
    assert.deepEqual(wellKnownDirs({ platform: "win32", arch: "x64", home: "C:\\u" }), []);
    assert.equal(
      wellKnownDirs({ platform: "darwin", arch: "arm64", home: null })[0],
      "/opt/homebrew/bin",
    );
  });

  test("withDirs appends only what is missing", () => {
    assert.equal(withDirs("/a:/b", ["/b", "/c", "/c"]), "/a:/b:/c");
    assert.equal(withDirs(undefined, ["/a"]), "/a");
    assert.equal(withDirs("a;b", ["c", "a"], ";"), "a;b;c");
    assert.equal(withDirs("/a::/b:", []), "/a:/b");
  });

  test("expandHome", () => {
    assert.equal(expandHome("~", "/Users/u"), "/Users/u");
    assert.equal(expandHome("~/bin/claude", "/Users/u"), "/Users/u/bin/claude");
    assert.equal(expandHome("/abs/~/x", "/Users/u"), "/abs/~/x");
    assert.equal(expandHome("~other", "/Users/u"), "~other");
    assert.equal(expandHome("~/x", null), "~/x");
  });
});

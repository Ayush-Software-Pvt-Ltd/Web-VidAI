import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { defaultDataDir, restrictToOwner } from "../../src/platform/paths.js";

describe("defaultDataDir", () => {
  test("macOS", () => {
    assert.equal(
      defaultDataDir({ platform: "darwin", home: "/Users/me", env: {} }),
      "/Users/me/Library/Application Support/VidAI Server",
    );
  });

  test("Windows uses LOCALAPPDATA and falls back to the profile", () => {
    assert.equal(
      defaultDataDir({
        platform: "win32",
        home: "C:\\Users\\me",
        env: { LOCALAPPDATA: "D:\\Local" },
      }),
      "D:\\Local\\VidAI Server",
    );
    assert.equal(
      defaultDataDir({ platform: "win32", home: "C:\\Users\\me", env: {} }),
      "C:\\Users\\me\\AppData\\Local\\VidAI Server",
    );
  });

  test("other systems use XDG_DATA_HOME or ~/.local/share", () => {
    assert.equal(
      defaultDataDir({ platform: "linux", home: "/home/me", env: { XDG_DATA_HOME: "/xdg" } }),
      "/xdg/vidai-server",
    );
    assert.equal(
      defaultDataDir({ platform: "linux", home: "/home/me", env: {} }),
      "/home/me/.local/share/vidai-server",
    );
  });

  test("defaults to the running system", () => {
    assert.ok(path.isAbsolute(defaultDataDir()));
  });
});

describe("restrictToOwner", () => {
  test("files become 0600 and directories 0700", { skip: process.platform === "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-paths-"));
    try {
      const file = path.join(dir, "key");
      fs.writeFileSync(file, "x", { mode: 0o644 });
      fs.chmodSync(file, 0o644);
      restrictToOwner(file);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      fs.chmodSync(dir, 0o755);
      restrictToOwner(dir);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does nothing on Windows", () => {
    // Not even a missing path matters there.
    restrictToOwner("/does/not/exist", { platform: "win32" });
  });
});

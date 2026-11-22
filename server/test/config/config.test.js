import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  dataPaths,
  loadConfig,
  prepareDataDir,
  usageText,
} from "../../src/config.js";

const base = { platform: "linux", home: "/home/me", cwd: "/work", env: {} };

describe("loadConfig", () => {
  test("defaults", () => {
    const config = loadConfig({ ...base, argv: [] });
    assert.equal(config.port, DEFAULT_PORT);
    assert.equal(config.port, 14200);
    assert.equal(config.host, DEFAULT_HOST);
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.dataDir, "/home/me/.local/share/vidai-server");
    assert.equal(config.help, false);
    assert.equal(config.command, null);
    assert.ok(path.isAbsolute(config.uiDist));
    assert.ok(config.uiDist.endsWith(`${path.sep}dist`));
  });

  test("command line options", () => {
    const config = loadConfig({
      ...base,
      argv: ["--port", "8443", "--host", "127.0.0.1", "--data", "/srv/vidai"],
    });
    assert.deepEqual([config.port, config.host, config.dataDir], [8443, "127.0.0.1", "/srv/vidai"]);
    const equals = loadConfig({ ...base, argv: ["--port=9000", "--data=rel/dir"] });
    assert.equal(equals.port, 9000);
    assert.equal(equals.dataDir, "/work/rel/dir");
  });

  test("environment", () => {
    const config = loadConfig({
      ...base,
      argv: [],
      env: {
        VIDAI_PORT: "7000",
        VIDAI_HOST: "::1",
        VIDAI_DATA_DIR: "/data/x",
        VIDAI_UI_DIST: "ui-out",
      },
    });
    assert.deepEqual(
      [config.port, config.host, config.dataDir, config.uiDist],
      [7000, "::1", "/data/x", "/work/ui-out"],
    );
  });

  test("an option wins over the environment", () => {
    const config = loadConfig({
      ...base,
      argv: ["--port", "1", "--host", "h", "--data", "/a"],
      env: { VIDAI_PORT: "2", VIDAI_HOST: "g", VIDAI_DATA_DIR: "/b" },
    });
    assert.deepEqual([config.port, config.host, config.dataDir], [1, "h", "/a"]);
  });

  test("empty environment values count as unset", () => {
    const config = loadConfig({
      ...base,
      argv: [],
      env: { VIDAI_PORT: " ", VIDAI_HOST: "", VIDAI_DATA_DIR: "" },
    });
    assert.equal(config.port, DEFAULT_PORT);
    assert.equal(config.host, DEFAULT_HOST);
  });

  test("port 0 is allowed, other bad ports are invalidInput", () => {
    assert.equal(loadConfig({ ...base, argv: ["--port", "0"] }).port, 0);
    for (const bad of ["abc", "-1", "65536", "1.5", "80x", "123456"]) {
      assert.throws(
        () => loadConfig({ ...base, argv: ["--port", bad] }),
        { code: "invalidInput", message: /--port/ },
        bad,
      );
    }
    assert.throws(() => loadConfig({ ...base, argv: [], env: { VIDAI_PORT: "x" } }), /VIDAI_PORT/);
  });

  test("an option without a value is invalidInput", () => {
    for (const option of ["--port", "--host", "--data"]) {
      assert.throws(() => loadConfig({ ...base, argv: [option] }), { code: "invalidInput" });
    }
  });

  test("-h and --help", () => {
    assert.equal(loadConfig({ ...base, argv: ["-h"] }).help, true);
    assert.equal(loadConfig({ ...base, argv: ["--help"] }).help, true);
    for (const option of ["--port", "--host", "--data", "-h"]) {
      assert.ok(usageText().includes(option));
    }
  });

  test("a sub-command and its own options pass through", () => {
    const config = loadConfig({
      ...base,
      argv: ["admin-reset", "--email", "admin@example.com", "--data", "/d"],
    });
    assert.equal(config.command, "admin-reset");
    assert.equal(config.extra.email, "admin@example.com");
    assert.equal(config.dataDir, "/d");
  });

  test("the default data directory follows the system", () => {
    const mac = loadConfig({ argv: [], env: {}, platform: "darwin", home: "/Users/me" });
    assert.equal(mac.dataDir, "/Users/me/Library/Application Support/VidAI Server");
  });
});

describe("data directory", () => {
  test("dataPaths follows the table of docs/SPEC.md section 2", () => {
    const paths = dataPaths("/d");
    assert.equal(paths.db, path.join("/d", "vidai.db"));
    assert.equal(paths.secretKey, path.join("/d", "secret.key"));
    assert.equal(paths.certFile, path.join("/d", "tls", "cert.pem"));
    assert.equal(paths.keyFile, path.join("/d", "tls", "key.pem"));
    assert.equal(paths.serverLog, path.join("/d", "server.log"));
    assert.equal(paths.proxyCacheDir, path.join("/d", "cache", "proxy"));
    assert.equal(paths.renderCacheDir, path.join("/d", "cache", "render"));
    assert.equal(paths.lockFile, path.join("/d", "server.lock"));
  });

  test("prepareDataDir creates the directory and every sub-folder, privately", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-config-"));
    try {
      const dataDir = path.join(parent, "a", "b");
      const paths = prepareDataDir(dataDir);
      for (const dir of [
        "tls",
        "logs",
        "toolkit",
        "media",
        "projects",
        path.join("cache", "proxy"),
        path.join("cache", "render"),
        "locks",
      ]) {
        assert.ok(fs.statSync(path.join(dataDir, dir)).isDirectory(), dir);
      }
      assert.equal(paths.dataDir, dataDir);
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
        assert.equal(fs.statSync(paths.tlsDir).mode & 0o777, 0o700);
      }
      // Running it again changes nothing and keeps files.
      fs.writeFileSync(path.join(dataDir, "media", "keep.txt"), "x");
      prepareDataDir(dataDir);
      assert.equal(fs.readFileSync(path.join(dataDir, "media", "keep.txt"), "utf8"), "x");
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test("an existing directory keeps its mode", { skip: process.platform === "win32" }, () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-config-"));
    try {
      fs.chmodSync(parent, 0o755);
      prepareDataDir(parent);
      assert.equal(fs.statSync(parent).mode & 0o777, 0o755);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a directory that cannot be made is an io error", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-config-"));
    try {
      const file = path.join(parent, "file");
      fs.writeFileSync(file, "x");
      assert.throws(() => prepareDataDir(path.join(file, "data")), { code: "io" });
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

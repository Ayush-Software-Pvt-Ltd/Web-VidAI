// The places of the admin's folder picker and the hidden entries of a folder (SPEC section 6,
// "Folders on the server"). The Windows half runs on fake answers of the system, the Mac half on
// temporary folders standing in for `/` and `/Volumes`.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlaces } from "../../src/platform/places.js";
import * as windows from "../../src/platform/places.windows.js";

/** @param {string} code */
const failing = (code) => Object.assign(new Error(code), { code });

test("Windows: every drive letter that exists is a place, one that is not ready is unavailable", async () => {
  /** @type {Record<string, string | null>} */
  const drives = { "C:\\": null, "D:\\": "EPERM", "Z:\\": null, "E:\\": "EBUSY" };
  const places = createPlaces({
    platform: "win32",
    homeDir: "C:\\Users\\vid",
    stat: async (target) => {
      if (!(target in drives)) throw failing("ENOENT");
      const code = drives[target];
      if (code) throw failing(code);
      return {};
    },
  });
  assert.deepEqual(await places.list(), [
    { name: "Home", path: "C:\\Users\\vid", kind: "home", available: true },
    { name: "C:", path: "C:\\", kind: "drive", available: true },
    { name: "D:", path: "D:\\", kind: "drive", available: false },
    { name: "E:", path: "E:\\", kind: "drive", available: false },
    { name: "Z:", path: "Z:\\", kind: "drive", available: true },
  ]);
});

test("Windows: the top of a drive or share has no parent", () => {
  const places = createPlaces({ platform: "win32" });
  assert.equal(places.isDriveTop("D:\\"), true);
  assert.equal(places.isDriveTop("\\\\server\\share\\"), true);
  assert.equal(places.isDriveTop("D:\\Media"), false);
});

test("Windows: hidden and system entries come from dir /a:h and /a:s", async () => {
  /** @type {string[][]} */
  const asked = [];
  const places = createPlaces({
    platform: "win32",
    run: async (command, args) => {
      asked.push([command, ...args]);
      return args.includes("/a:h") ? "$RECYCLE.BIN\r\nthumbs\r\n" : "System Volume Information\r\n";
    },
  });
  const hidden = await places.hiddenNames("D:\\");
  assert.deepEqual([...hidden].sort(), ["$recycle.bin", "system volume information", "thumbs"]);
  assert.deepEqual(asked, [
    ["cmd.exe", "/d", "/c", "dir", "/b", "/a:h", "D:\\*"],
    ["cmd.exe", "/d", "/c", "dir", "/b", "/a:s", "D:\\*"],
  ]);
  assert.deepEqual(windows.dirArgs("C:\\Program Files\\", "h").at(-1), "C:\\Program Files\\*");
});

test("Windows: when the listing fails nothing is hidden", async () => {
  const places = createPlaces({ platform: "win32", run: async () => null });
  assert.equal((await places.hiddenNames("D:\\")).size, 0);
  assert.deepEqual(windows.parseDirNames(null), []);
  assert.deepEqual(windows.parseDirNames("a\r\n\r\n b \n"), ["a", "b"]);
});

test("macOS: nothing is hidden by the platform layer, dot names are the caller's", async () => {
  const places = createPlaces({ platform: "darwin" });
  assert.equal((await places.hiddenNames("/")).size, 0);
});

test("macOS: the startup volume is named after its link and left out of the volumes", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vidai-places-")));
  try {
    const volumes = path.join(root, "Volumes");
    const fakeRoot = path.join(root, "fsroot");
    fs.mkdirSync(volumes);
    fs.mkdirSync(fakeRoot);
    fs.symlinkSync(fakeRoot, path.join(volumes, "Macintosh HD"));
    fs.mkdirSync(path.join(volumes, "Photos"));
    fs.mkdirSync(path.join(volumes, "Archive"));
    const places = createPlaces({
      platform: "darwin",
      homeDir: path.join(root, "home"),
      rootDir: fakeRoot,
      volumesDir: volumes,
    });
    assert.deepEqual(
      (await places.list()).map((place) => [place.name, place.kind]),
      [
        ["Home", "home"],
        ["Macintosh HD", "drive"],
        ["Archive", "volume"],
        ["Photos", "volume"],
      ],
    );
    assert.equal(places.isDriveTop(path.join(volumes, "Photos")), true);
    assert.equal(places.isDriveTop(path.join(volumes, "Photos", "x")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("macOS: without a volumes folder there are home and the root only", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vidai-places-")));
  try {
    const places = createPlaces({
      platform: "darwin",
      homeDir: root,
      rootDir: root,
      volumesDir: path.join(root, "missing"),
    });
    assert.deepEqual(
      (await places.list()).map((place) => [place.name, place.kind, place.available]),
      [
        ["Home", "home", true],
        ["Macintosh HD", "drive", true],
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

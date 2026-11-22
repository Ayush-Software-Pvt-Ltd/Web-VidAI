import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  isArollName,
  mainAroll,
  scanChannelDirectory,
  scanVideoFolder,
} from "../../src/library/scan.js";
import { tempFolder, touch, write } from "./support.js";

/** @param {string} name @param {number} size */
const aroll = (name, size) => ({ name, path: `/x/${name}`, size, modifiedMs: 0 });

test("isArollName: the video extensions, any case", () => {
  for (const name of ["a.mp4", "a.MOV", "a.m4v", "a.mkv", "a.mts", "a.m2ts", "a.avi", "a.webm"]) {
    assert.equal(isArollName(name), true, name);
  }
  for (const name of ["a.txt", "a.png", "mp4", "a.mp4.txt", ".mp4x", "a"]) {
    assert.equal(isArollName(name), false, name);
  }
});

test("mainAroll: the largest file, ties go to the smaller name, none gives null", () => {
  assert.equal(mainAroll([]), null);
  assert.equal(mainAroll([aroll("a.mp4", 5), aroll("b.mp4", 9), aroll("c.mp4", 7)])?.name, "b.mp4");
  assert.equal(mainAroll([aroll("b.mp4", 9), aroll("a.mp4", 9)])?.name, "a.mp4");
  assert.equal(mainAroll([aroll("a.mp4", 9), aroll("b.mp4", 9)])?.name, "a.mp4");
});

test("a channel directory lists videos newest first in natural order", async () => {
  const dir = tempFolder();
  try {
    for (const name of ["001 A", "002 B", "010 C", "9 D"]) fs.mkdirSync(path.join(dir.dir, name));
    const scan = await scanChannelDirectory(dir.dir);
    assert.equal(scan.available, true);
    assert.deepEqual(scan.folderNames, ["010 C", "9 D", "002 B", "001 A"]);
    assert.deepEqual(
      scan.videos.map((v) => v.folderName),
      ["010 C", "9 D", "002 B", "001 A"],
    );
  } finally {
    dir.cleanup();
  }
});

test("reserved names, hidden entries, plain files and links are not videos", async () => {
  const dir = tempFolder();
  const outside = tempFolder();
  try {
    for (const name of [
      "001 Real",
      ".hidden",
      "CLAUDE_VE",
      "CLAUDE_VE_extra",
      "Prompts",
      "Brand Assets",
      "upload",
    ]) {
      fs.mkdirSync(path.join(dir.dir, name));
    }
    write(path.join(dir.dir, "notes.txt"));
    fs.mkdirSync(path.join(outside.dir, "elsewhere"));
    fs.symlinkSync(path.join(outside.dir, "elsewhere"), path.join(dir.dir, "linked"));
    const scan = await scanChannelDirectory(dir.dir);
    const names = scan.videos.map((v) => v.folderName);
    assert.ok(names.includes("001 Real"));
    for (const name of [
      ".hidden",
      "CLAUDE_VE",
      "CLAUDE_VE_extra",
      "upload",
      "notes.txt",
      "linked",
    ]) {
      assert.ok(!names.includes(name), name);
      assert.ok(!scan.folderNames.includes(name), name);
    }
  } finally {
    dir.cleanup();
    outside.cleanup();
  }
});

test("a missing, unreadable or non-directory channel path is unavailable", async () => {
  const dir = tempFolder();
  try {
    const missing = await scanChannelDirectory(path.join(dir.dir, "gone"));
    assert.deepEqual(missing, { available: false, folderNames: [], videos: [] });
    const file = write(path.join(dir.dir, "file"));
    assert.equal((await scanChannelDirectory(file)).available, false);
  } finally {
    dir.cleanup();
  }
});

test("skip leaves folders unscanned but still names them", async () => {
  const dir = tempFolder();
  try {
    fs.mkdirSync(path.join(dir.dir, "a"));
    fs.mkdirSync(path.join(dir.dir, "b"));
    const scan = await scanChannelDirectory(dir.dir, { skip: (name) => name === "a" });
    assert.deepEqual(scan.folderNames, ["b", "a"]);
    assert.deepEqual(
      scan.videos.map((v) => v.folderName),
      ["b"],
    );
  } finally {
    dir.cleanup();
  }
});

test("a video folder: A-roll files in natural order, the main one is the largest", async () => {
  const dir = tempFolder();
  try {
    const video = path.join(dir.dir, "v");
    write(path.join(video, "clip10.mp4"), "x".repeat(10));
    write(path.join(video, "clip2.mp4"), "x".repeat(300));
    write(path.join(video, "clip1.MOV"), "x".repeat(20));
    write(path.join(video, "notes.txt"), "x".repeat(900));
    write(path.join(video, ".hidden.mp4"), "x".repeat(900));
    fs.mkdirSync(path.join(video, "folder.mp4"));
    const scanned = await scanVideoFolder(video, "v", dir.dir);
    assert.ok(scanned);
    assert.deepEqual(
      scanned.arollFiles.map((f) => f.name),
      ["clip1.MOV", "clip2.mp4", "clip10.mp4"],
    );
    assert.equal(scanned.mainAroll?.name, "clip2.mp4");
    assert.equal(scanned.mainAroll?.size, 300);
    assert.equal(scanned.mainAroll?.path, path.join(video, "clip2.mp4"));
  } finally {
    dir.cleanup();
  }
});

test("the B-roll folder: a matching name is used, else the default name", async () => {
  const dir = tempFolder();
  try {
    fs.mkdirSync(path.join(dir.dir, "with", "B_Rolls"), { recursive: true });
    fs.mkdirSync(path.join(dir.dir, "with", "other"));
    fs.mkdirSync(path.join(dir.dir, "without", "other"), { recursive: true });
    assert.equal(
      (await scanVideoFolder(path.join(dir.dir, "with"), "with", dir.dir))?.brollFolder,
      "B_Rolls",
    );
    assert.equal(
      (await scanVideoFolder(path.join(dir.dir, "without"), "without", dir.dir))?.brollFolder,
      "Broll",
    );
  } finally {
    dir.cleanup();
  }
});

test("a video's own `upload` folder is not B-roll and its files are not A-roll", async () => {
  const dir = tempFolder();
  try {
    write(path.join(dir.dir, "v", "main.mp4"), "12345");
    write(path.join(dir.dir, "v", "upload", "big.mp4"), "1234567890");
    write(path.join(dir.dir, "v", "upload", "note.txt"));
    const scanned = await scanVideoFolder(path.join(dir.dir, "v"), "v", dir.dir);
    assert.equal(scanned?.brollFolder, "Broll");
    assert.deepEqual(
      scanned?.arollFiles.map((file) => file.name),
      ["main.mp4"],
    );
    assert.equal(scanned?.mainAroll?.name, "main.mp4");
  } finally {
    dir.cleanup();
  }
});

test("createdAt is the folder's creation time, else its modified time", async () => {
  const dir = tempFolder();
  try {
    const video = path.join(dir.dir, "v");
    fs.mkdirSync(video);
    touch(video, 1_500_000_000_000);
    const stat = fs.statSync(video);
    const scanned = await scanVideoFolder(video, "v", dir.dir);
    const expected = Math.round(stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs);
    assert.equal(scanned?.createdAt, expected);
    assert.ok(Number.isInteger(scanned?.createdAt));
    assert.ok((scanned?.createdAt ?? 0) > 0);
  } finally {
    dir.cleanup();
  }
});

test("a vanished video folder scans as null", async () => {
  const dir = tempFolder();
  try {
    assert.equal(await scanVideoFolder(path.join(dir.dir, "gone"), "gone", dir.dir), null);
  } finally {
    dir.cleanup();
  }
});

test("A-roll links that lead out of the channel directory are ignored", async () => {
  const dir = tempFolder();
  const outside = tempFolder();
  try {
    const video = path.join(dir.dir, "v");
    write(path.join(video, "inside.mp4"), "xx");
    const target = write(path.join(outside.dir, "outside.mp4"), "x".repeat(500));
    fs.symlinkSync(target, path.join(video, "linked.mp4"));
    fs.symlinkSync(path.join(video, "inside.mp4"), path.join(video, "alias.mp4"));
    const scanned = await scanVideoFolder(video, "v", dir.dir);
    const names = scanned?.arollFiles.map((f) => f.name);
    assert.ok(names?.includes("inside.mp4"));
    assert.ok(!names?.includes("linked.mp4"));
    assert.equal(scanned?.mainAroll?.name, "alias.mp4");
  } finally {
    dir.cleanup();
    outside.cleanup();
  }
});

test("workingFiles: CLAUDE_VE with a file inside", async () => {
  const dir = tempFolder();
  try {
    fs.mkdirSync(path.join(dir.dir, "empty", "CLAUDE_VE", "deep"), { recursive: true });
    write(path.join(dir.dir, "full", "CLAUDE_VE", "deep", "a.txt"));
    fs.mkdirSync(path.join(dir.dir, "none"));
    const scan = await scanChannelDirectory(dir.dir);
    const byName = Object.fromEntries(scan.videos.map((v) => [v.folderName, v.workingFiles]));
    assert.deepEqual(byName, { full: true, empty: false, none: false });
  } finally {
    dir.cleanup();
  }
});

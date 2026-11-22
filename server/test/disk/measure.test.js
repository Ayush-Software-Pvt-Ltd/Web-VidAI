import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fingerprintVideoFolder, measureVideoFolder } from "../../src/disk/measure.js";
import { partOf } from "../../src/disk/layout.js";
import { canRestrict, layoutVideo, write } from "./support.js";
import { tempFolder } from "../library/support.js";

test("each part of a video folder is measured on its own", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    const video = path.join(dir, "ep 1");
    const expected = layoutVideo(video);
    assert.deepEqual(await measureVideoFolder(video, "ep 1"), expected);
  } finally {
    cleanup();
  }
});

test("an empty or missing folder has no size", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    const empty = { working: 0, project: 0, finals: 0, sources: 0, total: 0 };
    fs.mkdirSync(path.join(dir, "empty"));
    assert.deepEqual(await measureVideoFolder(path.join(dir, "empty"), "empty"), empty);
    assert.deepEqual(await measureVideoFolder(path.join(dir, "gone"), "gone"), empty);
  } finally {
    cleanup();
  }
});

test("files are sorted into parts by name", () => {
  assert.equal(partOf(["CLAUDE_VE", "x", "y"], "v"), "working");
  assert.equal(partOf(["output", "v.hf", "index.html"], "v"), "project");
  assert.equal(partOf(["output", "v.hf"], "v"), "sources");
  assert.equal(partOf(["output", "other.hf", "index.html"], "v"), "sources");
  assert.equal(partOf(["output", "v_final_v3.mp4"], "v"), "finals");
  assert.equal(partOf(["output", "V_FINAL_V3.MP4"], "v"), "finals");
  assert.equal(partOf(["output", "v_final_v3.mov"], "v"), "sources");
  assert.equal(partOf(["output", "sub", "v_final_v3.mp4"], "v"), "sources");
  assert.equal(partOf(["CLAUDE_VE_old", "a"], "v"), "sources");
  assert.equal(partOf(["a-roll.mp4"], "v"), "sources");
});

test("links are not followed and count as nothing", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    const outside = path.join(dir, "outside");
    write(path.join(outside, "huge.bin"), Buffer.alloc(5000));
    const video = path.join(dir, "ep");
    write(path.join(video, "a.mp4"), Buffer.alloc(10));
    fs.symlinkSync(outside, path.join(video, "linked-folder"));
    fs.symlinkSync(path.join(outside, "huge.bin"), path.join(video, "linked-file"));
    fs.mkdirSync(path.join(video, "output"));
    fs.symlinkSync(outside, path.join(video, "output", "ep.hf"));
    fs.symlinkSync(outside, path.join(video, "CLAUDE_VE"));
    fs.symlinkSync(path.join(dir, "nowhere"), path.join(video, "broken"));
    assert.deepEqual(await measureVideoFolder(video, "ep"), {
      working: 0,
      project: 0,
      finals: 0,
      sources: 10,
      total: 10,
    });
  } finally {
    cleanup();
  }
});

test("a hard-linked file is counted once, where it is found first (files before sub-folders)", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    const video = path.join(dir, "ep");
    write(path.join(video, "CLAUDE_VE/clip.bin"), Buffer.alloc(100));
    fs.linkSync(path.join(video, "CLAUDE_VE/clip.bin"), path.join(video, "copy.bin"));
    fs.linkSync(path.join(video, "CLAUDE_VE/clip.bin"), path.join(video, "CLAUDE_VE/again.bin"));
    write(path.join(video, "plain.bin"), Buffer.alloc(7));
    const sizes = await measureVideoFolder(video, "ep");
    assert.deepEqual(sizes, { working: 0, project: 0, finals: 0, sources: 107, total: 107 });
  } finally {
    cleanup();
  }
});

test("a folder that cannot be read is skipped", { skip: !canRestrict }, async () => {
  const { dir, cleanup } = tempFolder();
  const locked = path.join(dir, "ep", "locked");
  try {
    write(path.join(dir, "ep", "a.bin"), Buffer.alloc(10));
    write(path.join(locked, "b.bin"), Buffer.alloc(99));
    fs.chmodSync(locked, 0o000);
    const sizes = await measureVideoFolder(path.join(dir, "ep"), "ep");
    assert.equal(sizes?.total, 10);
  } finally {
    fs.chmodSync(locked, 0o755);
    cleanup();
  }
});

test("a cancelled measurement answers null", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    const video = path.join(dir, "ep");
    layoutVideo(video);
    const control = new AbortController();
    control.abort();
    assert.equal(await measureVideoFolder(video, "ep", control.signal), null);
    assert.equal(await fingerprintVideoFolder(video, control.signal), null);
  } finally {
    cleanup();
  }
});

test("the fingerprint is stable until something in the first two levels changes", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    const video = path.join(dir, "ep");
    layoutVideo(video);
    const first = await fingerprintVideoFolder(video);
    assert.equal(typeof first, "string");
    assert.equal(await fingerprintVideoFolder(video), first);

    // A new file in the working folder (level 2).
    write(path.join(video, "CLAUDE_VE/new.bin"), "x");
    const second = await fingerprintVideoFolder(video);
    assert.notEqual(second, first);

    // A file written in a folder of the working folder: that folder's time moves (level 3).
    write(path.join(video, "CLAUDE_VE/frames/f2.png"), "x");
    const third = await fingerprintVideoFolder(video);
    assert.notEqual(third, second);

    // A file that grows at level 2 keeps its name but changes its size.
    fs.appendFileSync(path.join(video, "CLAUDE_VE/scratch.bin"), "more");
    const fourth = await fingerprintVideoFolder(video);
    assert.notEqual(fourth, third);

    // A new file in the video folder itself (level 1).
    write(path.join(video, "extra.txt"), "x");
    assert.notEqual(await fingerprintVideoFolder(video), fourth);
  } finally {
    cleanup();
  }
});

test("a change deeper than that is not seen by the fingerprint (the cache's maximum age catches it)", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    const video = path.join(dir, "ep");
    write(path.join(video, "CLAUDE_VE/a/b/deep.bin"), "x");
    const first = await fingerprintVideoFolder(video);
    fs.appendFileSync(path.join(video, "CLAUDE_VE/a/b/deep.bin"), "yyyy");
    assert.equal(await fingerprintVideoFolder(video), first);
  } finally {
    cleanup();
  }
});

test("a vanished video folder fingerprints without throwing", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    assert.equal(typeof (await fingerprintVideoFolder(path.join(dir, "gone"))), "string");
  } finally {
    cleanup();
  }
});

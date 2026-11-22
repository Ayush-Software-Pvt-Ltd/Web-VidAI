import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkedWorkingFolder, cleanWorkingFolder } from "../../src/disk/clean.js";
import { tempFolder } from "../library/support.js";
import { canRestrict, layoutVideo, rejectsCode, tree, write } from "./support.js";

test("everything inside CLAUDE_VE goes, the empty folder stays, the rest is untouched", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    const video = path.join(dir, "ep");
    layoutVideo(video);
    const before = tree(video).filter((entry) => !entry.startsWith("CLAUDE_VE"));
    const result = await cleanWorkingFolder(video);
    assert.deepEqual(result, { freedBytes: 340, leftover: 0 });
    assert.deepEqual(fs.readdirSync(path.join(video, "CLAUDE_VE")), []);
    assert.deepEqual(
      tree(video).filter((entry) => !entry.startsWith("CLAUDE_VE")),
      before,
    );
  } finally {
    cleanup();
  }
});

test("an already empty working folder frees nothing and is fine", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    fs.mkdirSync(path.join(dir, "ep/CLAUDE_VE"), { recursive: true });
    assert.deepEqual(await cleanWorkingFolder(path.join(dir, "ep")), {
      freedBytes: 0,
      leftover: 0,
    });
  } finally {
    cleanup();
  }
});

test("no working folder: there are no working files to delete", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    fs.mkdirSync(path.join(dir, "ep"));
    const error = await rejectsCode(cleanWorkingFolder(path.join(dir, "ep")), "conflict");
    assert.equal(error.message, "There are no working files to delete.");
  } finally {
    cleanup();
  }
});

test("a file named CLAUDE_VE is refused", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    write(path.join(dir, "ep/CLAUDE_VE"), "x");
    await rejectsCode(cleanWorkingFolder(path.join(dir, "ep")), "conflict");
    assert.equal(fs.readFileSync(path.join(dir, "ep/CLAUDE_VE"), "utf8"), "x");
  } finally {
    cleanup();
  }
});

test("hostile: CLAUDE_VE is a link to the video's sources (or anywhere): refused, nothing deleted", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    const video = path.join(dir, "ep");
    const precious = path.join(dir, "elsewhere");
    write(path.join(precious, "keep.txt"), "keep");
    write(path.join(video, "a-roll.mp4"), "video");
    write(path.join(video, "Broll/b.mp4"), "b");
    for (const target of [precious, path.join(video, "Broll"), video, dir]) {
      fs.rmSync(path.join(video, "CLAUDE_VE"), { force: true });
      fs.symlinkSync(target, path.join(video, "CLAUDE_VE"));
      const error = await rejectsCode(cleanWorkingFolder(video), "conflict");
      assert.match(error.message, /link/);
    }
    assert.equal(fs.readFileSync(path.join(precious, "keep.txt"), "utf8"), "keep");
    assert.equal(fs.readFileSync(path.join(video, "Broll/b.mp4"), "utf8"), "b");
    assert.equal(fs.readFileSync(path.join(video, "a-roll.mp4"), "utf8"), "video");
  } finally {
    cleanup();
  }
});

test("hostile: a link to nowhere named CLAUDE_VE is refused", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    fs.mkdirSync(path.join(dir, "ep"));
    fs.symlinkSync(path.join(dir, "missing"), path.join(dir, "ep/CLAUDE_VE"));
    await rejectsCode(cleanWorkingFolder(path.join(dir, "ep")), "conflict");
  } finally {
    cleanup();
  }
});

test("hostile: the video folder reached through a link still only empties its own CLAUDE_VE", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    const real = path.join(dir, "real-ep");
    write(path.join(real, "CLAUDE_VE/x.bin"), Buffer.alloc(5));
    write(path.join(real, "keep.mp4"), "k");
    const alias = path.join(dir, "alias");
    fs.symlinkSync(real, alias);
    // `checkedWorkingFolder` compares real paths, so an alias for the video folder is fine ...
    assert.equal(await checkedWorkingFolder(alias), path.join(real, "CLAUDE_VE"));
    assert.deepEqual(await cleanWorkingFolder(alias), { freedBytes: 5, leftover: 0 });
    assert.equal(fs.readFileSync(path.join(real, "keep.mp4"), "utf8"), "k");
  } finally {
    cleanup();
  }
});

test("hostile: links inside are removed, their targets are untouched", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    const video = path.join(dir, "ep");
    const sources = path.join(video, "Broll");
    write(path.join(sources, "b.mp4"), "b");
    write(path.join(video, "a-roll.mp4"), "video");
    const outside = path.join(dir, "outside");
    write(path.join(outside, "keep.txt"), "keep");
    write(path.join(video, "CLAUDE_VE/real.bin"), Buffer.alloc(11));
    fs.symlinkSync(sources, path.join(video, "CLAUDE_VE/to-broll"));
    fs.symlinkSync(video, path.join(video, "CLAUDE_VE/to-video"));
    fs.symlinkSync(outside, path.join(video, "CLAUDE_VE/nested-dir-link"));
    fs.symlinkSync(path.join(video, "a-roll.mp4"), path.join(video, "CLAUDE_VE/to-file"));
    fs.mkdirSync(path.join(video, "CLAUDE_VE/sub"));
    fs.symlinkSync(outside, path.join(video, "CLAUDE_VE/sub/up"));
    fs.symlinkSync(path.join(dir, "gone"), path.join(video, "CLAUDE_VE/broken"));
    const result = await cleanWorkingFolder(video);
    assert.deepEqual(result, { freedBytes: 11, leftover: 0 });
    assert.deepEqual(fs.readdirSync(path.join(video, "CLAUDE_VE")), []);
    assert.equal(fs.readFileSync(path.join(sources, "b.mp4"), "utf8"), "b");
    assert.equal(fs.readFileSync(path.join(video, "a-roll.mp4"), "utf8"), "video");
    assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep");
  } finally {
    cleanup();
  }
});

test("a hard-linked file frees its bytes only when the last link is gone", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    const video = path.join(dir, "ep");
    write(path.join(video, "CLAUDE_VE/a.bin"), Buffer.alloc(100));
    fs.linkSync(path.join(video, "CLAUDE_VE/a.bin"), path.join(video, "CLAUDE_VE/b.bin"));
    write(path.join(video, "CLAUDE_VE/c.bin"), Buffer.alloc(30));
    fs.linkSync(path.join(video, "CLAUDE_VE/c.bin"), path.join(video, "kept-copy.bin"));
    const result = await cleanWorkingFolder(video);
    // Both links of a.bin were inside (100 freed once); c.bin still has a copy outside.
    assert.deepEqual(result, { freedBytes: 100, leftover: 0 });
    assert.equal(fs.statSync(path.join(video, "kept-copy.bin")).size, 30);
  } finally {
    cleanup();
  }
});

test(
  "a file that cannot be removed is counted and the rest goes on",
  { skip: !canRestrict },
  async () => {
    const { dir, cleanup } = tempFolder();
    const locked = path.join(dir, "ep/CLAUDE_VE/locked");
    try {
      const video = path.join(dir, "ep");
      write(path.join(video, "CLAUDE_VE/a.bin"), Buffer.alloc(10));
      write(path.join(video, "CLAUDE_VE/z.bin"), Buffer.alloc(20));
      write(path.join(locked, "stuck1.bin"), Buffer.alloc(3));
      write(path.join(locked, "stuck2.bin"), Buffer.alloc(4));
      write(path.join(video, "CLAUDE_VE/free/f.bin"), Buffer.alloc(5));
      // A folder without write permission: its entries cannot be unlinked.
      fs.chmodSync(locked, 0o555);
      const result = await cleanWorkingFolder(video);
      assert.deepEqual(result, { freedBytes: 35, leftover: 2 });
      assert.deepEqual(tree(path.join(video, "CLAUDE_VE")), [
        "locked",
        "locked/stuck1.bin",
        "locked/stuck2.bin",
      ]);
    } finally {
      fs.chmodSync(locked, 0o755);
      cleanup();
    }
  },
);

test("a folder that cannot be read counts as one leftover", { skip: !canRestrict }, async () => {
  const { dir, cleanup } = tempFolder();
  const locked = path.join(dir, "ep/CLAUDE_VE/locked");
  try {
    write(path.join(dir, "ep/CLAUDE_VE/a.bin"), Buffer.alloc(10));
    write(path.join(locked, "x.bin"), Buffer.alloc(3));
    fs.chmodSync(locked, 0o000);
    assert.deepEqual(await cleanWorkingFolder(path.join(dir, "ep")), {
      freedBytes: 10,
      leftover: 1,
    });
  } finally {
    fs.chmodSync(locked, 0o755);
    cleanup();
  }
});

test("deleting a deep tree works", async () => {
  const { dir, cleanup } = tempFolder();
  try {
    const video = path.join(dir, "ep");
    let deep = path.join(video, "CLAUDE_VE");
    for (let level = 0; level < 30; level++) deep = path.join(deep, `d${level}`);
    write(path.join(deep, "leaf.bin"), Buffer.alloc(9));
    assert.deepEqual(await cleanWorkingFolder(video), { freedBytes: 9, leftover: 0 });
    assert.deepEqual(fs.readdirSync(path.join(video, "CLAUDE_VE")), []);
  } finally {
    cleanup();
  }
});

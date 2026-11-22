import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { emptyOutput, scanOutput, workingFolderHasFiles } from "../../src/library/outputs.js";
import { tempFolder, touch, write } from "./support.js";

/** A channel directory with one video folder named "v". */
function setup() {
  const channel = tempFolder();
  const video = path.join(channel.dir, "v");
  fs.mkdirSync(video);
  return { channel, video, root: channel.dir, cleanup: channel.cleanup };
}

test("a video with no output folder has an empty output", async () => {
  const w = setup();
  try {
    assert.deepEqual(await scanOutput(w.video, "v", w.root), emptyOutput());
  } finally {
    w.cleanup();
  }
});

test("the project is output/<folder>.hf/index.html", async () => {
  const w = setup();
  try {
    const index = write(path.join(w.video, "output", "v.hf", "index.html"));
    touch(index, 1_600_000_000_000);
    const output = await scanOutput(w.video, "v", w.root);
    assert.deepEqual(output.project, {
      path: "output/v.hf/index.html",
      modifiedAt: 1_600_000_000_000,
    });
  } finally {
    w.cleanup();
  }
});

test("a .hf folder without index.html is not the project", async () => {
  const w = setup();
  try {
    write(path.join(w.video, "output", "v.hf", "other.html"));
    assert.equal((await scanOutput(w.video, "v", w.root)).project, null);
  } finally {
    w.cleanup();
  }
});

test("a project folder with another name is not the project", async () => {
  const w = setup();
  try {
    write(path.join(w.video, "output", "other.hf", "index.html"));
    write(path.join(w.video, "output", "V.hf", "index.html"));
    // On a case-insensitive disk "V.hf" and "v.hf" differ only in case; the name must match.
    const output = await scanOutput(w.video, "v", w.root);
    assert.equal(output.project, null);
  } finally {
    w.cleanup();
  }
});

test("index.html must be a file, not a folder", async () => {
  const w = setup();
  try {
    fs.mkdirSync(path.join(w.video, "output", "v.hf", "index.html"), { recursive: true });
    assert.equal((await scanOutput(w.video, "v", w.root)).project, null);
  } finally {
    w.cleanup();
  }
});

test("finals are mp4, mov and m4v in natural order; the newest is named", async () => {
  const w = setup();
  try {
    const out = path.join(w.video, "output");
    touch(write(path.join(out, "final10.mp4"), "aaa"), 3000);
    touch(write(path.join(out, "final2.mov"), "bb"), 9000);
    touch(write(path.join(out, "final1.m4v"), "c"), 1000);
    write(path.join(out, "final.mkv"));
    write(path.join(out, "final.txt"));
    const output = await scanOutput(w.video, "v", w.root);
    assert.deepEqual(
      output.finals.map((f) => f.name),
      ["final1.m4v", "final2.mov", "final10.mp4"],
    );
    assert.deepEqual(output.finals[2], {
      name: "final10.mp4",
      path: "output/final10.mp4",
      size: 3,
      modifiedAt: 3000,
    });
    assert.equal(output.newestFinal, "final2.mov");
  } finally {
    w.cleanup();
  }
});

test("equal times: the last final in natural order is the newest", async () => {
  const w = setup();
  try {
    const out = path.join(w.video, "output");
    touch(write(path.join(out, "a.mp4")), 5000);
    touch(write(path.join(out, "b.mp4")), 5000);
    assert.equal((await scanOutput(w.video, "v", w.root)).newestFinal, "b.mp4");
  } finally {
    w.cleanup();
  }
});

test("hidden files and part files are ignored", async () => {
  const w = setup();
  try {
    const out = path.join(w.video, "output");
    write(path.join(out, ".final.mp4"));
    write(path.join(out, "final.mp4.part"));
    write(path.join(out, "final.mp4.tmp"));
    write(path.join(out, ".thumbnail-1.png"));
    write(path.join(out, ".meta.txt"));
    const output = await scanOutput(w.video, "v", w.root);
    assert.deepEqual(output.finals, []);
    assert.deepEqual(output.thumbnails, []);
    assert.equal(output.metaFile, null);
    assert.equal(output.newestFinal, null);
  } finally {
    w.cleanup();
  }
});

test("thumbnails, meta.txt and info.txt", async () => {
  const w = setup();
  try {
    const out = path.join(w.video, "output");
    write(path.join(out, "thumbnail-10.png"));
    write(path.join(out, "thumbnail-2.JPG"));
    write(path.join(out, "thumbnail-3.jpeg"));
    write(path.join(out, "Thumbnail-1.png"));
    write(path.join(out, "thumb-1.png"));
    write(path.join(out, "thumbnail-4.gif"));
    write(path.join(out, "Meta.TXT"));
    write(path.join(w.video, "info.txt"));
    const output = await scanOutput(w.video, "v", w.root);
    assert.deepEqual(
      output.thumbnails.map((t) => t.name),
      ["Thumbnail-1.png", "thumbnail-2.JPG", "thumbnail-3.jpeg", "thumbnail-10.png"],
    );
    assert.equal(output.metaFile, "output/Meta.TXT");
    assert.equal(output.infoFile, "info.txt");
  } finally {
    w.cleanup();
  }
});

test("directories named like finals are not finals", async () => {
  const w = setup();
  try {
    fs.mkdirSync(path.join(w.video, "output", "folder.mp4"), { recursive: true });
    assert.deepEqual((await scanOutput(w.video, "v", w.root)).finals, []);
  } finally {
    w.cleanup();
  }
});

test("links leading out of the channel directory are not followed", async () => {
  const w = setup();
  const outside = tempFolder();
  try {
    const out = path.join(w.video, "output");
    fs.mkdirSync(out);
    // A final that is a link to a file outside.
    const target = write(path.join(outside.dir, "secret.mp4"), "secret");
    fs.symlinkSync(target, path.join(out, "linked.mp4"));
    // A project folder that is a link to a folder outside.
    write(path.join(outside.dir, "proj", "index.html"));
    fs.symlinkSync(path.join(outside.dir, "proj"), path.join(out, "v.hf"));
    // The whole output folder as a link is not followed either.
    const w2video = path.join(w.root, "w");
    fs.mkdirSync(w2video);
    write(path.join(outside.dir, "out2", "final.mp4"));
    fs.symlinkSync(path.join(outside.dir, "out2"), path.join(w2video, "output"));

    const output = await scanOutput(w.video, "v", w.root);
    assert.deepEqual(output.finals, []);
    assert.equal(output.project, null);
    const other = await scanOutput(w2video, "w", w.root);
    assert.deepEqual(other, emptyOutput());
  } finally {
    w.cleanup();
    outside.cleanup();
  }
});

test("links that stay inside the channel directory are followed", async () => {
  const w = setup();
  try {
    const out = path.join(w.video, "output");
    const real = write(path.join(w.root, "shared", "final.mp4"), "abcd");
    fs.mkdirSync(out);
    fs.symlinkSync(real, path.join(out, "linked.mp4"));
    const output = await scanOutput(w.video, "v", w.root);
    assert.deepEqual(
      output.finals.map((f) => [f.name, f.size]),
      [["linked.mp4", 4]],
    );
  } finally {
    w.cleanup();
  }
});

test("workingFolderHasFiles: empty, with a file, a link out, and the entry limit", async () => {
  const w = setup();
  const outside = tempFolder();
  try {
    assert.equal(await workingFolderHasFiles(w.video), false);
    fs.mkdirSync(path.join(w.video, "CLAUDE_VE", "a", "b"), { recursive: true });
    assert.equal(await workingFolderHasFiles(w.video), false);
    write(path.join(w.video, "CLAUDE_VE", "a", "b", "f.txt"));
    assert.equal(await workingFolderHasFiles(w.video), true);

    const other = path.join(w.root, "o");
    fs.mkdirSync(other);
    write(path.join(outside.dir, "f.txt"));
    fs.symlinkSync(outside.dir, path.join(other, "CLAUDE_VE"));
    assert.equal(await workingFolderHasFiles(other), false);

    // Many empty folders and no file: the limit ends the walk with "no files".
    const deep = path.join(w.root, "d");
    for (let i = 0; i < 20; i += 1)
      fs.mkdirSync(path.join(deep, "CLAUDE_VE", `d${i}`), { recursive: true });
    assert.equal(await workingFolderHasFiles(deep, { limit: 5 }), false);
  } finally {
    w.cleanup();
    outside.cleanup();
  }
});

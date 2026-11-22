import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createNoteFolders } from "../../src/timeline/noteFolders.js";
import { guardFolder } from "../../src/timeline/noteGuard.js";
import { listTree, tempFolder } from "./noteSupport.js";

const id = (/** @type {string} */ c) => c.repeat(32);

function setup() {
  const t = tempFolder("vidai-folders-");
  const noteDir = (/** @type {string} */ videoKey, /** @type {string} */ noteId) =>
    path.join(t.dir, videoKey, "notes", noteId);
  const folders = createNoteFolders({ noteDir });
  const make = (/** @type {string} */ videoKey, /** @type {string} */ noteId) => {
    fs.mkdirSync(noteDir(videoKey, noteId), { recursive: true });
    fs.writeFileSync(path.join(noteDir(videoKey, noteId), "frame.png"), "x");
  };
  return { ...t, folders, make, noteDir };
}

test("removeFor deletes the folder of one request and only that", async () => {
  const t = setup();
  try {
    t.make("video", id("a"));
    t.make("video", id("b"));
    await t.folders.removeFor("video", id("a"));
    assert.equal(fs.existsSync(t.noteDir("video", id("a"))), false);
    assert.equal(fs.existsSync(t.noteDir("video", id("b"))), true);
    // Not there, and not a note id: nothing happens.
    await t.folders.removeFor("video", id("a"));
    await t.folders.removeFor("video", "..");
    assert.equal(fs.existsSync(path.join(t.dir, "video")), true);
  } finally {
    t.cleanup();
  }
});

test("sweep deletes every request folder of the video except the ones kept", async () => {
  const t = setup();
  try {
    t.make("video", id("a"));
    t.make("video", id("b"));
    t.make("video", id("c"));
    t.make("other", id("a"));
    fs.writeFileSync(path.join(t.dir, "video", "notes", "readme.txt"), "keep");
    fs.mkdirSync(path.join(t.dir, "video", "notes", "not-a-note-id"));
    const removed = await t.folders.sweep("video", [id("b")]);
    assert.deepEqual(removed, [id("a"), id("c")]);
    assert.deepEqual(
      listTree(path.join(t.dir, "video", "notes")),
      [id("b"), `${id("b")}/frame.png`, "not-a-note-id", "readme.txt"].sort(),
    );
    assert.equal(fs.existsSync(t.noteDir("other", id("a"))), true);
  } finally {
    t.cleanup();
  }
});

test("sweep of a video without request folders does nothing", async () => {
  const t = setup();
  try {
    assert.deepEqual(await t.folders.sweep("none", []), []);
  } finally {
    t.cleanup();
  }
});

test("the guard deletes what appeared and nothing else", async () => {
  const t = tempFolder("vidai-guard-");
  try {
    fs.mkdirSync(path.join(t.dir, "compositions"));
    fs.writeFileSync(path.join(t.dir, "index.html"), "a");
    fs.writeFileSync(path.join(t.dir, "compositions", "g.html"), "b");
    fs.symlinkSync("/nonexistent-target", path.join(t.dir, "link"));
    const guard = await guardFolder(t.dir);
    fs.mkdirSync(path.join(t.dir, ".hyperframes", "deep"), { recursive: true });
    fs.writeFileSync(path.join(t.dir, ".hyperframes", "deep", "x.json"), "{}");
    fs.writeFileSync(path.join(t.dir, "compositions", "new.html"), "n");
    fs.writeFileSync(path.join(t.dir, "index.html"), "changed");
    const removed = await guard.restore();
    assert.deepEqual(removed, [".hyperframes", "compositions/new.html"]);
    assert.deepEqual(listTree(t.dir), [
      "compositions",
      "compositions/g.html",
      "index.html",
      "link",
    ]);
    // A changed file stays changed: the guard only removes what is new.
    assert.equal(fs.readFileSync(path.join(t.dir, "index.html"), "utf8"), "changed");
  } finally {
    t.cleanup();
  }
});

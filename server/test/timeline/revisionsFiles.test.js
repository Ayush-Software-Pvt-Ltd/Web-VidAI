// The files of a revision: listing, fingerprint, copy, safe write, restore
// (docs/SPEC.md section 11, Revisions; `src/timeline/revisionFiles.js`).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  copyRevisionFiles,
  fingerprint,
  listRevisionFiles,
  restoreRevisionFiles,
  writeFileSafely,
} from "../../src/timeline/revisionFiles.js";

/** @param {(dir: string) => void | Promise<void>} body */
async function inTemp(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-revfiles-"));
  try {
    await body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {string} root @param {Record<string, string>} files */
function put(root, files) {
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(root, ...name.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

/** The names under a folder, for comparing. @param {string} root */
const names = (root) => listRevisionFiles(root);

test("a revision holds index.html, edit.json, transcript.json and compositions/ only", async () => {
  await inTemp(async (dir) => {
    put(dir, {
      "index.html": "a",
      "edit.json": "b",
      "compositions/g-1.html": "c",
      "compositions/deep/g-2.html": "d",
      "assets/media/aroll.mp4": "big",
      "notes.txt": "x",
    });
    assert.deepEqual(await names(dir), [
      "compositions/deep/g-2.html",
      "compositions/g-1.html",
      "edit.json",
      "index.html",
    ]);
    assert.deepEqual(await names(path.join(dir, "nowhere")), []);
  });
});

test("temporary files, links and special entries are never part of a revision", async () => {
  await inTemp(async (dir) => {
    put(dir, {
      "index.html": "a",
      "index.html.vidai-tmp-abcd1234": "half",
      "compositions/g-1.html": "c",
      "compositions/g-1.html.vidai-tmp-00ff00ff": "half",
      "outside/secret.html": "secret",
    });
    try {
      fs.symlinkSync(path.join(dir, "outside", "secret.html"), path.join(dir, "edit.json"));
      fs.symlinkSync(
        path.join(dir, "outside", "secret.html"),
        path.join(dir, "compositions", "link.html"),
      );
    } catch {
      return; // links cannot be made here (Windows without the privilege)
    }
    assert.deepEqual(await names(dir), ["compositions/g-1.html", "index.html"]);
    // A compositions folder that is a link is not followed.
    fs.rmSync(path.join(dir, "compositions"), { recursive: true });
    fs.symlinkSync(path.join(dir, "outside"), path.join(dir, "compositions"));
    assert.deepEqual(await names(dir), ["index.html"]);
  });
});

test("the fingerprint tells equal content from different content", async () => {
  await inTemp(async (dir) => {
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    put(a, { "index.html": "x", "compositions/g.html": "y" });
    put(b, { "index.html": "x", "compositions/g.html": "y", "assets/unrelated.bin": "z" });
    assert.equal(await fingerprint(a), await fingerprint(b));
    assert.match(await fingerprint(a), /^[0-9a-f]{64}$/);
    fs.writeFileSync(path.join(b, "compositions", "g.html"), "changed");
    assert.notEqual(await fingerprint(a), await fingerprint(b));
    // The same bytes under another name are different content.
    const c = path.join(dir, "c");
    put(c, { "index.html": "x", "compositions/h.html": "y" });
    assert.notEqual(await fingerprint(a), await fingerprint(c));
    assert.equal(
      await fingerprint(path.join(dir, "empty")),
      await fingerprint(path.join(dir, "empty2")),
    );
  });
});

test("copyRevisionFiles copies the held files into a new folder", async () => {
  await inTemp(async (dir) => {
    const from = path.join(dir, "p");
    put(from, { "index.html": "x", "compositions/g.html": "y", "assets/skip.bin": "z" });
    const to = path.join(dir, "r", "1");
    await copyRevisionFiles(from, to);
    assert.deepEqual(await names(to), ["compositions/g.html", "index.html"]);
    assert.equal(fs.readFileSync(path.join(to, "compositions", "g.html"), "utf8"), "y");
    assert.equal(fs.existsSync(path.join(to, "assets")), false);
  });
});

test("writeFileSafely replaces the file and leaves no temporary file", async () => {
  await inTemp(async (dir) => {
    const file = path.join(dir, "index.html");
    fs.writeFileSync(file, "old");
    await writeFileSafely(file, "new");
    assert.equal(fs.readFileSync(file, "utf8"), "new");
    await writeFileSafely(path.join(dir, "fresh.html"), Buffer.from("bytes"));
    assert.equal(fs.readFileSync(path.join(dir, "fresh.html"), "utf8"), "bytes");
    assert.deepEqual(fs.readdirSync(dir).sort(), ["fresh.html", "index.html"]);
  });
});

test("a failed safe write keeps the original and removes its temporary file", async () => {
  await inTemp(async (dir) => {
    const file = path.join(dir, "index.html");
    fs.writeFileSync(file, "old");
    // The target is a folder: the final rename must fail after the temporary file was written.
    const folder = path.join(dir, "taken.html");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "inside"), "keep");
    await assert.rejects(writeFileSafely(folder, "new"));
    assert.equal(fs.readFileSync(file, "utf8"), "old");
    assert.deepEqual(fs.readdirSync(dir).sort(), ["index.html", "taken.html"]);
    assert.equal(fs.readFileSync(path.join(folder, "inside"), "utf8"), "keep");
    // A missing folder fails at the start, with nothing left behind.
    await assert.rejects(writeFileSafely(path.join(dir, "no", "such", "index.html"), "x"));
    assert.deepEqual(fs.readdirSync(dir).sort(), ["index.html", "taken.html"]);
  });
});

test("a link at the target is replaced by a regular file, never written through", async () => {
  await inTemp(async (dir) => {
    const outside = path.join(dir, "outside.txt");
    fs.writeFileSync(outside, "untouched");
    const file = path.join(dir, "index.html");
    try {
      fs.symlinkSync(outside, file);
    } catch {
      return;
    }
    await writeFileSafely(file, "written");
    assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(file, "utf8"), "written");
  });
});

test("restore puts the revision's files back, drops extra graphics and keeps other files", async () => {
  await inTemp(async (dir) => {
    const revision = path.join(dir, "rev");
    const project = path.join(dir, "project");
    put(revision, { "index.html": "OLD", "compositions/g-1.html": "g1" });
    put(project, {
      "index.html": "NEW",
      "compositions/g-1.html": "changed",
      "compositions/g-2.html": "added since",
      "transcript.json": "kept",
      "assets/media/aroll.mp4": "kept too",
    });
    await restoreRevisionFiles(revision, project);
    assert.equal(fs.readFileSync(path.join(project, "index.html"), "utf8"), "OLD");
    assert.equal(fs.readFileSync(path.join(project, "compositions", "g-1.html"), "utf8"), "g1");
    assert.equal(fs.existsSync(path.join(project, "compositions", "g-2.html")), false);
    // A top-level file the revision lacks, and media, stay.
    assert.equal(fs.readFileSync(path.join(project, "transcript.json"), "utf8"), "kept");
    assert.equal(
      fs.readFileSync(path.join(project, "assets", "media", "aroll.mp4"), "utf8"),
      "kept too",
    );
    assert.deepEqual(fs.readdirSync(project).sort(), [
      "assets",
      "compositions",
      "index.html",
      "transcript.json",
    ]);
    assert.equal((await fingerprint(revision)) === (await fingerprint(project)), false); // transcript only in project
  });
});

test("restore creates missing folders and replaces a compositions link", async () => {
  await inTemp(async (dir) => {
    const revision = path.join(dir, "rev");
    const project = path.join(dir, "project");
    put(revision, { "index.html": "OLD", "compositions/g-1.html": "g1" });
    put(project, { "index.html": "NEW" });
    await restoreRevisionFiles(revision, project);
    assert.equal(fs.readFileSync(path.join(project, "compositions", "g-1.html"), "utf8"), "g1");

    const elsewhere = path.join(dir, "elsewhere");
    put(elsewhere, { "g-9.html": "outside" });
    fs.rmSync(path.join(project, "compositions"), { recursive: true });
    try {
      fs.symlinkSync(elsewhere, path.join(project, "compositions"));
    } catch {
      return;
    }
    await restoreRevisionFiles(revision, project);
    assert.equal(fs.lstatSync(path.join(project, "compositions")).isSymbolicLink(), false);
    assert.deepEqual(fs.readdirSync(path.join(project, "compositions")), ["g-1.html"]);
    assert.deepEqual(fs.readdirSync(elsewhere), ["g-9.html"]); // never written through
  });
});

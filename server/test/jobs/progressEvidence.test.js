// Evidence from the output folder: the pure rules and the real disk probe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiskProbe, emptyProbe, outputEvidence } from "../../src/jobs/progressEvidence.js";

const SINCE = 1_000_000;

/** @param {Partial<import("../../src/jobs/progressEvidence.js").OutputProbe>} parts */
const probe = (parts) => ({ ...emptyProbe(), ...parts });

test("nothing in the output folder is no evidence", () => {
  assert.deepEqual(outputEvidence(emptyProbe(), { kind: "edit", since: SINCE }), {
    project: false,
    thumbnails: false,
    meta: false,
  });
});

test("an edit's project counts when index.html exists", () => {
  const p = probe({ projectExists: true, projectModifiedAt: SINCE + 5000 });
  assert.equal(outputEvidence(p, { kind: "edit", since: SINCE }).project, true);
  // Without a known probe an edit's project counts whatever its time.
  const old = probe({ projectExists: true, projectModifiedAt: SINCE - 60_000 });
  assert.equal(outputEvidence(old, { kind: "edit", since: SINCE }).project, true);
});

test("a project that was there, unchanged, when the run started is not this job's", () => {
  const known = probe({ projectExists: true, projectModifiedAt: SINCE - 60_000 });
  for (const kind of /** @type {const} */ (["edit", "reEdit", "timelineEdit"])) {
    assert.equal(outputEvidence(known, { kind, since: SINCE, known }).project, false, kind);
  }
  const rewritten = probe({ projectExists: true, projectModifiedAt: SINCE + 20_000 });
  for (const kind of /** @type {const} */ (["edit", "reEdit", "timelineEdit"])) {
    assert.equal(outputEvidence(rewritten, { kind, since: SINCE, known }).project, true, kind);
  }
});

test("a re-edit and a timeline edit need the project modified after the job started", () => {
  const stale = probe({ projectExists: true, projectModifiedAt: SINCE - 60_000 });
  const fresh = probe({ projectExists: true, projectModifiedAt: SINCE + 1 });
  for (const kind of /** @type {const} */ (["reEdit", "timelineEdit"])) {
    assert.equal(outputEvidence(stale, { kind, since: SINCE }).project, false, kind);
    assert.equal(outputEvidence(fresh, { kind, since: SINCE }).project, true, kind);
  }
  // A project without a time (it vanished between two looks) is nothing.
  const none = probe({ projectExists: true, projectModifiedAt: null });
  assert.equal(outputEvidence(none, { kind: "reEdit", since: SINCE }).project, false);
  assert.equal(
    outputEvidence(probe({ projectModifiedAt: SINCE + 1 }), { kind: "edit", since: SINCE }).project,
    false,
  );
});

test("a second of tolerance for file systems with whole seconds", () => {
  const within = probe({ projectExists: true, projectModifiedAt: SINCE - 900 });
  const outside = probe({ projectExists: true, projectModifiedAt: SINCE - 1100 });
  assert.equal(outputEvidence(within, { kind: "reEdit", since: SINCE }).project, true);
  assert.equal(outputEvidence(outside, { kind: "reEdit", since: SINCE }).project, false);
});

test("thumbnails and meta.txt count when written since the job started and changed since the run", () => {
  const p = probe({ thumbnailsModifiedAt: SINCE + 10, metaModifiedAt: SINCE + 20 });
  assert.deepEqual(outputEvidence(p, { kind: "edit", since: SINCE }), {
    project: false,
    thumbnails: true,
    meta: true,
  });
  const old = probe({ thumbnailsModifiedAt: SINCE - 5000, metaModifiedAt: SINCE + 20 });
  const e = outputEvidence(old, { kind: "edit", since: SINCE });
  assert.equal(e.thumbnails, false);
  assert.equal(e.meta, true);
  // Unchanged since the run started (a continued job saw them already): not new.
  const known = probe({ thumbnailsModifiedAt: SINCE + 10, metaModifiedAt: SINCE + 20 });
  assert.deepEqual(outputEvidence(known, { kind: "edit", since: SINCE, known }), {
    project: false,
    thumbnails: false,
    meta: false,
  });
});

test("the disk probe looks at the project folder, thumbnails and meta.txt", () => {
  const root = mkdtempSync(join(tmpdir(), "vidai-progress-"));
  try {
    const video = join(root, "018 Hair Oil");
    mkdirSync(video);
    const look = createDiskProbe(video);
    assert.deepEqual(look(), emptyProbe());
    const output = join(video, "output");
    mkdirSync(join(output, "018 Hair Oil.hf"), { recursive: true });
    // The folder alone is no project: index.html is.
    assert.equal(look().projectExists, false);
    writeFileSync(join(output, "018 Hair Oil.hf", "index.html"), "<html></html>");
    // Another folder's index.html and a hidden thumbnail do not count.
    mkdirSync(join(output, "other.hf"));
    writeFileSync(join(output, "other.hf", "index.html"), "x");
    writeFileSync(join(output, ".thumbnail-1.png"), "x");
    writeFileSync(join(output, "thumbnail-notes.txt"), "x");
    let seen = look();
    assert.equal(seen.projectExists, true);
    assert.ok(typeof seen.projectModifiedAt === "number" && seen.projectModifiedAt > 0);
    assert.equal(seen.thumbnailsModifiedAt, null);
    assert.equal(seen.metaModifiedAt, null);
    writeFileSync(join(output, "thumbnail-1.png"), "x");
    writeFileSync(join(output, "thumbnail-2.JPG"), "x");
    writeFileSync(join(output, "Meta.txt"), "x");
    const newer = new Date(Date.now() + 60_000);
    utimesSync(join(output, "thumbnail-2.JPG"), newer, newer);
    seen = look();
    // The newest thumbnail wins (file systems round the time a little).
    assert.ok(Math.abs((seen.thumbnailsModifiedAt ?? 0) - newer.getTime()) < 2000);
    assert.ok(typeof seen.metaModifiedAt === "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

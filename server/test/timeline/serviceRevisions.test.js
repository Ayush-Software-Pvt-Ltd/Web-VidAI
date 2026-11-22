// Revisions through the service: undo, redo, restore, jobs in between, pruning
// (docs/SPEC.md section 11, Revisions; the rules are at the head of `src/timeline/revisions.js`).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createTimelineWorld, del, hasClip, readIndex, rejectsCode } from "./serviceSupport.js";

/**
 * A video whose timeline was read once, with short helpers.
 * @param {ReturnType<typeof createTimelineWorld>} w
 */
async function opened(w) {
  const v = await w.videoOf(w.alice);
  const get = () => w.call(w.alice, "getTimeline", { videoId: v.videoId });
  /** @param {number} revision @param {string} clip */
  const edit = (revision, clip) =>
    w.call(w.alice, "editTimeline", { videoId: v.videoId, revision, op: del(clip) });
  const undo = () => w.call(w.alice, "undoTimeline", { videoId: v.videoId });
  const redo = () => w.call(w.alice, "redoTimeline", { videoId: v.videoId });
  const list = () => w.call(w.alice, "listRevisions", { videoId: v.videoId });
  await get();
  return { v, get, edit, undo, redo, list };
}

/** @param {string} projectDir @param {string} id */
const has = (projectDir, id) => hasClip(readIndex(projectDir), id);

test("undo and redo step through the hand edits and put the files back", async () => {
  const w = createTimelineWorld();
  try {
    const { v, edit, undo, redo, get } = await opened(w);
    const original = readIndex(v.projectDir);
    await edit(1, "b-3"); // revision 2
    const t3 = await edit(2, "s-1"); // revision 3
    assert.deepEqual([t3.revision, t3.canUndo, t3.canRedo], [3, true, false]);
    const afterBoth = readIndex(v.projectDir);

    const u1 = await undo();
    assert.deepEqual([u1.revision, u1.canUndo, u1.canRedo], [2, true, true]);
    assert.ok(has(v.projectDir, "s-1") && !has(v.projectDir, "b-3"));
    const u2 = await undo();
    assert.deepEqual([u2.revision, u2.canUndo, u2.canRedo], [1, false, true]);
    assert.equal(readIndex(v.projectDir), original);
    const err = await rejectsCode(undo(), "conflict");
    assert.match(err.message, /nothing to undo/);

    const r1 = await redo();
    assert.deepEqual([r1.revision, r1.canUndo, r1.canRedo], [2, true, true]);
    const r2 = await redo();
    assert.deepEqual([r2.revision, r2.canUndo, r2.canRedo], [3, true, false]);
    assert.equal(readIndex(v.projectDir), afterBoth);
    await rejectsCode(redo(), "conflict");
    // Undo and redo make no new revisions; the list shows the undone ones greyed.
    assert.equal((await get()).revision, 3);
    assert.equal(w.timeline.api.latestRevision(v.key)?.n, 3);
  } finally {
    w.cleanup();
  }
});

test("the list marks the current and the undone revisions", async () => {
  const w = createTimelineWorld();
  try {
    const { edit, undo, list } = await opened(w);
    await edit(1, "b-3");
    await edit(2, "s-1");
    await undo();
    assert.deepEqual(
      (await list()).map((/** @type {any} */ r) => [r.n, r.current, r.undone]),
      [
        [3, false, true],
        [2, true, false],
        [1, false, false],
      ],
    );
  } finally {
    w.cleanup();
  }
});

test("a new edit after an undo drops the undone revisions and never reuses their numbers", async () => {
  const w = createTimelineWorld();
  try {
    const { v, edit, undo, redo, list } = await opened(w);
    await edit(1, "b-3"); // 2
    await edit(2, "s-1"); // 3
    await undo(); // at 2
    const folder3 = path.join(w.dataDir, "projects", v.key, "revisions", "3");
    assert.ok(fs.existsSync(folder3));
    const t = await edit(2, "s-2");
    assert.deepEqual([t.revision, t.canUndo, t.canRedo], [4, true, false]);
    assert.deepEqual(
      (await list()).map((/** @type {any} */ r) => r.n),
      [4, 2, 1],
    );
    assert.equal(fs.existsSync(folder3), false, "the dropped revision's folder is gone");
    await rejectsCode(redo(), "conflict");
    // A page that still holds the dropped number 3 is stale.
    await rejectsCode(edit(3, "s-3"), "conflict");
    assert.ok(has(v.projectDir, "s-1"), "the undone delete did not come back");
    assert.ok(!has(v.projectDir, "s-2"));
    // The new edit can be undone back to revision 2.
    const u = await undo();
    assert.equal(u.revision, 2);
  } finally {
    w.cleanup();
  }
});

test("a job's revision ends the undo history; a restore after an undo drops the undone ones", async () => {
  const w = createTimelineWorld();
  try {
    const { v, edit, undo, redo, list, get } = await opened(w);
    await edit(1, "b-3"); // 2
    await edit(2, "s-1"); // 3
    const job = w.makeJob(v.key, w.alice, "job-1");
    // The job changes files, then saves its revision.
    fs.appendFileSync(path.join(v.projectDir, "compositions", "g-1.html"), "\n<!-- job -->\n");
    const saved = await w.timeline.api.saveRevision(v.key, {
      label: "Re-Edit",
      userId: null,
      jobId: job,
    });
    assert.equal(saved.n, 4);
    const t = await get();
    assert.deepEqual([t.revision, t.canUndo, t.canRedo], [4, false, false]);
    await rejectsCode(undo(), "conflict");
    // Hand edits after the job can be undone, but only back to the job's revision.
    const t5 = await edit(4, "s-2"); // 5
    assert.equal(t5.canUndo, true);
    const u = await undo();
    assert.deepEqual([u.revision, u.canUndo, u.canRedo], [4, false, true]);
    assert.ok(has(v.projectDir, "s-2"));
    // A job saving while an undo is pending drops the redo history.
    await w.timeline.api.saveRevision(v.key, {
      label: "Re-Edit",
      userId: null,
      jobId: w.makeJob(v.key, w.alice, "job-2"),
    });
    assert.equal((await get()).canRedo, false);
    await rejectsCode(redo(), "conflict");
    assert.deepEqual(
      (await list()).map((/** @type {any} */ r) => [r.n, r.jobId]),
      [
        [6, "job-2"],
        [4, "job-1"],
        [3, null],
        [2, null],
        [1, null],
      ],
      "revision 5 was undone and dropped; its number is not reused",
    );
  } finally {
    w.cleanup();
  }
});

test("restoreRevision puts an earlier state back as a new revision and removes extra graphic files", async () => {
  const w = createTimelineWorld();
  try {
    const { v, edit, get, list } = await opened(w);
    const original = readIndex(v.projectDir);
    await edit(1, "b-3"); // 2
    fs.writeFileSync(path.join(v.projectDir, "compositions", "extra.html"), "<div></div>");
    const t = await get(); // 3 (outside change)
    assert.equal(t.revision, 3);
    const restored = await w.call(w.alice, "restoreRevision", { videoId: v.videoId, n: 1 });
    assert.equal(restored.revision, 4);
    assert.equal(readIndex(v.projectDir), original);
    assert.equal(fs.existsSync(path.join(v.projectDir, "compositions", "extra.html")), false);
    assert.equal(restored.canUndo, true);
    const rows = await list();
    assert.deepEqual(
      [rows[0].n, rows[0].label, rows[0].userEmail],
      [4, "Restored revision 1", "alice@example.com"],
    );
    // The restore can be undone, back to revision 3.
    const u = await w.call(w.alice, "undoTimeline", { videoId: v.videoId });
    assert.equal(u.revision, 3);
    assert.ok(fs.existsSync(path.join(v.projectDir, "compositions", "extra.html")));
    assert.ok(!has(v.projectDir, "b-3"));
  } finally {
    w.cleanup();
  }
});

test("restoreRevision refuses the current revision, a missing one and one whose files are gone", async () => {
  const w = createTimelineWorld();
  try {
    const { v, edit } = await opened(w);
    await edit(1, "b-3");
    const ask = (/** @type {number} */ n) =>
      w.call(w.alice, "restoreRevision", { videoId: v.videoId, n });
    await rejectsCode(ask(2), "invalidInput");
    const missing = await rejectsCode(ask(7), "notFound");
    assert.match(missing.message, /Revision 7 does not exist/);
    fs.rmSync(path.join(w.dataDir, "projects", v.key, "revisions", "1"), { recursive: true });
    const gone = await rejectsCode(ask(1), "conflict");
    assert.match(gone.message, /not there any more/);
    await rejectsCode(
      w.call(w.alice, "restoreRevision", { videoId: v.videoId, n: 0 }),
      "invalidInput",
    );
  } finally {
    w.cleanup();
  }
});

test("only the newest revisions are kept, rows and folders alike", async () => {
  const w = createTimelineWorld({ keep: 3 });
  try {
    const { v, edit, list, undo } = await opened(w);
    const clips = ["b-3", "s-1", "s-2", "s-3", "m-1"];
    let revision = 1;
    for (const clip of clips) revision = (await edit(revision, clip)).revision;
    assert.equal(revision, 6);
    assert.deepEqual(
      (await list()).map((/** @type {any} */ r) => r.n),
      [6, 5, 4],
    );
    const folders = fs.readdirSync(path.join(w.dataDir, "projects", v.key, "revisions")).sort();
    assert.deepEqual(folders, ["4", "5", "6"]);
    // Undo works back to the oldest revision kept and no further.
    await undo();
    await undo();
    await rejectsCode(undo(), "conflict");
    const t = await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    assert.equal(t.revision, 4);
    assert.equal(t.canUndo, false);
  } finally {
    w.cleanup();
  }
});

test("the current revision and the undone ones above it are never pruned", async () => {
  const w = createTimelineWorld({ keep: 2 });
  try {
    const { edit, undo, redo, list } = await opened(w);
    await edit(1, "b-3");
    await edit(2, "s-1"); // 3; keeps 2 and 3
    await undo(); // at 2, 3 undone
    assert.deepEqual(
      (await list()).map((/** @type {any} */ r) => r.n),
      [3, 2],
    );
    const t = await redo();
    assert.equal(t.revision, 3);
  } finally {
    w.cleanup();
  }
});

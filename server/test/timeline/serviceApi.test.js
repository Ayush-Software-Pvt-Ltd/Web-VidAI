// What the job manager uses: `timeline.api` (docs/SPEC.md sections 10, 11 and 14).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createTimelineWorld, del, hasClip, readIndex, rejectsCode } from "./serviceSupport.js";

const request = { frame: 100, shape: null, elementId: null, prompt: "Bigger" };

test("projectDir names the folder even before it exists; projectExists checks index.html", async () => {
  const w = createTimelineWorld();
  try {
    const bare = await w.videoOf(w.alice, { project: false });
    assert.equal(
      await w.timeline.api.projectDir(bare.key),
      path.join(bare.dir, "output", "001 A.hf"),
    );
    assert.equal(await w.timeline.api.projectExists(bare.key), false);
    const v = await w.videoOf(w.alice, { folder: "002 B", channelName: "Second" });
    assert.equal(await w.timeline.api.projectExists(v.key), true);
    fs.rmSync(path.join(v.projectDir, "index.html"));
    assert.equal(await w.timeline.api.projectExists(v.key), false);
    assert.equal(await w.timeline.api.projectExists("0".repeat(32)), false);
  } finally {
    w.cleanup();
  }
});

test("check is the profile plus lint; a lint that could not run is logged, not a violation", async () => {
  /** @type {{ errors: string[], problem: string | null }} */
  let verdict = { errors: [], problem: null };
  const w = createTimelineWorld({ runLint: async () => verdict });
  try {
    const v = await w.videoOf(w.alice);
    assert.deepEqual(await w.timeline.api.check(v.key), { violations: [] });

    verdict = { errors: ["HyperFrames lint, index.html line 3: Bad."], problem: null };
    assert.deepEqual(await w.timeline.api.check(v.key), { violations: verdict.errors });

    // A profile violation comes first, then the lint error.
    fs.writeFileSync(
      path.join(v.projectDir, "index.html"),
      readIndex(v.projectDir).replace('data-duration="45"', 'data-duration="46"'),
    );
    const both = (await w.timeline.api.check(v.key)).violations;
    assert.equal(both.length >= 2, true);
    assert.equal(both.at(-1), verdict.errors[0]);
    assert.doesNotMatch(both[0] ?? "", /HyperFrames lint/);

    verdict = { errors: [], problem: "HyperFrames is not installed." };
    w.warnings.length = 0;
    const quiet = await w.timeline.api.check(v.key);
    assert.equal(
      quiet.violations.some((m) => /not installed/.test(m)),
      false,
    );
    assert.match(w.warnings.join("\n"), /not installed/);
  } finally {
    w.cleanup();
  }
});

test("takeNotes hands the pending requests to a job with seconds, author and a folder", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    const a = await w.call(w.alice, "addTimelineNote", { videoId: v.videoId, ...request });
    w.jobs.set(v.key, { id: "j1", kind: "edit" }); // keeps the second one from asking again
    const b = await w.call(w.alice, "addTimelineNote", {
      videoId: v.videoId,
      ...request,
      frame: 300,
      elementId: "b-3",
      shape: { cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5 },
    });
    const jobId = w.makeJob(v.key, w.alice, "j1");
    w.emitted.length = 0;
    const taken = await w.timeline.api.takeNotes(v.key, jobId);
    assert.deepEqual(
      taken.map((n) => n.id),
      [a.id, b.id],
    );
    assert.deepEqual(
      taken.map((n) => [n.frame, n.seconds, n.author, n.elementId, n.prompt]),
      [
        [100, 100 / 30, "alice@example.com", null, "Bigger"],
        [300, 10, "alice@example.com", "b-3", "Bigger"],
      ],
    );
    assert.deepEqual(taken[1]?.shape, { cx: 0.5, cy: 0.5, rx: 0.5, ry: 0.5 });
    assert.equal(taken[0]?.folder, w.timeline.api.noteDir(v.key, a.id));
    assert.equal(taken[0]?.folder, path.join(w.dataDir, "projects", v.key, "notes", a.id));
    // Both are running now, announced, and no longer pending.
    assert.deepEqual(w.timeline.api.pendingNotes(v.key), []);
    const states = w
      .eventsNamed("note-updated")
      .map((e) => [e.payload.note.state, e.payload.note.jobId]);
    assert.deepEqual(states, [
      ["running", "j1"],
      ["running", "j1"],
    ]);
    // Nothing pending: nothing taken, no project read needed.
    assert.deepEqual(await w.timeline.api.takeNotes(v.key, jobId), []);
  } finally {
    w.cleanup();
  }
});

test("finishNotes settles the running requests of a job and announces them", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    const note = await w.call(w.alice, "addTimelineNote", { videoId: v.videoId, ...request });
    w.makeJob(v.key, w.alice, "j1");
    await w.timeline.api.takeNotes(v.key, "j1");
    w.emitted.length = 0;
    const done = w.timeline.api.finishNotes("j1", "done");
    assert.deepEqual(
      done.map((n) => [n.id, n.state, n.jobId]),
      [[note.id, "done", "j1"]],
    );
    assert.deepEqual(
      w.eventsNamed("note-updated").map((e) => e.payload.note.state),
      ["done"],
    );
    assert.deepEqual(w.timeline.api.finishNotes("j1", "failed"), []);
    assert.deepEqual(w.timeline.api.finishNotes("nope", "failed"), []);
  } finally {
    w.cleanup();
  }
});

test("videoFreed asks for an edit for the oldest waiting request, once the video is free", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    await w.timeline.api.videoFreed(v.key);
    assert.deepEqual(w.requests, []); // nothing waiting

    w.jobs.set(v.key, { id: "j1", kind: "edit" });
    await w.call(w.alice, "addTimelineNote", { videoId: v.videoId, ...request });
    await w.timeline.api.videoFreed(v.key);
    assert.deepEqual(w.requests, []); // a job still holds the video

    w.jobs.delete(v.key);
    await w.timeline.api.videoFreed(v.key);
    assert.deepEqual(w.requests, [{ videoKey: v.key, userId: w.alice.id }]);

    // A refused request is only logged: the job manager must not fail because of it.
    w.behaviour.requestFails = new Error("No room.");
    w.warnings.length = 0;
    await w.timeline.api.videoFreed(v.key);
    assert.match(w.warnings.join("\n"), /No room/);
  } finally {
    w.cleanup();
  }
});

test("clipsAt lists the clips under a frame and is empty for an unreadable project", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    const ids = (await w.timeline.api.clipsAt(v.key, 250)).map((c) => c.id);
    assert.deepEqual(ids, ["h-1", "ov-1", "a-2", "m-1"]);
    assert.deepEqual(await w.timeline.api.clipsAt(v.key, 99999), []);
    fs.writeFileSync(path.join(v.projectDir, "index.html"), "<html>");
    assert.deepEqual(await w.timeline.api.clipsAt(v.key, 250), []);
    assert.deepEqual(await w.timeline.api.clipsAt("0".repeat(32), 1), []);
  } finally {
    w.cleanup();
  }
});

test("saveRevision records a job's result, and onlyIfChanged skips an unchanged project", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    await w.call(w.alice, "getTimeline", { videoId: v.videoId }); // revision 1
    const jobId = w.makeJob(v.key, w.alice, "j1");
    w.emitted.length = 0;

    const same = await w.timeline.api.saveRevision(v.key, {
      label: "Edit",
      userId: w.alice.id,
      jobId,
      onlyIfChanged: true,
    });
    assert.equal(same.n, 1);
    assert.equal(w.eventsNamed("timeline-changed").length, 0);

    const html = readIndex(v.projectDir);
    fs.writeFileSync(
      path.join(v.projectDir, "index.html"),
      html.replace("<body", "<!-- x --><body"),
    );
    const saved = await w.timeline.api.saveRevision(v.key, {
      label: "Edit",
      userId: w.alice.id,
      jobId,
      onlyIfChanged: true,
    });
    assert.deepEqual(
      [saved.n, saved.jobId, saved.userId, saved.label],
      [2, jobId, w.alice.id, "Edit"],
    );
    assert.deepEqual(
      w.eventsNamed("timeline-changed").map((e) => e.payload),
      [{ videoId: v.videoId, revision: 2 }],
    );
    assert.equal(w.timeline.api.latestRevision(v.key)?.n, 2);

    // Without onlyIfChanged a revision is always written.
    const forced = await w.timeline.api.saveRevision(v.key, {
      label: "Again",
      userId: null,
      jobId,
    });
    assert.equal(forced.n, 3);
    // A job's revision is a baseline: undo does not cross it.
    const t = await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    assert.deepEqual([t.revision, t.canUndo], [3, false]);
    // No project: refused.
    const bare = await w.videoOf(w.alice, {
      folder: "002 B",
      channelName: "Second",
      project: false,
    });
    await rejectsCode(
      w.timeline.api.saveRevision(bare.key, { label: "x", userId: null, jobId: null }),
      "notFound",
    );
  } finally {
    w.cleanup();
  }
});

test("restoreTo puts revision n back and saves it as a new baseline", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    const t1 = await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    const original = readIndex(v.projectDir);
    await w.call(w.alice, "editTimeline", {
      videoId: v.videoId,
      revision: t1.revision,
      op: del("b-3"),
    });
    assert.equal(hasClip(readIndex(v.projectDir), "b-3"), false);
    w.emitted.length = 0;
    // The job manager calls it while a job is still registered: no lock check.
    w.jobs.set(v.key, { id: "j1", kind: "edit" });
    const saved = await w.timeline.api.restoreTo(v.key, 1);
    assert.deepEqual(
      [saved.n, saved.label, saved.userId, saved.jobId],
      [3, "Restored revision 1", null, null],
    );
    assert.equal(readIndex(v.projectDir), original);
    assert.deepEqual(
      w.eventsNamed("timeline-changed").map((e) => e.payload.revision),
      [3],
    );
    await rejectsCode(w.timeline.api.restoreTo(v.key, 77), "notFound");
  } finally {
    w.cleanup();
  }
});

test("removeVideo forgets the revisions, their files and the requests", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    await w.call(w.alice, "addTimelineNote", { videoId: v.videoId, ...request });
    const dir = path.join(w.dataDir, "projects", v.key);
    assert.equal(fs.existsSync(path.join(dir, "revisions", "1", "index.html")), true);
    await w.timeline.api.removeVideo(v.key);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(w.timeline.api.latestRevision(v.key), null);
    assert.deepEqual(w.timeline.api.pendingNotes(v.key), []);
    // The project in the video's own folder is not touched.
    assert.equal(fs.existsSync(path.join(v.projectDir, "index.html")), true);
    await w.timeline.api.removeVideo(v.key); // twice is fine
  } finally {
    w.cleanup();
  }
});

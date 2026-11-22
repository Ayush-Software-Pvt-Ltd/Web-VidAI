// The notes table repository (docs/SPEC.md section 11, Change requests).

import assert from "node:assert/strict";
import test from "node:test";
import { createNotesRepo } from "../../src/db/notes.js";
import { createClock, createJobsDb } from "./jobsSupport.js";

function setup() {
  const clock = createClock();
  const { db } = createJobsDb({ clock });
  // One job per video (a unique index): j1 belongs to v1, j2 to v2.
  for (const [id, video] of [
    ["j1", "v1"],
    ["j2", "v2"],
  ]) {
    db.run(
      "INSERT INTO jobs (id, video_id, user_id, kind, queue, state, joined_at, video_type) VALUES (?, ?, 'u1', 'edit', 'edits', 'running', 1, 'long')",
      id,
      video,
    );
  }
  return { db, clock, repo: createNotesRepo(db, { clock }) };
}

/** @param {ReturnType<typeof createNotesRepo>} repo @param {string} prompt */
const add = (repo, prompt, videoKey = "v1") =>
  repo.insert({ videoKey, userId: "u1", frame: 10, shape: null, elementId: null, prompt });

test("insert makes a pending note with a random id", () => {
  const { repo, clock } = setup();
  clock.set(777);
  const shape = { cx: 0.25, cy: 0.5, rx: 0.1, ry: 0.2 };
  const note = repo.insert({
    videoKey: "v1",
    userId: "u2",
    frame: 42,
    shape,
    elementId: "b-3",
    prompt: "Smaller, please",
  });
  assert.match(note.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(
    { ...note, id: "x" },
    {
      id: "x",
      videoKey: "v1",
      userId: "u2",
      frame: 42,
      shape,
      elementId: "b-3",
      prompt: "Smaller, please",
      state: "pending",
      jobId: null,
      error: null,
      createdAt: 777,
    },
  );
  // Stored and read back the same, shape included (and a missing shape stays null).
  assert.deepEqual(repo.byId(note.id), note);
  const whole = add(repo, "whole frame");
  assert.deepEqual([repo.byId(whole.id)?.shape, repo.byId(whole.id)?.elementId], [null, null]);
  assert.notEqual(note.id, whole.id);
  assert.equal(repo.byId("missing"), undefined);
});

test("notes list in the order they were written, and pending ones per video", () => {
  const { repo, clock } = setup();
  const a = add(repo, "a");
  const b = add(repo, "b"); // same millisecond: insertion order still holds
  clock.advance(5);
  const c = add(repo, "c");
  add(repo, "other video", "v2");
  assert.deepEqual(
    repo.listForVideo("v1").map((n) => n.prompt),
    ["a", "b", "c"],
  );
  repo.setState(b.id, "failed");
  assert.deepEqual(
    repo.pending("v1").map((n) => n.id),
    [a.id, c.id],
  );
  assert.deepEqual(
    repo.pending("v2").map((n) => n.prompt),
    ["other video"],
  );
});

test("take hands pending notes to a job; finish settles only the running ones of that job", () => {
  const { repo } = setup();
  const a = add(repo, "a");
  const b = add(repo, "b");
  const failedBefore = add(repo, "old");
  repo.setState(failedBefore.id, "failed");
  const taken = repo.take("v1", "j1");
  assert.deepEqual(
    taken.map((n) => [n.id, n.state, n.jobId]),
    [
      [a.id, "running", "j1"],
      [b.id, "running", "j1"],
    ],
  );
  assert.deepEqual(repo.take("v1", "j1"), []);
  assert.deepEqual(repo.pending("v1"), []);
  assert.deepEqual(
    repo.byJob("j1").map((n) => n.id),
    [a.id, b.id],
  );
  assert.deepEqual(repo.finish("j2", "done"), []); // j2 has taken nothing

  const late = add(repo, "late"); // written while j1 runs
  const settled = repo.finish("j1", "done");
  assert.deepEqual(
    settled.map((n) => [n.id, n.state]),
    [
      [a.id, "done"],
      [b.id, "done"],
    ],
  );
  assert.equal(repo.byId(late.id)?.state, "pending");
  assert.equal(repo.byId(failedBefore.id)?.state, "failed");
  // Settled notes are not touched by a second finish.
  assert.deepEqual(repo.finish("j1", "failed"), []);
  assert.equal(repo.byId(a.id)?.state, "done");
});

test("requeue puts a note back to pending without a job", () => {
  const { repo } = setup();
  const a = add(repo, "a");
  repo.take("v1", "j1");
  repo.finish("j1", "failed");
  assert.equal(repo.byId(a.id)?.state, "failed");
  repo.requeue(a.id);
  assert.deepEqual([repo.byId(a.id)?.state, repo.byId(a.id)?.jobId], ["pending", null]);
});

test("remove and removeAll delete notes", () => {
  const { repo } = setup();
  const a = add(repo, "a");
  add(repo, "b");
  add(repo, "c", "v2");
  repo.remove(a.id);
  assert.deepEqual(
    repo.listForVideo("v1").map((n) => n.prompt),
    ["b"],
  );
  repo.removeAll("v1");
  assert.equal(repo.listForVideo("v1").length, 0);
  assert.equal(repo.listForVideo("v2").length, 1);
});

test("a note needs a real video and user", () => {
  const { repo } = setup();
  assert.throws(() => add(repo, "x", "nope"), /FOREIGN KEY/);
  assert.throws(
    () =>
      repo.insert({
        videoKey: "v1",
        userId: "ghost",
        frame: 1,
        shape: null,
        elementId: null,
        prompt: "x",
      }),
    /FOREIGN KEY/,
  );
});

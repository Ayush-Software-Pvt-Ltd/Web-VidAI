// The revisions table repository (docs/SPEC.md section 11, Revisions).

import assert from "node:assert/strict";
import test from "node:test";
import { createRevisionsRepo } from "../../src/db/revisions.js";
import { createClock, createJobsDb } from "./jobsSupport.js";

function setup() {
  const clock = createClock();
  const { db } = createJobsDb({ clock });
  db.run(
    "INSERT INTO jobs (id, video_id, user_id, kind, queue, state, joined_at, video_type) VALUES ('j1', 'v1', 'u1', 'edit', 'edits', 'running', 1, 'long')",
  );
  return { db, clock, repo: createRevisionsRepo(db, { clock }) };
}

/** @param {ReturnType<typeof createRevisionsRepo>} repo @param {string} label */
const add = (repo, label, videoKey = "v1") =>
  repo.insert({ videoKey, label, userId: "u1", jobId: null });

test("numbers start at 1 and count per video", () => {
  const { repo, clock } = setup();
  assert.equal(repo.current("v1"), undefined);
  clock.set(500);
  const first = add(repo, "Existing project");
  assert.deepEqual(first.dropped, []);
  assert.deepEqual(first.revision, {
    videoKey: "v1",
    n: 1,
    label: "Existing project",
    userId: "u1",
    jobId: null,
    createdAt: 500,
    undone: false,
  });
  assert.equal(add(repo, "b").revision.n, 2);
  assert.equal(add(repo, "other video", "v2").revision.n, 1);
  assert.deepEqual(
    repo.list("v1").map((r) => r.n),
    [1, 2],
  );
  assert.equal(repo.get("v1", 2)?.label, "b");
  assert.equal(repo.get("v1", 9), undefined);
});

test("a revision may name a job and no user", () => {
  const { repo } = setup();
  const { revision } = repo.insert({ videoKey: "v1", label: "Edit", userId: null, jobId: "j1" });
  assert.deepEqual([revision.userId, revision.jobId], [null, "j1"]);
  assert.equal(repo.get("v1", 1)?.jobId, "j1");
});

test("current is the newest revision that is not undone; before and nextUndone look around it", () => {
  const { repo } = setup();
  for (const label of ["a", "b", "c"]) add(repo, label);
  assert.equal(repo.current("v1")?.n, 3);
  repo.setUndone("v1", 3, true);
  repo.setUndone("v1", 2, true);
  assert.equal(repo.current("v1")?.n, 1);
  assert.equal(repo.nextUndone("v1")?.n, 2);
  assert.equal(repo.before("v1", 3)?.n, 2);
  assert.equal(repo.before("v1", 1), undefined);
  assert.deepEqual(
    repo.list("v1").map((r) => [r.n, r.undone]),
    [
      [1, false],
      [2, true],
      [3, true],
    ],
  );
  repo.setUndone("v1", 2, false);
  assert.equal(repo.current("v1")?.n, 2);
  assert.equal(repo.nextUndone("v1")?.n, 3);
});

test("a new revision drops the undone ones and never reuses their numbers", () => {
  const { repo } = setup();
  for (const label of ["a", "b", "c"]) add(repo, label);
  repo.setUndone("v1", 3, true);
  repo.setUndone("v1", 2, true);
  const next = add(repo, "d");
  assert.equal(next.revision.n, 4);
  assert.deepEqual(next.dropped, [2, 3]);
  assert.deepEqual(
    repo.list("v1").map((r) => r.n),
    [1, 4],
  );
  // The gap stays: even when the newest row was the undone one.
  repo.setUndone("v1", 4, true);
  assert.equal(add(repo, "e").revision.n, 5);
  assert.deepEqual(
    repo.list("v1").map((r) => r.n),
    [1, 5],
  );
});

test("remove deletes one revision", () => {
  const { repo } = setup();
  add(repo, "a");
  add(repo, "b");
  repo.remove("v1", 2);
  assert.deepEqual(
    repo.list("v1").map((r) => r.n),
    [1],
  );
  assert.equal(add(repo, "c").revision.n, 2);
});

test("pruneOldest removes the oldest down to the limit and spares the protected tail", () => {
  const { repo } = setup();
  for (let i = 1; i <= 6; i += 1) add(repo, `r${i}`);
  assert.deepEqual(repo.pruneOldest("v1", 10, 6), []);
  assert.deepEqual(repo.pruneOldest("v1", 4, 6), [1, 2]);
  assert.deepEqual(
    repo.list("v1").map((r) => r.n),
    [3, 4, 5, 6],
  );
  // The protected number and everything above it stay even above the limit.
  assert.deepEqual(repo.pruneOldest("v1", 1, 5), [3, 4]);
  assert.deepEqual(
    repo.list("v1").map((r) => r.n),
    [5, 6],
  );
  // Another video is untouched.
  add(repo, "x", "v2");
  assert.deepEqual(repo.pruneOldest("v2", 0, 1), []);
  assert.equal(repo.list("v2").length, 1);
});

test("removeAll clears one video only", () => {
  const { repo } = setup();
  add(repo, "a");
  add(repo, "b", "v2");
  repo.removeAll("v1");
  assert.deepEqual([repo.list("v1").length, repo.list("v2").length], [0, 1]);
  assert.equal(add(repo, "again").revision.n, 1);
});

test("a revision needs a real video and a real job", () => {
  const { repo } = setup();
  assert.throws(() => add(repo, "x", "nope"), /FOREIGN KEY/);
  assert.throws(
    () => repo.insert({ videoKey: "v1", label: "x", userId: null, jobId: "ghost" }),
    /FOREIGN KEY/,
  );
});

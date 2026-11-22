// Change requests through the service (docs/SPEC.md section 11, Change requests).

import assert from "node:assert/strict";
import test from "node:test";
import { createTimelineWorld, rejectsCode } from "./serviceSupport.js";

const request = { frame: 100, shape: null, elementId: null, prompt: "Make the title bigger" };

/** @param {ReturnType<typeof createTimelineWorld>} w */
async function withVideo(w) {
  const v = await w.videoOf(w.alice);
  /** @param {Record<string, unknown>} [change] */
  const add = (change = {}) =>
    w.call(w.alice, "addTimelineNote", { videoId: v.videoId, ...request, ...change });
  return { v, add };
}

test("a request is stored, shows on the timeline, announces itself and asks for an edit", async () => {
  const w = createTimelineWorld();
  try {
    const { v, add } = await withVideo(w);
    const note = await add({
      shape: { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.1 },
      elementId: "b-3",
      prompt: "  Smaller  ",
    });
    assert.match(note.id, /^[0-9a-f]{32}$/);
    assert.deepEqual(
      { ...note, id: "x", createdAt: 0 },
      {
        id: "x",
        frame: 100,
        shape: { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.1 },
        elementId: "b-3",
        prompt: "Smaller",
        state: "pending",
        jobId: null,
        error: null,
        createdAt: 0,
      },
    );
    assert.deepEqual(w.requests, [{ videoKey: v.key, userId: w.alice.id }]);
    const events = w.eventsNamed("note-updated");
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.payload, { videoId: v.videoId, note, removed: false });
    assert.deepEqual([events[0]?.userId, events[0]?.admins], [w.alice.id, false]);
    const t = await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    assert.deepEqual(
      t.notes.map((/** @type {any} */ n) => n.id),
      [note.id],
    );
    assert.deepEqual(
      w.timeline.api.pendingNotes(v.key).map((n) => n.id),
      [note.id],
    );
  } finally {
    w.cleanup();
  }
});

test("while a job holds the video the request waits and no edit is requested", async () => {
  const w = createTimelineWorld();
  try {
    const { v, add } = await withVideo(w);
    w.jobs.set(v.key, { id: "j", kind: "edit" });
    const note = await add();
    assert.equal(note.state, "pending");
    assert.deepEqual(w.requests, []);
    assert.equal(w.eventsNamed("note-updated").length, 1);
  } finally {
    w.cleanup();
  }
});

test("a refused request is not stored and does not announce anything", async () => {
  const w = createTimelineWorld();
  try {
    const { v, add } = await withVideo(w);
    await rejectsCode(add({ frame: 5000 }), "invalidInput");
    await rejectsCode(add({ elementId: "no-such-clip" }), "invalidInput");
    await rejectsCode(add({ prompt: "  " }), "invalidInput");
    await rejectsCode(add({ shape: { cx: 2, cy: 0, rx: 0.1, ry: 0.1 } }), "invalidInput");
    assert.deepEqual(w.timeline.api.pendingNotes(v.key), []);
    assert.deepEqual(
      [w.requests.length, w.emitted.filter((e) => e.event === "note-updated").length],
      [0, 0],
    );
    // A video with no project cannot take one either.
    const bare = await w.videoOf(w.alice, {
      folder: "002 B",
      channelName: "Second",
      project: false,
    });
    await rejectsCode(
      w.call(w.alice, "addTimelineNote", { videoId: bare.videoId, ...request }),
      "notFound",
    );
  } finally {
    w.cleanup();
  }
});

test("when the edit cannot be requested the new request is taken back", async () => {
  const w = createTimelineWorld();
  try {
    const { v, add } = await withVideo(w);
    w.behaviour.requestFails = Object.assign(new Error("The queue is full."), { code: "conflict" });
    await assert.rejects(add(), /queue is full/);
    assert.deepEqual(w.timeline.api.pendingNotes(v.key), []);
    assert.equal(w.eventsNamed("note-updated").length, 0);
  } finally {
    w.cleanup();
  }
});

test("only a pending request can be deleted, and the delete is announced", async () => {
  const w = createTimelineWorld();
  try {
    const { v, add } = await withVideo(w);
    const note = await add();
    await w.call(w.alice, "deleteTimelineNote", { videoId: v.videoId, noteId: note.id });
    assert.deepEqual(w.timeline.api.pendingNotes(v.key), []);
    const last = w.eventsNamed("note-updated").at(-1);
    assert.deepEqual(last?.payload, { videoId: v.videoId, note, removed: true });
    await rejectsCode(
      w.call(w.alice, "deleteTimelineNote", { videoId: v.videoId, noteId: note.id }),
      "notFound",
    );

    // A running request is the agent's now.
    const running = await add();
    w.makeJob(v.key, w.alice, "j1");
    await w.timeline.api.takeNotes(v.key, "j1");
    await rejectsCode(
      w.call(w.alice, "deleteTimelineNote", { videoId: v.videoId, noteId: running.id }),
      "conflict",
    );
    w.timeline.api.finishNotes("j1", "done");
    await rejectsCode(
      w.call(w.alice, "deleteTimelineNote", { videoId: v.videoId, noteId: running.id }),
      "conflict",
    );
  } finally {
    w.cleanup();
  }
});

test("only a failed request can be sent again", async () => {
  const w = createTimelineWorld();
  try {
    const { v, add } = await withVideo(w);
    const note = await add();
    const retry = () =>
      w.call(w.alice, "retryTimelineNote", { videoId: v.videoId, noteId: note.id });
    await rejectsCode(retry(), "conflict"); // still pending
    w.makeJob(v.key, w.alice, "j1");
    await w.timeline.api.takeNotes(v.key, "j1");
    await rejectsCode(retry(), "conflict"); // running
    w.timeline.api.finishNotes("j1", "done");
    await rejectsCode(retry(), "conflict"); // done
  } finally {
    w.cleanup();
  }
});

test("a failed request goes back to pending and asks for an edit; a failing request rolls back", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    const add = () => w.call(w.alice, "addTimelineNote", { videoId: v.videoId, ...request });
    const note = await add();
    w.makeJob(v.key, w.alice, "j1");
    await w.timeline.api.takeNotes(v.key, "j1");
    w.timeline.api.finishNotes("j1", "failed");
    w.requests.length = 0;

    w.behaviour.requestFails = new Error("No room.");
    await assert.rejects(
      w.call(w.alice, "retryTimelineNote", { videoId: v.videoId, noteId: note.id }),
      /No room/,
    );
    assert.deepEqual(w.timeline.api.pendingNotes(v.key), []); // back to failed

    w.behaviour.requestFails = null;
    const again = await w.call(w.alice, "retryTimelineNote", {
      videoId: v.videoId,
      noteId: note.id,
    });
    assert.deepEqual([again.id, again.state, again.jobId], [note.id, "pending", null]);
    assert.deepEqual(w.requests, [{ videoKey: v.key, userId: w.alice.id }]);
    assert.deepEqual(w.eventsNamed("note-updated").at(-1)?.payload.note, again);
  } finally {
    w.cleanup();
  }
});

test("a retry while a job holds the video waits without asking for an edit", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    const note = await w.call(w.alice, "addTimelineNote", { videoId: v.videoId, ...request });
    w.makeJob(v.key, w.alice, "j1");
    await w.timeline.api.takeNotes(v.key, "j1");
    w.timeline.api.finishNotes("j1", "failed");
    w.requests.length = 0;
    w.jobs.set(v.key, { id: "j9", kind: "edit" });
    await w.call(w.alice, "retryTimelineNote", { videoId: v.videoId, noteId: note.id });
    assert.deepEqual(w.requests, []);
    assert.equal(w.timeline.api.pendingNotes(v.key).length, 1);
  } finally {
    w.cleanup();
  }
});

test("another user's video and another video's request are notFound", async () => {
  const w = createTimelineWorld();
  try {
    const { v, add } = await withVideo(w);
    const note = await add();
    await rejectsCode(
      w.call(w.bob, "addTimelineNote", { videoId: v.videoId, ...request }),
      "notFound",
    );
    for (const name of ["deleteTimelineNote", "retryTimelineNote"]) {
      await rejectsCode(w.call(w.bob, name, { videoId: v.videoId, noteId: note.id }), "notFound");
    }
    // Alice's own other video does not know the request either.
    const other = await w.videoOf(w.alice, { folder: "002 B", channelName: "Second" });
    await rejectsCode(
      w.call(w.alice, "deleteTimelineNote", { videoId: other.videoId, noteId: note.id }),
      "notFound",
    );
    assert.equal(w.timeline.api.pendingNotes(v.key).length, 1);
  } finally {
    w.cleanup();
  }
});

test("a failed request keeps the sentence of its job: in the note-updated, getTimeline and openTimeline", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    const note = await w.call(w.alice, "addTimelineNote", { videoId: v.videoId, ...request });
    assert.equal(note.error, null);
    w.makeJob(v.key, w.alice, "j1");
    await w.timeline.api.takeNotes(v.key, "j1");
    w.emitted.length = 0;
    const failed = w.timeline.api.finishNotes("j1", "failed", "The agent ran out of credit.");
    assert.deepEqual(
      failed.map((n) => [n.state, n.error]),
      [["failed", "The agent ran out of credit."]],
    );
    const news = w.eventsNamed("note-updated");
    assert.equal(news.length, 1);
    assert.deepEqual(
      [news[0]?.payload.note.state, news[0]?.payload.note.error],
      ["failed", "The agent ran out of credit."],
    );
    const got = await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    assert.equal(got.notes[0].error, "The agent ran out of credit.");
    const opened = await w.call(w.alice, "openTimeline", { videoId: v.videoId });
    assert.equal(opened.timeline.notes[0].error, "The agent ran out of credit.");
  } finally {
    w.cleanup();
  }
});

test("a request that is done, or failed without a sentence, has no error", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    const add = () => w.call(w.alice, "addTimelineNote", { videoId: v.videoId, ...request });
    await add();
    w.makeJob(v.key, w.alice, "j1");
    await w.timeline.api.takeNotes(v.key, "j1");
    assert.deepEqual(
      w.timeline.api.finishNotes("j1", "done").map((n) => [n.state, n.error]),
      [["done", null]],
    );
    await add();
    w.makeJob(v.key, w.alice, "j2");
    await w.timeline.api.takeNotes(v.key, "j2");
    assert.deepEqual(
      w.timeline.api.finishNotes("j2", "failed").map((n) => [n.state, n.error]),
      [["failed", null]],
    );
  } finally {
    w.cleanup();
  }
});

test("a retry clears the error, also when it is announced; a failing retry restores it", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    const note = await w.call(w.alice, "addTimelineNote", { videoId: v.videoId, ...request });
    w.makeJob(v.key, w.alice, "j1");
    await w.timeline.api.takeNotes(v.key, "j1");
    w.timeline.api.finishNotes("j1", "failed", "No room.");
    const stored = () => /** @type {any} */ (w.timeline.api).pendingNotes(v.key);
    assert.deepEqual(stored(), []);

    w.behaviour.requestFails = new Error("Try later.");
    await assert.rejects(
      w.call(w.alice, "retryTimelineNote", { videoId: v.videoId, noteId: note.id }),
      /Try later/,
    );
    const afterFailure = await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    assert.deepEqual(
      [afterFailure.notes[0].state, afterFailure.notes[0].error],
      ["failed", "No room."],
    );

    w.behaviour.requestFails = null;
    w.emitted.length = 0;
    const again = await w.call(w.alice, "retryTimelineNote", {
      videoId: v.videoId,
      noteId: note.id,
    });
    assert.deepEqual([again.state, again.error], ["pending", null]);
    assert.deepEqual(
      w.eventsNamed("note-updated").map((e) => [e.payload.note.state, e.payload.note.error]),
      [["pending", null]],
    );
    const got = await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    assert.equal(got.notes[0].error, null);
  } finally {
    w.cleanup();
  }
});

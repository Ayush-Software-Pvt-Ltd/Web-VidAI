// One test per event of SPEC section 14, through the real `GET /api/events` stream: who gets it
// and who does not. The streams of three accounts stay open for the whole file.
//
// A stranger "gets none" is proven with a barrier: after the action, one event that goes to
// everyone is sent and awaited. Delivery to one stream is in order, so everything that was going
// to arrive before it has arrived.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { startWorld, until } from "./world.js";

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let w;
/** @type {Awaited<ReturnType<typeof w.addUser>>} */
let alice;
/** @type {Awaited<ReturnType<typeof w.addUser>>} */
let bob;
/** @type {Awaited<ReturnType<typeof w.addVideo>>} */
let video;
/** @type {Record<"alice" | "bob" | "admin", Awaited<ReturnType<typeof alice.client.openStream>>>} */
let streams;
let barriers = 0;

before(async () => {
  w = await startWorld();
  alice = await w.addUser({ name: "alice" });
  bob = await w.addUser({ name: "bob" });
  video = await w.addVideo(alice);
  w.writesProject(video);
  streams = {
    alice: await alice.client.openStream(),
    bob: await bob.client.openStream(),
    admin: await w.admin.openStream(),
  };
});

after(async () => {
  await w.close();
});

/**
 * Run `action`, wait for everything it caused, and return the events each account got meanwhile.
 * @param {() => Promise<unknown>} action
 * @param {{ until?: (seen: ReturnType<typeof collect>) => boolean }} [options]
 */
async function during(action, options = {}) {
  const marks = {
    alice: streams.alice.messages().length,
    bob: streams.bob.messages().length,
    admin: streams.admin.messages().length,
  };
  await action();
  if (options.until) await until(() => options.until?.(collect(marks)) === true, 30_000);
  barriers += 1;
  const id = barriers;
  w.app.events.emit({
    event: "settings-changed",
    payload: { barrier: id },
    userId: null,
    admins: false,
  });
  for (const stream of Object.values(streams)) {
    await until(() =>
      stream.messages().some((m) => m.event === "settings-changed" && m.payload?.barrier === id),
    );
  }
  return collect(marks, true);
}

/**
 * @param {Record<"alice" | "bob" | "admin", number>} marks
 * @param {boolean} [withoutBarrier]
 */
function collect(marks, withoutBarrier = false) {
  const take = (/** @type {"alice" | "bob" | "admin"} */ who) =>
    streams[who]
      .messages()
      .slice(marks[who])
      .filter((m) => !(withoutBarrier && m.event === "settings-changed" && m.payload?.barrier));
  return { alice: take("alice"), bob: take("bob"), admin: take("admin") };
}

/** @param {{ event: string }[]} messages @param {string} event */
const count = (messages, event) => messages.filter((m) => m.event === event).length;

test("library-changed: the owner only", async () => {
  const seen = await during(
    () =>
      alice.client.rpc("createChannel", {
        name: "Another",
        videoType: "auto",
        location: { kind: "new", parent: null, folderName: "Another" },
      }),
    { until: (s) => count(s.alice, "library-changed") > 0 },
  );
  assert.ok(count(seen.alice, "library-changed") > 0);
  assert.equal(count(seen.bob, "library-changed"), 0);
  assert.equal(count(seen.admin, "library-changed"), 0);
});

/** The job of the next tests: one edit of Alice's video, finished. */
let jobId = "";
test("job-updated (owner and admins) and job-log (owner only), nothing for another user", async () => {
  const seen = await during(
    async () => {
      const started = await alice.client.rpc("startEdit", { videoId: video.videoId });
      assert.equal(started.status, 200, started.text);
      jobId = started.json.id;
      await w.waitState(jobId, "completed");
    },
    {
      until: (s) =>
        s.alice.some((m) => m.event === "job-updated" && m.payload.state === "completed"),
    },
  );
  for (const who of /** @type {const} */ (["alice", "admin"])) {
    assert.ok(count(seen[who], "job-updated") > 0, `${who} got job-updated`);
  }
  assert.ok(count(seen.alice, "job-log") > 0, "the owner got job-log");
  assert.equal(count(seen.admin, "job-log"), 0, "an admin does not get another user's job-log");
  assert.equal(count(seen.bob, "job-updated"), 0);
  assert.equal(count(seen.bob, "job-log"), 0);
  const logged = seen.alice.find((m) => m.event === "job-log");
  assert.equal(logged?.payload.jobId, jobId);
  assert.equal(logged?.payload.videoId, video.videoId);
});

test("queue-changed: every account (the payload names the queue, nothing else)", async () => {
  const seen = await during(
    async () => {
      // A second edit of Alice's video: Re-Edit runs a job again and moves the queue.
      const again = await alice.client.rpc("reEdit", { videoId: video.videoId, text: "shorter" });
      assert.equal(again.status, 200, again.text);
      await w.waitState(again.json.id, "completed");
    },
    { until: (s) => count(s.bob, "queue-changed") > 0 && count(s.alice, "queue-changed") > 0 },
  );
  for (const who of /** @type {const} */ (["alice", "bob", "admin"])) {
    const hit = seen[who].find((m) => m.event === "queue-changed");
    assert.ok(hit, `${who} got queue-changed`);
    assert.deepEqual(Object.keys(hit.payload), ["queue"]);
  }
});

test("settings-changed: every account", async () => {
  const seen = await during(() => w.admin.rpc("adminUpdateSettings", { maxEditsPerUser: 5 }), {
    until: (s) => count(s.bob, "settings-changed") > 0,
  });
  for (const who of /** @type {const} */ (["alice", "bob", "admin"])) {
    assert.ok(count(seen[who], "settings-changed") > 0, `${who} got settings-changed`);
  }
});

test("timeline-changed and note-updated: the owner only", async () => {
  const opened = await alice.client.rpc("openTimeline", { videoId: video.videoId });
  assert.equal(opened.status, 200, opened.text);
  const edited = await during(
    async () => {
      const note = await alice.client.rpc("addTimelineNote", {
        videoId: video.videoId,
        frame: 5,
        shape: null,
        elementId: null,
        prompt: "Make the title bigger.",
      });
      assert.equal(note.status, 200, note.text);
      // The note starts a timeline edit; wait for it to be taken and done.
      await until(() => w.app.db.all("SELECT id FROM jobs WHERE kind = 'timelineEdit'").length > 0);
    },
    { until: (s) => count(s.alice, "note-updated") > 0 },
  );
  assert.ok(count(edited.alice, "note-updated") > 0);
  assert.equal(count(edited.bob, "note-updated"), 0);
  assert.equal(count(edited.admin, "note-updated"), 0);
  // The job ends (it makes a new revision for the project): wait, then check the timeline event.
  await until(
    () =>
      w.app.db
        .all("SELECT state FROM jobs WHERE kind = 'timelineEdit'")
        .every((r) => r["state"] === "completed"),
    30_000,
  );
  const state = await alice.client.rpc("getTimeline", { videoId: video.videoId });
  assert.equal(state.status, 200, state.text);
  const seen = await during(
    async () => {
      const split = await tryAHandEdit(video.videoId);
      assert.ok(split, "one hand edit is accepted");
    },
    { until: (s) => count(s.alice, "timeline-changed") > 0 },
  );
  assert.ok(count(seen.alice, "timeline-changed") > 0);
  assert.equal(count(seen.bob, "timeline-changed"), 0);
  assert.equal(count(seen.admin, "timeline-changed"), 0);
});

/**
 * Splits the first clip that accepts it (as `timelineRender.test.js` does).
 * @param {string} videoId
 */
async function tryAHandEdit(videoId) {
  const current = (await alice.client.rpc("getTimeline", { videoId })).json;
  const clips = current.tracks.flatMap((/** @type {any} */ track) => track.clips);
  for (const clip of clips) {
    const reply = await alice.client.rpc("editTimeline", {
      videoId,
      revision: current.revision,
      op: { type: "split", clipId: clip.id, frame: clip.start + Math.floor(clip.duration / 2) },
    });
    if (reply.status === 200) return true;
  }
  return false;
}

test("disk-use-changed: the owner only", async () => {
  const working = path.join(video.dir, "CLAUDE_VE");
  fs.mkdirSync(working, { recursive: true });
  fs.writeFileSync(path.join(working, "scratch.bin"), Buffer.alloc(2048, 1));
  const seen = await during(() => alice.client.rpc("getDiskUse"), {
    until: (s) => s.alice.some((m) => m.event === "disk-use-changed" && !m.payload.measuring),
  });
  assert.ok(count(seen.alice, "disk-use-changed") > 0);
  assert.equal(count(seen.bob, "disk-use-changed"), 0);
  assert.equal(count(seen.admin, "disk-use-changed"), 0);
});

test("system-changed: the admins only", async () => {
  const seen = await during(() => w.admin.rpc("adminPrepareToolkit"), {
    until: (s) => count(s.admin, "system-changed") > 0,
  });
  assert.ok(count(seen.admin, "system-changed") > 0);
  assert.equal(count(seen.alice, "system-changed"), 0);
  assert.equal(count(seen.bob, "system-changed"), 0);
});

test("usage-updated: every account (sent through the bus: no real usage source in the tests)", async () => {
  const seen = await during(async () => {
    w.app.events.emit({
      event: "usage-updated",
      payload: { opencode: null },
      userId: null,
      admins: false,
    });
  });
  for (const who of /** @type {const} */ (["alice", "bob", "admin"])) {
    assert.equal(count(seen[who], "usage-updated"), 1, `${who} got usage-updated`);
  }
});

test("preview-copies-changed: the owner only (sent through the bus: making copies needs real media; proxy.test.js pins the module's own admins flag)", async () => {
  const seen = await during(async () => {
    w.app.events.emit({
      event: "preview-copies-changed",
      payload: { videoId: video.videoId, copies: { total: 0, done: 0, running: false } },
      userId: alice.id,
      admins: false,
    });
  });
  assert.equal(count(seen.alice, "preview-copies-changed"), 1);
  assert.equal(count(seen.admin, "preview-copies-changed"), 0);
  assert.equal(count(seen.bob, "preview-copies-changed"), 0);
});

test("session-ended: the person whose password an admin changed, with the reason", async () => {
  const carol = await w.addUser({ name: "carol" });
  const stream = await carol.client.openStream();
  const changed = await w.admin.rpc("adminUpdateUser", {
    id: carol.id,
    password: "a-new-password-for-carol",
  });
  assert.equal(changed.status, 200, changed.text);
  const payload = await stream.next("session-ended");
  assert.equal(payload.reason, "passwordChanged");
  await stream.ended;
  assert.equal(count(streams.alice.messages(), "session-ended"), 0);
  assert.equal(count(streams.bob.messages(), "session-ended"), 0);
});

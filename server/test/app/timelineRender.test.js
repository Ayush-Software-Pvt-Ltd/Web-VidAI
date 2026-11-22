// The timeline, a change request and Render Final through the real server (SPEC sections 11, 12, 14).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FIXTURES } from "../timeline/helpers.js";
import { startWorld, until } from "./world.js";

/** A valid project (the long fixture: 30 fps, 45 seconds) that the fake renderer renders. @param {string} dir */
function writeProject(dir) {
  fs.cpSync(path.join(FIXTURES, "long"), dir, { recursive: true });
}
const FRAMES = 45 * 30;

/** @param {any} timeline @returns {Array<{ id: string, kind: string, start: number, duration: number }>} */
const clipsOf = (timeline) => timeline.tracks.flatMap((/** @type {any} */ track) => track.clips);

test("the timeline opens, the preview serves, a hand edit and undo, a change request completes", async () => {
  const w = await startWorld();
  try {
    const user = await w.addUser();
    const video = await w.addVideo(user);
    w.writesProject(video.projectDir);
    const first = await user.client.rpc("startEdit", { videoId: video.videoId });
    await w.waitState(first.json.id, "completed");

    const opened = await user.client.rpc("openTimeline", { videoId: video.videoId });
    assert.equal(opened.status, 200, opened.text);
    assert.match(opened.json.previewUrl, /^\/p\/[\w-]+\/$/);
    assert.deepEqual(Object.keys(opened.json.previewCopies).sort(), ["done", "running", "total"]);
    const page = await user.client.request("GET", opened.json.previewUrl);
    assert.equal(page.status, 200);
    assert.match(page.text, /<script[^>]*__hf\/runtime\.js/);
    assert.match(String(page.headers["content-security-policy"]), /^sandbox/);

    // The player script is public, like the UI's own files, and cached by version.
    const player = await w.client().request("GET", "/assets/hyperframes-player.js");
    assert.equal(player.status, 200);
    assert.match(String(player.headers["content-type"]), /javascript/);
    assert.match(String(player.headers["cache-control"]), /max-age/);

    const timeline = (await user.client.rpc("getTimeline", { videoId: video.videoId })).json;
    assert.equal(timeline.canUndo, false);
    let edited = null;
    for (const clip of clipsOf(timeline)) {
      const reply = await user.client.rpc("editTimeline", {
        videoId: video.videoId,
        revision: timeline.revision,
        op: { type: "split", clipId: clip.id, frame: clip.start + Math.floor(clip.duration / 2) },
      });
      if (reply.status === 200) {
        edited = reply.json;
        break;
      }
    }
    assert.ok(edited, "one hand edit is accepted");
    assert.equal(edited.canUndo, true);
    const undone = await user.client.rpc("undoTimeline", { videoId: video.videoId });
    assert.equal(undone.status, 200, undone.text);
    assert.equal(undone.json.canRedo, true);

    // A change request starts a timeline edit that completes.
    const stream = await user.client.openStream();
    const note = await user.client.rpc("addTimelineNote", {
      videoId: video.videoId,
      frame: 10,
      shape: null,
      elementId: null,
      prompt: "Make the title bigger.",
    });
    assert.equal(note.status, 200, note.text);
    await until(() =>
      stream
        .messages()
        .some(
          (m) =>
            m.event === "job-updated" &&
            m.payload.kind === "timelineEdit" &&
            m.payload.state === "completed",
        ),
    );
    const notes = (await user.client.rpc("getTimeline", { videoId: video.videoId })).json.notes;
    assert.ok(
      notes.every((/** @type {any} */ n) => n.state === "done"),
      JSON.stringify(notes),
    );
  } finally {
    await w.close();
  }
});

test("Render Final makes _final_v1.mp4 and it downloads through GET /api/file", async () => {
  const w = await startWorld();
  try {
    const user = await w.addUser();
    const video = await w.addVideo(user);
    writeProject(video.projectDir);
    fs.writeFileSync(
      w.renderConfig,
      JSON.stringify({ probe: { frames: FRAMES }, hf: { frames: FRAMES } }),
    );
    const stream = await user.client.openStream();
    const queued = await user.client.rpc("renderFinal", { videoId: video.videoId });
    assert.equal(queued.status, 200, queued.text);
    assert.equal(queued.json.kind, "render");
    await w.waitState(queued.json.id, "completed");
    const name = `${video.folder}_final_v1.mp4`;
    assert.ok(fs.existsSync(path.join(video.dir, "output", name)), "the file is in output/");
    const file = await user.client.request(
      "GET",
      `/api/file?video=${encodeURIComponent(video.videoId)}&path=${encodeURIComponent(`output/${name}`)}&download=1`,
    );
    assert.equal(file.status, 200);
    assert.match(String(file.headers["content-disposition"]), /attachment/);
    const lines = JSON.stringify((await user.client.rpc("getEditLog", {})).json);
    assert.match(lines, /Render started/);
    assert.ok(
      stream.messages().some((m) => m.event === "job-updated" && m.payload.state === "completed"),
    );
  } finally {
    await w.close();
  }
});

test("two renders at once keep their own progress", async () => {
  const w = await startWorld({ settings: { maxEdits: 2 } });
  try {
    fs.writeFileSync(
      w.renderConfig,
      JSON.stringify({
        probe: { frames: FRAMES },
        hf: { frames: FRAMES, mode: "slow", slowMs: 400, progressDelayMs: 30 },
      }),
    );
    const alice = await w.addUser();
    const bob = await w.addUser();
    const a = await w.addVideo(alice);
    const b = await w.addVideo(bob);
    writeProject(a.projectDir);
    writeProject(b.projectDir);
    const sa = await alice.client.openStream();
    const sb = await bob.client.openStream();
    const ja = (await alice.client.rpc("renderFinal", { videoId: a.videoId })).json.id;
    const jb = (await bob.client.rpc("renderFinal", { videoId: b.videoId })).json.id;
    await w.waitState(ja, "completed");
    await w.waitState(jb, "completed");
    /** @type {Array<[import("./support.js").Stream, string, string]>} */
    const pairs = [
      [sa, ja, jb],
      [sb, jb, ja],
    ];
    for (const [stream, id, other] of pairs) {
      const mine = stream.messages().filter((m) => m.event === "job-updated");
      assert.ok(mine.some((m) => m.payload.id === id));
      assert.ok(
        mine.every((m) => m.payload.id !== other),
        "never the other user's job",
      );
      const percents = mine
        .filter((m) => m.payload.id === id)
        .map((m) => m.payload.progress?.percent ?? 0);
      assert.deepEqual(
        percents,
        [...percents].sort((x, y) => x - y),
        "progress only grows",
      );
    }
  } finally {
    await w.close();
  }
});

// Isolation between users through the real server (SPEC sections 2 and 14): user B gets
// `notFound` for everything of A and none of A's events.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startWorld } from "./world.js";

test("a user cannot see, open or download anything of another user", async () => {
  const w = await startWorld();
  try {
    const a = await w.addUser({ name: "alice" });
    const b = await w.addUser({ name: "bob" });
    const video = await w.addVideo(a);
    w.writesProject(video.projectDir);
    const bStream = await b.client.openStream();
    const aStream = await a.client.openStream();

    const started = await a.client.rpc("startEdit", { videoId: video.videoId });
    assert.equal(started.status, 200, started.text);
    await w.waitState(started.json.id, "completed");
    const opened = await a.client.rpc("openTimeline", { videoId: video.videoId });
    assert.equal(opened.status, 200, opened.text);
    const previewUrl = opened.json.previewUrl ?? opened.json.preview?.url;
    assert.ok(previewUrl, JSON.stringify(Object.keys(opened.json)));
    const own = await a.client.request("GET", new URL(previewUrl, a.client.origin).pathname);
    assert.equal(own.status, 200, "the owner reaches the preview");

    // The same calls by B: not found, never "forbidden" (a stranger learns nothing).
    const calls = [
      ["startEdit", { videoId: video.videoId }],
      ["reEdit", { videoId: video.videoId, text: "make it shorter" }],
      ["openTimeline", { videoId: video.videoId }],
      ["getTimeline", { videoId: video.videoId }],
      ["getVideoInputs", { videoId: video.videoId }],
      ["archiveVideo", { videoId: video.videoId }],
      ["getJobLog", { jobId: started.json.id }],
      ["pauseJob", { jobId: started.json.id }],
      ["stopJob", { jobId: started.json.id }],
      ["updateChannel", { id: video.channelId, update: { name: "Mine now" } }],
      ["removeChannel", { id: video.channelId }],
    ];
    for (const [name, input] of calls) {
      const reply = await b.client.rpc(/** @type {string} */ (name), input);
      assert.equal(reply.status, 404, `${name}: ${reply.status} ${reply.text}`);
    }
    const listing = await b.client.rpc("getLibrary");
    assert.ok(!JSON.stringify(listing.json).includes(video.videoId), "B's library is empty of A's");

    // Files and the preview.
    const file = `/api/file?video=${encodeURIComponent(video.videoId)}&path=clip.mp4`;
    assert.equal((await a.client.request("GET", file)).status, 200);
    assert.equal((await b.client.request("GET", file)).status, 404);
    // The preview token is the only credential of the iframe (it carries no cookie): it is 32
    // random bytes bound to A's session, so a guess is not found, and it dies with A's session.
    const forged = previewUrl.replace(/\/p\/[^/]+\//, `/p/${"0".repeat(64)}/`);
    assert.equal((await b.client.request("GET", forged)).status, 404);
    await a.client.rpc("logout");
    const afterLogout = await w
      .client()
      .request("GET", new URL(previewUrl, a.client.origin).pathname);
    assert.equal(afterLogout.status, 404, "the token ended with A's session");

    // Events: a barrier (settings-changed goes to everyone, in order) proves nothing earlier came.
    await w.admin.rpc("adminUpdateSettings", { maxEditsPerUser: 4 });
    await bStream.next("settings-changed");
    const everything = JSON.stringify(bStream.messages());
    for (const secret of [video.videoId, video.channelId, video.key, started.json.id]) {
      assert.ok(!everything.includes(secret), `B's events carry ${secret}`);
    }
    for (const event of ["job-updated", "job-log", "timeline-changed", "note-updated"]) {
      assert.ok(!bStream.messages().some((m) => m.event === event), `B got ${event}`);
    }
    assert.ok(aStream.messages().some((m) => m.event === "job-updated"));
  } finally {
    await w.close();
  }
});

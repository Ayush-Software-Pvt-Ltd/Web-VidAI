// Through the real server: the server's own folder of a video (`<data dir>/projects/<videoKey>/`)
// lives as long as the video's row (SPEC section 6). It goes when the channel is removed, when the
// user is deleted, and at start when an earlier version left it behind; the channel directory and
// everything in it always stay.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { startWorld, until } from "./world.js";

/** @param {string} root @param {string} key */
const projectFolder = (root, key) => path.join(root, "data", "projects", key);

/** A timeline folder as the timeline leaves it (a revision and a change request's picture). */
function makeProjectFolder(/** @type {string} */ root, /** @type {string} */ key) {
  const dir = projectFolder(root, key);
  fs.mkdirSync(path.join(dir, "revisions", "1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "revisions", "1", "index.html"), "<html></html>");
  fs.mkdirSync(path.join(dir, "notes", "n1"), { recursive: true });
  fs.writeFileSync(path.join(dir, "notes", "n1", "frame.png"), "png");
  return dir;
}

test("removing a channel removes its videos' timeline folders and keeps the channel directory", async () => {
  const w = await startWorld();
  try {
    const alice = await w.addUser({ name: "alice" });
    const gone = await w.addVideo(alice, { channel: "Gone" });
    const kept = await w.addVideo(alice, { channel: "Kept" });
    const goneFolder = makeProjectFolder(w.root, gone.key);
    const keptFolder = makeProjectFolder(w.root, kept.key);

    const removed = await alice.client.rpc("removeChannel", { id: gone.channelId });
    assert.equal(removed.status, 200, removed.text);

    assert.equal(fs.existsSync(goneFolder), false, "the removed channel's video folder goes");
    assert.equal(fs.existsSync(keptFolder), true, "another channel's video folder stays");
    assert.equal(fs.existsSync(path.join(gone.dir, "clip.mp4")), true, "the footage stays");
  } finally {
    await w.close();
  }
});

test("a channel added again on the same directory gets a fresh timeline folder", async () => {
  const w = await startWorld();
  try {
    const alice = await w.addUser({ name: "alice" });
    const first = await w.addVideo(alice, { channel: "Again" });
    makeProjectFolder(w.root, first.key);
    const removed = await alice.client.rpc("removeChannel", { id: first.channelId });
    assert.equal(removed.status, 200, removed.text);

    const again = await alice.client.rpc("createChannel", {
      name: "Again",
      videoType: "auto",
      location: { kind: "link", dir: first.channelDir },
    });
    assert.equal(again.status, 200, again.text);
    await w.api["library"].api.rescan(alice.id);
    const video = await w.api["library"].api.videoByWireId(
      alice.id,
      `${again.json.id}/${first.folder}`,
    );
    assert.notEqual(video.key, first.key, "the video has a new row with a new key");
    assert.equal(fs.existsSync(projectFolder(w.root, first.key)), false);
    const fresh = makeProjectFolder(w.root, video.key);

    // A later removal elsewhere never touches the folder of a video that has a row.
    const other = await w.addVideo(alice, { channel: "Other" });
    const removedOther = await alice.client.rpc("removeChannel", { id: other.channelId });
    assert.equal(removedOther.status, 200, removedOther.text);
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    await w.close();
  }
});

test("deleting a user removes the timeline folders of all their videos, not others'", async () => {
  const w = await startWorld();
  try {
    const alice = await w.addUser({ name: "alice" });
    const bob = await w.addUser({ name: "bob" });
    const one = await w.addVideo(alice, { channel: "One" });
    const two = await w.addVideo(alice, { channel: "Two", folder: "002 Second" });
    const bobs = await w.addVideo(bob, { channel: "Bob's" });
    const folders = [one, two].map((video) => makeProjectFolder(w.root, video.key));
    const bobsFolder = makeProjectFolder(w.root, bobs.key);

    const deleted = await w.admin.rpc("adminDeleteUser", { id: alice.id });
    assert.equal(deleted.status, 200, deleted.text);

    for (const folder of folders) assert.equal(fs.existsSync(folder), false, folder);
    assert.equal(fs.existsSync(bobsFolder), true, "another user's folder stays");
    assert.equal(fs.existsSync(path.join(one.dir, "clip.mp4")), true, "the footage stays");
  } finally {
    await w.close();
  }
});

test("at start, timeline folders of videos without a row are removed, the others kept", async () => {
  const first = await startWorld();
  /** @type {Awaited<ReturnType<typeof startWorld>> | null} */
  let second = null;
  try {
    const alice = await first.addUser({ name: "alice" });
    const video = await first.addVideo(alice);
    const kept = makeProjectFolder(first.root, video.key);
    await first.stopApp();

    const orphans = ["0123456789abcdef0123456789abcdef", "left-by-an-earlier-version"].map((key) =>
      makeProjectFolder(first.root, key),
    );
    second = await startWorld({ base: first });
    await until(() => orphans.every((folder) => !fs.existsSync(folder)), 10_000);
    assert.equal(fs.existsSync(kept), true, "a video with a row keeps its folder");
  } finally {
    await second?.close();
    await first.close();
  }
});

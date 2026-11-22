// The upload functions of SPEC section 14 through the real RPC registry: `listUploads`,
// `createUpload` and `cancelUpload` check the target shape and only ever reach the caller's own
// videos and channels.
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bodyOf, createWorld, rejectsCode } from "./support.js";

describe("upload RPC functions", () => {
  /** @type {import("./support.js").World} */
  let world;
  /** @type {{ id: string, email: string }} */
  let alice;
  /** @type {{ id: string, email: string }} */
  let bob;
  /** @type {any} */
  let channel;
  /** @type {string} */
  let videoId;

  beforeEach(async () => {
    world = createWorld();
    alice = world.makeUser("alice@example.com");
    bob = world.makeUser("bob@example.com");
    channel = await world.makeChannel(alice, "Chan");
    world.mkdir("channels/Chan/Video 1");
    videoId = `${channel.id}/Video 1`;
  });
  afterEach(() => world.cleanup());

  const rpc = (/** @type {any} */ user, /** @type {string} */ name, /** @type {unknown} */ input) =>
    world.callRpc(user, name, input);

  test("createUpload and listUploads for a video and for a channel", async () => {
    for (const [target, folder] of /** @type {const} */ ([
      [{ kind: "video", videoId }, path.join(channel.dir, "Video 1", "upload")],
      [{ kind: "channel", channelId: channel.id }, path.join(channel.dir, "upload")],
    ])) {
      assert.deepEqual(await rpc(alice, "listUploads", { target }), []);
      const ticket = await rpc(alice, "createUpload", { target, name: "notes.pdf", size: 3 });
      assert.equal(ticket.name, "notes.pdf");
      assert.deepEqual(Object.keys(ticket).sort(), ["id", "maxChunkBytes", "name", "size"]);
      await world.mod.api.uploads.append(alice.id, ticket.id, 0, bodyOf("abc"), {
        contentLength: 3,
      });
      const files = await rpc(alice, "listUploads", { target });
      assert.deepEqual(
        files.map((/** @type {any} */ file) => [file.name, file.size]),
        [["notes.pdf", 3]],
      );
      assert.equal(fs.readFileSync(path.join(folder, "notes.pdf"), "utf8"), "abc");
    }
  });

  test("another user's targets are notFound, with the answer for a missing one", async () => {
    for (const target of [
      { kind: "video", videoId },
      { kind: "channel", channelId: channel.id },
    ]) {
      await rejectsCode(rpc(bob, "listUploads", { target }), "notFound");
      await rejectsCode(rpc(bob, "createUpload", { target, name: "x.txt", size: 1 }), "notFound");
    }
    assert.equal(fs.existsSync(path.join(channel.dir, "upload")), false);
    assert.equal(fs.existsSync(path.join(channel.dir, "Video 1", "upload")), false);
    const mine = await rpc(alice, "createUpload", {
      target: { kind: "channel", channelId: channel.id },
      name: "x.txt",
      size: 1,
    });
    await rejectsCode(rpc(bob, "cancelUpload", { id: mine.id }), "notFound");
    assert.equal(await rpc(alice, "cancelUpload", { id: mine.id }), null);
  });

  test("a target that is not one of the two shapes is invalidInput", async () => {
    for (const target of [
      undefined,
      null,
      "video",
      { kind: "broll", videoId },
      { kind: "video" },
      { kind: "video", videoId: 5 },
      { kind: "channel", videoId },
      { kind: "channel", channelId: channel.id, videoId },
      { kind: "video", videoId, channelId: channel.id },
      { kind: "video", videoId, path: "/etc" },
    ]) {
      await rejectsCode(rpc(alice, "listUploads", { target }), "invalidInput");
      await rejectsCode(
        rpc(alice, "createUpload", { target, name: "x.txt", size: 1 }),
        "invalidInput",
      );
    }
    // The old way of naming a folder is gone.
    await rejectsCode(
      rpc(alice, "createUpload", { videoId, folder: "video", name: "x.mp4", size: 1 }),
      "invalidInput",
    );
  });

  test("names and sizes are checked, an empty file is refused", async () => {
    const target = { kind: "video", videoId };
    await rejectsCode(
      rpc(alice, "createUpload", { target, name: ".hidden", size: 1 }),
      "invalidInput",
    );
    await rejectsCode(rpc(alice, "createUpload", { target, name: "CON", size: 1 }), "invalidInput");
    await rejectsCode(rpc(alice, "createUpload", { target, name: "a/b", size: 1 }), "invalidInput");
    await rejectsCode(
      rpc(alice, "createUpload", { target, name: "a.txt", size: 0 }),
      "invalidInput",
    );
    await rejectsCode(
      rpc(alice, "createUpload", { target, name: "a.txt", size: 1.5 }),
      "invalidInput",
    );
    assert.equal(fs.existsSync(path.join(channel.dir, "Video 1", "upload")), false);
  });
});

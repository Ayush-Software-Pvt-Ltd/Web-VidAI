import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createLibraryWorld, fakeJobs, rejectsCode } from "./support.js";

/** A world where alice and bob each have a channel with a video "001 A". */
async function twoUsers() {
  const w = createLibraryWorld();
  const a = await w.channelOf(w.alice, "Alice Channel");
  const b = await w.channelOf(w.bob, "Bob Channel");
  a.video("001 A", "clip.mp4");
  b.video("001 A", "clip.mp4");
  return { w, a, b, aliceVideo: `${a.channel.id}/001 A`, bobVideo: `${b.channel.id}/001 A` };
}

test("every library function needs a signed-in user", () => {
  const w = createLibraryWorld();
  try {
    assert.deepEqual(w.library.rpc.map((fn) => [fn.name, fn.access]).sort(), [
      ["archiveVideo", "user"],
      ["getArchived", "user"],
      ["getLibrary", "user"],
      ["getVideoInputs", "user"],
      ["setVideoInputs", "user"],
      ["setVideoTypeOverride", "user"],
      ["unarchiveVideo", "user"],
    ]);
  } finally {
    w.cleanup();
  }
});

test("getLibrary shows a user only their own channels", async () => {
  const { w, a, b } = await twoUsers();
  try {
    const alice = await w.call(w.alice, "getLibrary");
    const bob = await w.call(w.bob, "getLibrary");
    assert.deepEqual(
      alice.channels.map((/** @type {any} */ c) => c.channelId),
      [a.channel.id],
    );
    assert.deepEqual(
      bob.channels.map((/** @type {any} */ c) => c.channelId),
      [b.channel.id],
    );
    assert.equal(JSON.stringify(alice).includes(b.channel.id), false);
    // Someone with no channel sees an empty library.
    const carol = w.makeUser("carol@example.com");
    assert.deepEqual(await w.call(carol, "getLibrary"), { channels: [] });
  } finally {
    w.cleanup();
  }
});

test("a user can never read or change another user's video", async () => {
  const { w, aliceVideo } = await twoUsers();
  try {
    const inputs = { productLinks: "", notes: "", promptSlot: 0, styleSlot: 0 };
    /** @type {[string, unknown][]} */
    const attempts = [
      ["setVideoTypeOverride", { videoId: aliceVideo, videoType: "short" }],
      ["getVideoInputs", { videoId: aliceVideo }],
      ["setVideoInputs", { videoId: aliceVideo, inputs }],
      ["archiveVideo", { videoId: aliceVideo }],
      ["unarchiveVideo", { videoId: aliceVideo }],
    ];
    const messages = new Set();
    for (const [name, input] of attempts) {
      const error = await rejectsCode(w.call(w.bob, name, input), "notFound");
      messages.add(error.message);
    }
    assert.equal(messages.size, 1, "the same answer for every function");
    // The message is the same as for a video that does not exist.
    const missing = await rejectsCode(
      w.call(w.bob, "getVideoInputs", { videoId: `${aliceVideo.split("/")[0]}/nothing` }),
      "notFound",
    );
    assert.ok(messages.has(missing.message));

    // Nothing of Alice's changed.
    assert.deepEqual(await w.call(w.alice, "getVideoInputs", { videoId: aliceVideo }), inputs);
    assert.deepEqual(await w.call(w.alice, "getArchived"), []);
    const view = (await w.call(w.alice, "getLibrary")).channels[0].videos[0];
    assert.equal(view.typeOverride, null);
  } finally {
    w.cleanup();
  }
});

test("even an admin reaches only their own videos through the library functions", async () => {
  const { w, aliceVideo } = await twoUsers();
  try {
    await rejectsCode(w.call(w.admin, "getVideoInputs", { videoId: aliceVideo }), "notFound");
    await rejectsCode(w.call(w.admin, "archiveVideo", { videoId: aliceVideo }), "notFound");
  } finally {
    w.cleanup();
  }
});

test("a video id that is not an id is refused before anything is read", async () => {
  const { w } = await twoUsers();
  try {
    for (const videoId of ["", "ab", "no-slash-here", "../../etc/passwd", 5, null, undefined]) {
      await assert.rejects(w.call(w.alice, "getVideoInputs", { videoId }));
    }
    await assert.rejects(w.call(w.alice, "getVideoInputs", {}));
    await assert.rejects(w.call(w.alice, "getVideoInputs", { videoId: "x/y", extra: 1 }));
  } finally {
    w.cleanup();
  }
});

test("a traversing folder name never reaches another folder", async () => {
  const { w, a } = await twoUsers();
  try {
    fs.mkdirSync(path.join(path.dirname(a.dir), "outside-folder"), { recursive: true });
    for (const folder of ["../outside-folder", "..", ".", "a/b", "001 A/../../outside-folder"]) {
      await assert.rejects(
        w.call(w.alice, "getVideoInputs", { videoId: `${a.channel.id}/${folder}` }),
        /./,
        folder,
      );
    }
  } finally {
    w.cleanup();
  }
});

test("setVideoTypeOverride accepts long, short and null, nothing else", async () => {
  const { w, aliceVideo } = await twoUsers();
  try {
    for (const videoType of ["long", "short", null]) {
      const view = await w.call(w.alice, "setVideoTypeOverride", {
        videoId: aliceVideo,
        videoType,
      });
      assert.equal(view.typeOverride, videoType);
    }
    // A missing field clears, like null.
    await w.call(w.alice, "setVideoTypeOverride", { videoId: aliceVideo, videoType: "short" });
    const cleared = await w.call(w.alice, "setVideoTypeOverride", { videoId: aliceVideo });
    assert.equal(cleared.typeOverride, null);
    for (const videoType of ["auto", "LONG", "", 1, true]) {
      await assert.rejects(
        w.call(w.alice, "setVideoTypeOverride", { videoId: aliceVideo, videoType }),
        /./,
        String(videoType),
      );
    }
  } finally {
    w.cleanup();
  }
});

test("video inputs: defaults, save, read back, refuse bad values", async () => {
  const { w, aliceVideo, bobVideo } = await twoUsers();
  try {
    const defaults = { productLinks: "", notes: "", promptSlot: 0, styleSlot: 0 };
    assert.deepEqual(await w.call(w.alice, "getVideoInputs", { videoId: aliceVideo }), defaults);
    const inputs = {
      productLinks: "https://example.com/p",
      notes: "Make it fast",
      promptSlot: 3,
      styleSlot: 1,
    };
    assert.deepEqual(
      await w.call(w.alice, "setVideoInputs", { videoId: aliceVideo, inputs }),
      inputs,
    );
    assert.deepEqual(await w.call(w.alice, "getVideoInputs", { videoId: aliceVideo }), inputs);
    // Bob's video with the same folder name is separate.
    assert.deepEqual(await w.call(w.bob, "getVideoInputs", { videoId: bobVideo }), defaults);

    for (const bad of [
      null,
      "x",
      { ...inputs, promptSlot: 5 },
      { ...inputs, notes: 3 },
      { notes: "" },
    ]) {
      await rejectsCode(
        w.call(w.alice, "setVideoInputs", { videoId: aliceVideo, inputs: bad }),
        "invalidInput",
      );
    }
    assert.deepEqual(await w.call(w.alice, "getVideoInputs", { videoId: aliceVideo }), inputs);
  } finally {
    w.cleanup();
  }
});

test("archive and unarchive answer null; the archive lists only the caller's videos", async () => {
  const { w, aliceVideo, bobVideo } = await twoUsers();
  try {
    assert.equal(await w.call(w.alice, "archiveVideo", { videoId: aliceVideo }), null);
    assert.equal(await w.call(w.bob, "archiveVideo", { videoId: bobVideo }), null);
    const alice = await w.call(w.alice, "getArchived");
    const bob = await w.call(w.bob, "getArchived");
    assert.deepEqual(
      alice.map((/** @type {any} */ x) => x.videoId),
      [aliceVideo],
    );
    assert.deepEqual(
      bob.map((/** @type {any} */ x) => x.videoId),
      [bobVideo],
    );
    assert.equal(await w.call(w.alice, "unarchiveVideo", { videoId: aliceVideo }), null);
    assert.deepEqual(await w.call(w.alice, "getArchived"), []);
    assert.equal((await w.call(w.bob, "getArchived")).length, 1);
  } finally {
    w.cleanup();
  }
});

test("admins get startNow for a delayed queued edit, users do not", async () => {
  /** @type {Map<string, unknown>} */
  const jobs = new Map();
  const w = createLibraryWorld({
    jobsFor: fakeJobs(jobs),
  });
  try {
    // The admin owns a channel too: library functions only ever show one's own videos.
    const mine = await w.channelOf(w.admin, "Admin Channel");
    mine.video("001 A");
    const id = `${mine.channel.id}/001 A`;
    const { key } = await w.library.api.videoByWireId(w.admin.id, id);
    jobs.set(key, { state: "queued", startsAt: 99 });
    const admin = (await w.call(w.admin, "getLibrary")).channels[0].videos[0];
    assert.deepEqual(admin.actions, ["startNow", "stop", "upload"]);

    const own = await w.channelOf(w.alice);
    own.video("001 A");
    const ownId = `${own.channel.id}/001 A`;
    const { key: ownKey } = await w.library.api.videoByWireId(w.alice.id, ownId);
    jobs.set(ownKey, { state: "queued", startsAt: 99 });
    const user = (await w.call(w.alice, "getLibrary")).channels[0].videos[0];
    assert.deepEqual(user.actions, ["stop", "upload"]);
  } finally {
    w.cleanup();
  }
});

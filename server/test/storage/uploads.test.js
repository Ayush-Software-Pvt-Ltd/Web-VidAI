// Uploads (SPEC section 6): never overwrite, offsets, limits, one writer, cleanup.
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { OffsetConflict } from "../../src/storage/uploads.js";
import { bodyOf, createWorld, rejectsCode, treeOf, waitFor } from "./support.js";

/** @typedef {import("./support.js").World} World */

describe("uploads", () => {
  /** @type {World} */
  let world;
  /** @type {{ id: string, email: string }} */
  let alice;
  /** @type {{ id: string, email: string }} */
  let bob;
  /** @type {string} */
  let videoDir;
  /** @type {string} */
  let videoId;
  /** @type {import("../../src/storage/uploads.js").UploadHooks} */
  let hooks;
  /** @type {string} */
  let outside;
  /** @type {any} */
  let channel;

  beforeEach(async () => {
    hooks = {};
    world = createWorld({
      storageRoots: ["share"],
      uploadOptions: { hooks, maxChunkBytes: 1024, idleMs: 40 },
    });
    alice = world.makeUser("alice@example.com");
    bob = world.makeUser("bob@example.com");
    outside = world.mkdir("outside");
    const dir = world.mkdir("share/channel");
    channel = await world.makeChannel(alice, "Chan", { location: { kind: "link", dir } });
    const video = await world.mod.api.channels.createVideo(alice.id, channel.id, "Video 1");
    videoId = video.id;
    videoDir = path.join(dir, "Video 1");
    world.emitted.length = 0;
  });
  afterEach(() => world.cleanup());

  const uploads = () => world.mod.api.uploads;
  /** @param {Partial<{ videoId: string, folder: "video" | "broll", name: string, size: number }>} [input] */
  const create = (input = {}, user = alice) =>
    uploads().create(user, { videoId, folder: "video", name: "clip.mp4", size: 10, ...input });
  /** @param {string} id @param {number} offset @param {string | Buffer} text */
  const put = (id, offset, text, user = alice) => {
    const buffer = Buffer.from(text);
    return uploads().append(user.id, id, offset, bodyOf(buffer), { contentLength: buffer.length });
  };
  const parts = () => fs.readdirSync(videoDir).filter((name) => name.endsWith(".part"));

  describe("create", () => {
    test("answers a ticket, remembers the upload and tells the library", async () => {
      const ticket = await create();
      assert.equal(ticket.name, "clip.mp4");
      assert.equal(ticket.size, 10);
      assert.equal(ticket.maxChunkBytes, 1024);
      assert.match(ticket.id, /^[0-9a-f]{32}$/);
      assert.deepEqual(await uploads().state(alice.id, ticket.id), {
        received: 0,
        size: 10,
        done: false,
      });
      assert.ok(world.emitted.some((e) => e.event === "library-changed" && e.userId === alice.id));
      // Nothing visible appears before the first byte.
      assert.deepEqual(treeOf(videoDir), []);
    });

    test("B-roll uploads go to the B-roll folder, made when missing", async () => {
      const ticket = await create({ folder: "broll", name: "b.png" });
      assert.ok(fs.statSync(path.join(videoDir, "Broll")).isDirectory());
      assert.deepEqual(await put(ticket.id, 0, "0123456789"), { received: 10, done: true });
      assert.deepEqual(fs.readdirSync(path.join(videoDir, "Broll")), ["b.png"]);
    });

    test("an existing B-roll folder with another spelling is used", async () => {
      fs.mkdirSync(path.join(videoDir, "B-Roll"));
      const ticket = await create({ folder: "broll", name: "b.png" });
      await put(ticket.id, 0, "0123456789");
      assert.deepEqual(fs.readdirSync(path.join(videoDir, "B-Roll")), ["b.png"]);
      assert.equal(fs.existsSync(path.join(videoDir, "Broll")), false);
    });

    test("refuses names that are not one plain name", async () => {
      for (const name of [
        "../x.mp4",
        "a/b.mp4",
        "..\\x.mp4",
        ".hidden.mp4",
        ".mp4",
        "x\u0000.mp4",
        "a".repeat(250) + ".mp4",
        " lead.mp4",
        "evil‮fdp.mp4",
      ]) {
        await rejectsCode(create({ name }), "invalidInput");
      }
      assert.deepEqual(treeOf(videoDir), []);
      assert.deepEqual(fs.readdirSync(outside), []);
    });

    test("refuses kinds of file that are not accepted", async () => {
      for (const name of [
        "run.exe",
        "script.sh",
        "noextension",
        "archive.zip",
        "x.mp4.exe",
        "x.",
      ]) {
        await rejectsCode(create({ name }), "invalidInput");
      }
      for (const name of ["a.MP4", "b.srt", "c.md", "d.JPG", "e.wav"]) {
        await create({ name });
      }
    });

    test("refuses an empty file and a size that is not a whole number", async () => {
      for (const size of [0, -1, 1.5, Number.NaN, Infinity, 2 ** 60]) {
        await rejectsCode(create({ size }), "invalidInput");
      }
      await rejectsCode(create({ size: 2 ** 50 }), "tooLarge");
    });

    test("refuses more than maxUploadGb", async () => {
      world.settings.update({ maxUploadGb: 1 });
      await create({ size: 1024 ** 3 });
      await rejectsCode(create({ name: "big.mp4", size: 1024 ** 3 + 1 }), "tooLarge");
    });

    test("refuses a file that does not fit on the disk with a gigabyte to spare", async () => {
      world.cleanup();
      world = createWorld({
        storageRoots: ["share"],
        uploadOptions: {
          statfs: () => Promise.resolve({ bavail: 100, bsize: 1024 * 1024 * 1024 }),
        },
      });
      alice = world.makeUser("alice@example.com");
      const dir = world.mkdir("share/c");
      const made = await world.makeChannel(alice, "C", { location: { kind: "link", dir } });
      const video = await world.mod.api.channels.createVideo(alice.id, made.id, "V");
      const request = { videoId: video.id, folder: /** @type {const} */ ("video"), name: "a.mp4" };
      await world.mod.api.uploads.create(alice, { ...request, size: 99 * 1024 ** 3 });
      await rejectsCode(
        world.mod.api.uploads.create(alice, { ...request, name: "b.mp4", size: 100 * 1024 ** 3 }),
        "tooLarge",
      );
    });

    test("a disk that cannot say how much is free is not a reason to refuse", async () => {
      world.cleanup();
      world = createWorld({
        storageRoots: ["share"],
        uploadOptions: { statfs: () => Promise.reject(new Error("no statfs here")) },
      });
      alice = world.makeUser("alice@example.com");
      const dir = world.mkdir("share/c");
      const made = await world.makeChannel(alice, "C", { location: { kind: "link", dir } });
      const video = await world.mod.api.channels.createVideo(alice.id, made.id, "V");
      await world.mod.api.uploads.create(alice, {
        videoId: video.id,
        folder: "video",
        name: "a.mp4",
        size: 5,
      });
    });

    test("refuses a name that exists, and leaves the file as it is", async () => {
      fs.writeFileSync(path.join(videoDir, "clip.mp4"), "mine");
      await rejectsCode(create(), "conflict");
      assert.equal(fs.readFileSync(path.join(videoDir, "clip.mp4"), "utf8"), "mine");
    });

    test("refuses a name that is a link, even a dangling one", async () => {
      fs.symlinkSync(path.join(outside, "target.mp4"), path.join(videoDir, "clip.mp4"));
      await rejectsCode(create(), "conflict");
      assert.deepEqual(fs.readdirSync(outside), []);
    });

    test("refuses a name that is already being uploaded, however it is spelled on this disk", async () => {
      await create();
      await rejectsCode(create({ size: 20 }), "conflict");
      // A different spelling is the same name only on a case-insensitive disk.
      const probe = path.join(videoDir, "case-probe");
      fs.writeFileSync(probe, "");
      const insensitive = fs.existsSync(path.join(videoDir, "CASE-PROBE"));
      fs.rmSync(probe);
      if (insensitive) await rejectsCode(create({ name: "CLIP.MP4" }), "conflict");
    });

    test("an abandoned finished record does not block the name once the file is gone", async () => {
      const ticket = await create();
      await put(ticket.id, 0, "0123456789");
      fs.rmSync(path.join(videoDir, "clip.mp4"));
      const again = await create();
      assert.notEqual(again.id, ticket.id);
    });

    test("another user's video, a missing video and odd ids are notFound", async () => {
      await rejectsCode(create({}, bob), "notFound");
      for (const id of [
        `${channel.id}/Nope`,
        "nochannel/Video 1",
        `${channel.id}/../Video 1`,
        `${channel.id}/`,
        `${channel.id}`,
        "",
        `${channel.id}/Video 1/extra`,
        `${channel.id}/.`,
      ]) {
        await rejectsCode(create({ videoId: id }), "notFound");
      }
      assert.deepEqual(treeOf(videoDir), []);
    });

    test("the answer for another user's video is the same as for a missing one", async () => {
      const foreign = await rejectsCode(create({}, bob), "notFound");
      const missing = await rejectsCode(create({ videoId: `${channel.id}/Nope` }, bob), "notFound");
      assert.equal(foreign.message, missing.message);
    });

    test("a video folder that is a link out is not a video", async () => {
      fs.symlinkSync(outside, path.join(path.dirname(videoDir), "Linked"));
      await rejectsCode(create({ videoId: `${channel.id}/Linked` }), "notFound");
      assert.deepEqual(fs.readdirSync(outside), []);
    });

    test("a B-roll folder that is a link out is refused", async () => {
      fs.symlinkSync(outside, path.join(videoDir, "Broll"));
      await rejectsCode(create({ folder: "broll", name: "x.png" }), "conflict");
      assert.deepEqual(fs.readdirSync(outside), []);
    });
  });

  describe("append", () => {
    test("pieces in order make the file, and the part file goes", async () => {
      const ticket = await create({ size: 10 });
      assert.deepEqual(await put(ticket.id, 0, "01234"), { received: 5, done: false });
      assert.deepEqual(parts().length, 1);
      assert.ok(parts()[0]?.startsWith(".clip.mp4."));
      assert.deepEqual(await put(ticket.id, 5, "56789"), { received: 10, done: true });
      assert.equal(fs.readFileSync(path.join(videoDir, "clip.mp4"), "utf8"), "0123456789");
      assert.deepEqual(fs.readdirSync(videoDir), ["clip.mp4"]);
      assert.deepEqual(await uploads().state(alice.id, ticket.id), {
        received: 10,
        size: 10,
        done: true,
      });
      assert.ok(world.emitted.filter((e) => e.event === "library-changed").length >= 1);
    });

    test("a wrong offset changes nothing and says where the upload is", async () => {
      const ticket = await create({ size: 10 });
      await put(ticket.id, 0, "01234");
      const before = fs.readFileSync(path.join(videoDir, parts()[0] ?? ""), "utf8");
      for (const offset of [0, 3, 6, 10, 99]) {
        const error = await put(ticket.id, offset, "XX").then(
          () => null,
          (e) => e,
        );
        assert.ok(error instanceof OffsetConflict, `offset ${offset}`);
        assert.equal(error.code, "conflict");
        assert.equal(error.received, 5);
      }
      assert.equal(fs.readFileSync(path.join(videoDir, parts()[0] ?? ""), "utf8"), before);
      assert.equal((await uploads().state(alice.id, ticket.id)).received, 5);
    });

    test("an offset that is not a whole number is invalidInput", async () => {
      const ticket = await create();
      for (const offset of [-1, 1.5, Number.NaN]) {
        await rejectsCode(put(ticket.id, offset, "x"), "invalidInput");
      }
      assert.deepEqual(parts(), []);
    });

    test("bytes beyond the declared size are refused and the upload stays resumable", async () => {
      const ticket = await create({ size: 10 });
      await put(ticket.id, 0, "01234");
      // Declared length too long: refused before any byte is written.
      await rejectsCode(put(ticket.id, 5, "56789X"), "invalidInput");
      assert.equal((await uploads().state(alice.id, ticket.id)).received, 5);
      // Length not declared: the bytes that fit are written, then it is cut back.
      const body = bodyOf("567", "89", "TOO MUCH");
      await rejectsCode(
        uploads().append(alice.id, ticket.id, 5, body, { contentLength: null }),
        "invalidInput",
      );
      const part = path.join(videoDir, parts()[0] ?? "");
      assert.equal(fs.readFileSync(part, "utf8"), "01234");
      assert.deepEqual(await put(ticket.id, 5, "56789"), { received: 10, done: true });
      assert.equal(fs.readFileSync(path.join(videoDir, "clip.mp4"), "utf8"), "0123456789");
    });

    test("data after a complete upload is refused", async () => {
      const ticket = await create({ size: 4 });
      await put(ticket.id, 0, "abcd");
      await rejectsCode(put(ticket.id, 4, "e"), "invalidInput");
      assert.equal(fs.readFileSync(path.join(videoDir, "clip.mp4"), "utf8"), "abcd");
    });

    test("a body over the chunk limit is refused with a known length, nothing written", async () => {
      const ticket = await create({ size: 100_000 });
      const big = Buffer.alloc(1025, 1);
      await rejectsCode(
        uploads().append(alice.id, ticket.id, 0, bodyOf(big), { contentLength: big.length }),
        "tooLarge",
      );
      assert.deepEqual(parts(), []);
      assert.equal((await uploads().state(alice.id, ticket.id)).received, 0);
    });

    test("a body over the chunk limit with no length never writes more than the limit", async () => {
      const ticket = await create({ size: 100_000 });
      let most = 0;
      async function* source() {
        for (let index = 0; index < 64; index++) {
          const part = parts()[0];
          if (part) most = Math.max(most, fs.statSync(path.join(videoDir, part)).size);
          yield Buffer.alloc(100, 7);
        }
      }
      await rejectsCode(
        uploads().append(alice.id, ticket.id, 0, Readable.from(source()), { contentLength: null }),
        "tooLarge",
      );
      assert.ok(most <= 1024, `the part file reached ${most} bytes`);
      // Refused: the part file is cut back to what was there before.
      const left = parts()[0];
      assert.equal(left === undefined ? 0 : fs.statSync(path.join(videoDir, left)).size, 0);
      assert.equal((await uploads().state(alice.id, ticket.id)).received, 0);
    });

    test("a request that breaks off keeps what arrived and the upload continues", async () => {
      const ticket = await create({ size: 10 });
      const body = new PassThrough();
      const pending = uploads().append(alice.id, ticket.id, 0, body, { contentLength: null });
      body.write("0123");
      await waitFor(
        () => parts().length === 1 && fs.statSync(path.join(videoDir, parts()[0] ?? "")).size === 4,
      );
      body.destroy(new Error("connection reset"));
      assert.deepEqual(await pending, { received: 4, done: false });
      assert.deepEqual(await uploads().state(alice.id, ticket.id), {
        received: 4,
        size: 10,
        done: false,
      });
      assert.deepEqual(await put(ticket.id, 4, "456789"), { received: 10, done: true });
      assert.equal(fs.readFileSync(path.join(videoDir, "clip.mp4"), "utf8"), "0123456789");
    });

    test("a body that stays silent is cut after the idle time", async () => {
      const ticket = await create({ size: 10 });
      const body = new PassThrough();
      body.write("012");
      const result = await uploads().append(alice.id, ticket.id, 0, body, { contentLength: null });
      assert.deepEqual(result, { received: 3, done: false });
    });

    test("only one request writes an upload at a time", async () => {
      const ticket = await create({ size: 10 });
      const first = new PassThrough();
      const pending = uploads().append(alice.id, ticket.id, 0, first, { contentLength: null });
      first.write("012");
      await waitFor(
        () => parts().length === 1 && fs.statSync(path.join(videoDir, parts()[0] ?? "")).size === 3,
      );
      await rejectsCode(put(ticket.id, 3, "345"), "conflict");
      first.write("345");
      first.end("6789");
      assert.deepEqual(await pending, { received: 10, done: true });
      assert.equal(fs.readFileSync(path.join(videoDir, "clip.mp4"), "utf8"), "0123456789");
    });

    test("a part file that is a link is never written through", async () => {
      const ticket = await create({ size: 10 });
      const target = path.join(outside, "victim.txt");
      fs.writeFileSync(target, "victim");
      fs.symlinkSync(target, path.join(videoDir, `.clip.mp4.${ticket.id}.part`));
      await rejectsCode(put(ticket.id, 0, "01234"), "io");
      assert.equal(fs.readFileSync(target, "utf8"), "victim");
    });

    test("the part file's size is the truth, whatever the row says", async () => {
      const ticket = await create({ size: 10 });
      await put(ticket.id, 0, "01234");
      const part = path.join(videoDir, parts()[0] ?? "");
      fs.truncateSync(part, 2);
      assert.equal((await uploads().state(alice.id, ticket.id)).received, 2);
      await rejectsCode(put(ticket.id, 5, "56789"), "conflict");
      assert.deepEqual(await put(ticket.id, 2, "23456789"), { received: 10, done: true });
      assert.equal(fs.readFileSync(path.join(videoDir, "clip.mp4"), "utf8"), "0123456789");
    });

    test("a part file that vanished starts the upload again from 0", async () => {
      const ticket = await create({ size: 10 });
      await put(ticket.id, 0, "01234");
      fs.rmSync(path.join(videoDir, parts()[0] ?? ""));
      assert.equal((await uploads().state(alice.id, ticket.id)).received, 0);
      assert.deepEqual(await put(ticket.id, 0, "0123456789"), { received: 10, done: true });
    });

    test("a part file bigger than the declared size is a conflict, not a truncation", async () => {
      const ticket = await create({ size: 4 });
      await put(ticket.id, 0, "ab");
      const part = path.join(videoDir, parts()[0] ?? "");
      fs.appendFileSync(part, "cdefgh");
      await rejectsCode(uploads().state(alice.id, ticket.id), "conflict");
      assert.equal(fs.readFileSync(part, "utf8"), "abcdefgh");
    });
  });

  describe("never overwriting", () => {
    test("a file that appears while the upload runs is kept, and so are the bytes", async () => {
      const ticket = await create({ size: 6 });
      await put(ticket.id, 0, "abc");
      hooks.beforeFinalize = ({ final }) => fs.writeFileSync(final, "ATTACKER");
      await rejectsCode(put(ticket.id, 3, "def"), "conflict");
      const final = path.join(videoDir, "clip.mp4");
      assert.equal(fs.readFileSync(final, "utf8"), "ATTACKER");
      // The upload's bytes are still there, so nothing was lost.
      assert.equal(fs.readFileSync(path.join(videoDir, parts()[0] ?? ""), "utf8"), "abcdef");
      // Asking again while the name is taken changes nothing.
      hooks.beforeFinalize = undefined;
      await rejectsCode(
        uploads().append(alice.id, ticket.id, 6, bodyOf(), { contentLength: 0 }),
        "conflict",
      );
      assert.equal(fs.readFileSync(final, "utf8"), "ATTACKER");
    });

    test("once the name is free again an empty request finishes the upload", async () => {
      const ticket = await create({ size: 6 });
      hooks.beforeFinalize = ({ final }) => fs.writeFileSync(final, "ATTACKER");
      await put(ticket.id, 0, "abcdef").catch(() => {});
      hooks.beforeFinalize = undefined;
      fs.rmSync(path.join(videoDir, "clip.mp4"));
      const done = await uploads().append(alice.id, ticket.id, 6, bodyOf(), { contentLength: 0 });
      assert.deepEqual(done, { received: 6, done: true });
      assert.equal(fs.readFileSync(path.join(videoDir, "clip.mp4"), "utf8"), "abcdef");
      assert.deepEqual(parts(), []);
    });

    test("a link planted at the final name is not followed and not replaced", async () => {
      const victim = path.join(outside, "victim.mp4");
      fs.writeFileSync(victim, "victim");
      const ticket = await create({ size: 3 });
      hooks.beforeFinalize = ({ final }) => fs.symlinkSync(victim, final);
      await rejectsCode(put(ticket.id, 0, "abc"), "conflict");
      assert.equal(fs.readFileSync(victim, "utf8"), "victim");
      assert.equal(fs.lstatSync(path.join(videoDir, "clip.mp4")).isSymbolicLink(), true);
    });

    test("a dangling link planted at the final name is not written through", async () => {
      const target = path.join(outside, "new.mp4");
      const ticket = await create({ size: 3 });
      hooks.beforeFinalize = ({ final }) => fs.symlinkSync(target, final);
      await rejectsCode(put(ticket.id, 0, "abc"), "conflict");
      assert.equal(fs.existsSync(target), false);
    });

    test("a directory planted at the final name is not replaced", async () => {
      const ticket = await create({ size: 3 });
      hooks.beforeFinalize = ({ final }) => fs.mkdirSync(final);
      await rejectsCode(put(ticket.id, 0, "abc"), "conflict");
      assert.ok(fs.statSync(path.join(videoDir, "clip.mp4")).isDirectory());
    });

    test("two uploads of one name cannot both be made, the second is refused at create", async () => {
      const first = await create({ size: 3 });
      await rejectsCode(create({ size: 3 }), "conflict");
      assert.deepEqual(await put(first.id, 0, "abc"), { received: 3, done: true });
      await rejectsCode(create({ size: 3 }), "conflict");
      assert.equal(fs.readFileSync(path.join(videoDir, "clip.mp4"), "utf8"), "abc");
    });
  });

  describe("cancel", () => {
    test("deletes the hidden part file and the row, nothing else", async () => {
      fs.writeFileSync(path.join(videoDir, "keep.mp4"), "keep");
      fs.mkdirSync(path.join(videoDir, "Sub"));
      fs.writeFileSync(path.join(videoDir, "Sub", "inner.txt"), "inner");
      const ticket = await create({ size: 10 });
      await put(ticket.id, 0, "01234");
      const before = treeOf(videoDir).filter((entry) => !entry.endsWith(".part"));
      await uploads().cancel(alice.id, ticket.id);
      assert.deepEqual(treeOf(videoDir), before);
      assert.equal(fs.readFileSync(path.join(videoDir, "keep.mp4"), "utf8"), "keep");
      await rejectsCode(uploads().state(alice.id, ticket.id), "notFound");
      await rejectsCode(uploads().cancel(alice.id, ticket.id), "notFound");
    });

    test("the finished file of a finished upload is not touched by a later cancel", async () => {
      const ticket = await create({ size: 3 });
      await put(ticket.id, 0, "abc");
      await uploads().cancel(alice.id, ticket.id);
      assert.equal(fs.readFileSync(path.join(videoDir, "clip.mp4"), "utf8"), "abc");
    });

    test("stops a request that is writing", async () => {
      const ticket = await create({ size: 10 });
      const body = new PassThrough();
      const outcome = rejectsCode(
        uploads().append(alice.id, ticket.id, 0, body, { contentLength: null }),
        "conflict",
      );
      body.write("012");
      await waitFor(
        () => parts().length === 1 && fs.statSync(path.join(videoDir, parts()[0] ?? "")).size === 3,
      );
      await uploads().cancel(alice.id, ticket.id);
      await outcome;
      assert.deepEqual(parts(), []);
      assert.deepEqual(fs.readdirSync(videoDir), []);
    });

    test("a cancel of a part file that is a link removes the link, not what it points to", async () => {
      const ticket = await create({ size: 10 });
      const target = path.join(outside, "victim.txt");
      fs.writeFileSync(target, "victim");
      fs.symlinkSync(target, path.join(videoDir, `.clip.mp4.${ticket.id}.part`));
      await uploads().cancel(alice.id, ticket.id);
      assert.equal(fs.readFileSync(target, "utf8"), "victim");
    });
  });

  describe("another user's uploads", () => {
    test("are not found, by any call, and nothing changes", async () => {
      const ticket = await create({ size: 10 });
      await put(ticket.id, 0, "01234");
      const before = treeOf(videoDir);
      await rejectsCode(uploads().state(bob.id, ticket.id), "notFound");
      await rejectsCode(put(ticket.id, 5, "56789", bob), "notFound");
      await rejectsCode(uploads().cancel(bob.id, ticket.id), "notFound");
      assert.deepEqual(treeOf(videoDir), before);
      assert.equal((await uploads().state(alice.id, ticket.id)).received, 5);
    });

    test("unknown and odd ids are notFound too", async () => {
      for (const id of ["", "x", "../x", "0".repeat(32), "z".repeat(5000)]) {
        await rejectsCode(uploads().state(alice.id, id), "notFound");
      }
    });

    test("the answer for a stranger's upload equals the answer for none", async () => {
      const ticket = await create();
      const foreign = await rejectsCode(uploads().state(bob.id, ticket.id), "notFound");
      const missing = await rejectsCode(uploads().state(bob.id, "0".repeat(32)), "notFound");
      assert.equal(foreign.message, missing.message);
    });
  });

  describe("rows never take user files with them", () => {
    test("deleting the upload or channel rows leaves every file", async () => {
      fs.writeFileSync(path.join(videoDir, "keep.mp4"), "keep");
      const ticket = await create({ size: 10 });
      await put(ticket.id, 0, "01234");
      const before = treeOf(world.root);
      world.db.run("DELETE FROM uploads");
      world.db.run("DELETE FROM channels");
      assert.deepEqual(treeOf(world.root), before);
    });

    test("removing a channel cancels its uploads, which removes only their part files", async () => {
      fs.writeFileSync(path.join(videoDir, "keep.mp4"), "keep");
      const ticket = await create({ size: 10 });
      await put(ticket.id, 0, "01234");
      await world.mod.api.channels.remove(alice.id, channel.id);
      assert.deepEqual(fs.readdirSync(videoDir), ["keep.mp4"]);
      assert.equal(world.db.all("SELECT id FROM uploads").length, 0);
    });

    test("removing an account's uploads removes only their part files", async () => {
      fs.writeFileSync(path.join(videoDir, "keep.mp4"), "keep");
      const ticket = await create({ size: 10 });
      await put(ticket.id, 0, "01234");
      await world.mod.hooks.onUserDisabled(alice.id);
      assert.deepEqual(fs.readdirSync(videoDir), ["keep.mp4"]);
      await rejectsCode(uploads().state(alice.id, ticket.id), "notFound");
    });
  });

  describe("cleanup of stale uploads", () => {
    test("removes uploads untouched for a day, with their part files, and keeps fresh ones", async () => {
      const stale = await create({ name: "stale.mp4", size: 10 });
      await put(stale.id, 0, "01234");
      world.clock.advance(23 * 60 * 60 * 1000);
      const fresh = await create({ name: "fresh.mp4", size: 10 });
      await put(fresh.id, 0, "01234");
      world.clock.advance(2 * 60 * 60 * 1000);
      await uploads().cleanup();
      await rejectsCode(uploads().state(alice.id, stale.id), "notFound");
      assert.equal((await uploads().state(alice.id, fresh.id)).received, 5);
      assert.deepEqual(
        parts().map((name) => name.split(".")[1]),
        ["fresh"],
      );
    });

    test("an upload that is receiving is not cleaned up", async () => {
      const ticket = await create({ size: 10 });
      const body = new PassThrough();
      const pending = uploads().append(alice.id, ticket.id, 0, body, { contentLength: null });
      body.write("012");
      await waitFor(
        () => parts().length === 1 && fs.statSync(path.join(videoDir, parts()[0] ?? "")).size === 3,
      );
      world.clock.advance(48 * 60 * 60 * 1000);
      await uploads().cleanup();
      assert.equal(parts().length, 1);
      body.end("3456789");
      assert.deepEqual(await pending, { received: 10, done: true });
    });

    test("start cleans up now and then on a timer until stop", async () => {
      /** @type {(() => void)[]} */
      const ticks = [];
      let cleared = 0;
      world.cleanup();
      world = createWorld({
        storageRoots: ["share"],
        uploadOptions: {
          cleanupIntervalMs: 1234,
          timers: {
            setInterval: (/** @type {() => void} */ callback, /** @type {number} */ ms) => {
              assert.equal(ms, 1234);
              ticks.push(callback);
              return { unref() {} };
            },
            clearInterval: () => void (cleared += 1),
            setTimeout,
            clearTimeout,
          },
        },
      });
      alice = world.makeUser("alice@example.com");
      const dir = world.mkdir("share/c");
      const made = await world.makeChannel(alice, "C", { location: { kind: "link", dir } });
      const video = await world.mod.api.channels.createVideo(alice.id, made.id, "V");
      const ticket = await world.mod.api.uploads.create(alice, {
        videoId: video.id,
        folder: "video",
        name: "a.mp4",
        size: 5,
      });
      world.clock.advance(25 * 60 * 60 * 1000);
      await world.mod.start();
      await rejectsCode(world.mod.api.uploads.state(alice.id, ticket.id), "notFound");
      assert.equal(ticks.length, 1);
      world.mod.stop();
      assert.equal(cleared, 1);
    });
  });

  test("uploadsInProgress counts the unfinished uploads of a video", async () => {
    const a = await create({ name: "a.mp4", size: 3 });
    await create({ name: "b.mp4", size: 3 });
    const count = () => world.mod.api.uploadsInProgress(channel.id, "Video 1");
    assert.equal(count(), 2);
    await put(a.id, 0, "abc");
    assert.equal(count(), 1);
  });
});

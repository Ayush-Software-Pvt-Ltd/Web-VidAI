// The in-page folder picker (SPEC section 6): what it shows and what it refuses.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createWorld, rejectsCode } from "./support.js";

describe("the folder picker", () => {
  /** @type {ReturnType<typeof createWorld>} */
  let world;
  /** @type {string} */
  let share;
  /** @type {string} */
  let outside;
  /** @type {{ id: string, email: string }} */
  let alice;
  /** @type {{ id: string, email: string }} */
  let bob;

  before(() => {
    world = createWorld({ storageRoots: ["share"] });
    share = path.join(world.root, "share");
    outside = world.mkdir("outside");
    alice = world.makeUser("alice@example.com");
    bob = world.makeUser("bob@example.com");
  });
  after(() => world.cleanup());

  /** @param {{ id: string }} user @param {string | null} target */
  const list = (user, target) =>
    world.callRpc(user, "fsList", target === null ? {} : { path: target });

  test("the places are the personal folder, then the storage folders", async () => {
    const places = /** @type {any[]} */ (await world.callRpc(alice, "fsPlaces"));
    assert.deepEqual(
      places.map((place) => [place.name, place.kind, place.available]),
      [
        ["My folder", "personal", true],
        ["Server storage", "storage", true],
        ["share", "storage", true],
      ],
    );
    assert.equal(places[0].path, path.join(world.dataDir, "media", alice.id));
    assert.equal(places[2].path, share);
  });

  test("listing nothing lists the personal folder", async () => {
    const listing = /** @type {any} */ (await list(alice, null));
    assert.equal(listing.path, path.join(world.dataDir, "media", alice.id));
    assert.deepEqual(listing.entries, []);
    assert.equal(listing.videoCount, 0);
    assert.equal(listing.parent, path.join(world.dataDir, "media"));
  });

  test("only folders are listed, in natural order, with hidden ones and links left out", async () => {
    const base = path.join(share, "listing");
    for (const name of ["Video 10", "video 2", "Video 1", ".hidden", "Zed"]) {
      fs.mkdirSync(path.join(base, name), { recursive: true });
    }
    fs.writeFileSync(path.join(base, "clip.MP4"), "x");
    fs.writeFileSync(path.join(base, "other.mov"), "x");
    fs.writeFileSync(path.join(base, "notes.txt"), "x");
    fs.writeFileSync(path.join(base, ".hidden.mp4"), "x");
    fs.symlinkSync(outside, path.join(base, "link-out"));
    fs.symlinkSync(path.join(base, "Zed"), path.join(base, "link-in"));
    const listing = /** @type {any} */ (await list(alice, base));
    assert.deepEqual(
      listing.entries.map((/** @type {{ name: string }} */ entry) => entry.name),
      ["Video 1", "video 2", "Video 10", "Zed"],
    );
    assert.ok(
      listing.entries.every((/** @type {{ taken: boolean }} */ entry) => entry.taken === false),
    );
    assert.equal(listing.entries[0].path, path.join(base, "Video 1"));
    assert.equal(listing.videoCount, 3);
    assert.equal(listing.parent, share);
  });

  test("a storage folder has no parent", async () => {
    assert.equal(/** @type {any} */ (await list(alice, share)).parent, null);
    assert.equal(
      /** @type {any} */ (await list(alice, path.join(world.dataDir, "media"))).parent,
      null,
    );
  });

  test("other places are refused, and the answer is the same for all of them", async () => {
    const errors = [
      await rejectsCode(list(alice, outside), "forbidden"),
      await rejectsCode(list(alice, "/"), "forbidden"),
      await rejectsCode(list(alice, `${share}/../outside`), "forbidden"),
      await rejectsCode(list(alice, world.dataDir), "forbidden"),
    ];
    for (const error of errors) assert.equal(error.message, errors[0]?.message);
    fs.symlinkSync(outside, path.join(share, "escape"));
    await rejectsCode(list(alice, path.join(share, "escape")), "forbidden");
  });

  test("a file or a missing folder is invalidInput", async () => {
    const file = path.join(share, "a-file.txt");
    fs.writeFileSync(file, "x");
    await rejectsCode(list(alice, file), "invalidInput");
    await rejectsCode(list(alice, path.join(share, "missing")), "invalidInput");
    await rejectsCode(list(alice, "relative"), "invalidInput");
  });

  test("other users' personal folders are not listed at the media root and not enterable", async () => {
    await world.callRpc(bob, "fsPlaces");
    const listing = /** @type {any} */ (await list(alice, path.join(world.dataDir, "media")));
    const names = listing.entries.map((/** @type {any} */ entry) => entry.name);
    assert.ok(names.includes(alice.id));
    assert.ok(!names.includes(bob.id));
    await rejectsCode(list(alice, path.join(world.dataDir, "media", bob.id)), "forbidden");
  });

  test("channels mark their folders as taken and strangers cannot look inside", async () => {
    const channel = /** @type {any} */ (await world.makeChannel(alice, "Taken Channel"));
    const parent = /** @type {any} */ (await list(alice, path.dirname(channel.dir)));
    const entry = parent.entries.find((/** @type {any} */ e) => e.path === channel.dir);
    assert.equal(entry.taken, true);
    // Its owner can look inside.
    fs.mkdirSync(path.join(channel.dir, "Video A"));
    const inside = /** @type {any} */ (await list(alice, channel.dir));
    assert.deepEqual(
      inside.entries.map((/** @type {any} */ e) => e.name),
      ["Video A"],
    );
    // A folder that contains a channel is taken too (the parent of a channel at the share).
    fs.mkdirSync(path.join(share, "holder", "ch"), { recursive: true });
    await world.makeChannel(bob, "Bobs", {
      location: { kind: "link", dir: path.join(share, "holder", "ch") },
    });
    const holder = /** @type {any} */ (await list(alice, share));
    assert.equal(holder.entries.find((/** @type {any} */ e) => e.name === "holder").taken, true);
    // Alice cannot look inside Bob's channel, nor into where it is made.
    await rejectsCode(list(alice, path.join(share, "holder", "ch")), "conflict");
    await rejectsCode(list(alice, path.join(share, "holder", "ch", "sub")), "conflict");
  });

  test("the refusal for a stranger's channel does not name the owner", async () => {
    const error = await rejectsCode(list(alice, path.join(share, "holder", "ch")), "conflict");
    assert.ok(!error.message.includes("bob"));
    assert.equal(error.message, "This folder already belongs to a channel.");
  });
});

describe("making folders in the picker", () => {
  /** @type {ReturnType<typeof createWorld>} */
  let world;
  /** @type {string} */
  let share;
  /** @type {{ id: string, email: string }} */
  let alice;
  /** @type {{ id: string, email: string }} */
  let bob;

  before(() => {
    world = createWorld({ storageRoots: ["share"] });
    share = path.join(world.root, "share");
    alice = world.makeUser("alice@example.com");
    bob = world.makeUser("bob@example.com");
  });
  after(() => world.cleanup());

  /** @param {{ id: string }} user @param {string} parent @param {string} name */
  const make = (user, parent, name) => world.callRpc(user, "fsCreateFolder", { parent, name });

  test("makes the folder and answers its path", async () => {
    const result = /** @type {any} */ (await make(alice, share, "New folder"));
    assert.equal(result.path, path.join(share, "New folder"));
    assert.ok(fs.statSync(result.path).isDirectory());
  });

  test("an existing name is conflict and nothing changes", async () => {
    await rejectsCode(make(alice, share, "New folder"), "conflict");
  });

  test("names that are not one plain name are invalidInput", async () => {
    const before = fs.readdirSync(share).length;
    for (const bad of ["..", ".", "a/b", "a\\b", ".hidden", " lead", "x\u0000y", "a".repeat(121)]) {
      await rejectsCode(make(alice, share, bad), "invalidInput");
    }
    assert.equal(fs.readdirSync(share).length, before);
  });

  test("outside the storage folders is forbidden, links included", async () => {
    const outside = world.mkdir("outside");
    await rejectsCode(make(alice, outside, "x"), "forbidden");
    await rejectsCode(make(alice, `${share}/..`, "x"), "forbidden");
    fs.symlinkSync(outside, path.join(share, "link"));
    await rejectsCode(make(alice, path.join(share, "link"), "x"), "forbidden");
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  test("another user's personal folder is forbidden", async () => {
    const bobFolder = await world.mod.api.roots.personalFolder(bob.id);
    await rejectsCode(make(alice, bobFolder, "x"), "forbidden");
    assert.deepEqual(fs.readdirSync(bobFolder), []);
  });

  test("a missing parent or a file as parent is invalidInput", async () => {
    await rejectsCode(make(alice, path.join(share, "nope", "deeper"), "x"), "invalidInput");
    assert.equal(fs.existsSync(path.join(share, "nope")), false);
    const file = path.join(share, "file.txt");
    fs.writeFileSync(file, "x");
    await rejectsCode(make(alice, file, "x"), "invalidInput");
  });

  test("nothing can be made inside a channel", async () => {
    const dir = world.mkdir("share/chan");
    await world.makeChannel(alice, "Chan", { location: { kind: "link", dir } });
    await rejectsCode(make(alice, dir, "Video"), "conflict");
    await rejectsCode(make(bob, dir, "Video"), "conflict");
    await rejectsCode(make(bob, path.join(dir, "deeper"), "Video"), "conflict");
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

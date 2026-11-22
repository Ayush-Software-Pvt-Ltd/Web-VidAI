// The admin's folder picker (SPEC section 6, "Folders on the server"): what it shows, what it
// marks as taken and who may use it.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createWorld, rejectsCode } from "./support.js";

describe("the folder picker", () => {
  /** @type {ReturnType<typeof createWorld>} */
  let world;
  /** @type {string} */
  let area;
  /** @type {{ id: string, email: string, role: "admin" }} */
  let admin;
  /** @type {{ id: string, email: string }} */
  let alice;

  before(() => {
    world = createWorld();
    area = world.mkdir("area");
    admin = /** @type {never} */ (world.makeAdmin("admin@example.com"));
    alice = world.makeUser("alice@example.com");
  });
  after(() => world.cleanup());

  /** @param {string | null} target */
  const list = (target) => world.callRpc(admin, "fsList", target === null ? {} : { path: target });

  test("the places are home, the startup drive and the other volumes", async () => {
    // The startup volume shows up in the volumes folder as a link to `/`.
    fs.symlinkSync("/", path.join(world.volumesDir, "Startup Disk"));
    fs.mkdirSync(path.join(world.volumesDir, "Backup SSD"));
    fs.mkdirSync(path.join(world.volumesDir, ".hidden volume"));
    fs.writeFileSync(path.join(world.volumesDir, ".DS_Store"), "x");
    fs.writeFileSync(path.join(world.volumesDir, "stray file"), "x");
    const places = /** @type {any[]} */ (await world.callRpc(admin, "fsPlaces"));
    assert.deepEqual(
      places.map((place) => [place.name, place.path, place.kind, place.available]),
      [
        ["Home", world.homeDir, "home", true],
        ["Startup Disk", "/", "drive", true],
        ["Backup SSD", path.join(world.volumesDir, "Backup SSD"), "volume", true],
      ],
    );
  });

  test("a volume that cannot be read is listed as unavailable", async (t) => {
    if (process.getuid?.() === 0) return t.skip("root can read everything");
    const locked = path.join(world.volumesDir, "Locked");
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      const places = /** @type {any[]} */ (await world.callRpc(admin, "fsPlaces"));
      assert.equal(places.find((place) => place.name === "Locked")?.available, false);
    } finally {
      fs.chmodSync(locked, 0o700);
      fs.rmdirSync(locked);
    }
  });

  test("listing nothing lists the home folder", async () => {
    fs.mkdirSync(path.join(world.homeDir, "Movies"));
    const listing = /** @type {any} */ (await list(null));
    assert.equal(listing.path, world.homeDir);
    assert.equal(listing.parent, path.dirname(world.homeDir));
    assert.deepEqual(
      listing.entries.map((/** @type {{ name: string }} */ entry) => entry.name),
      ["Movies"],
    );
  });

  test("only folders are listed, in natural order, with hidden ones and broken links left out", async () => {
    const base = path.join(area, "listing");
    for (const name of ["Video 10", "video 2", "Video 1", ".hidden", "Zed"]) {
      fs.mkdirSync(path.join(base, name), { recursive: true });
    }
    fs.writeFileSync(path.join(base, "clip.MP4"), "x");
    fs.writeFileSync(path.join(base, "other.mov"), "x");
    fs.writeFileSync(path.join(base, "notes.txt"), "x");
    fs.writeFileSync(path.join(base, ".hidden.mp4"), "x");
    const outside = world.mkdir("outside-listing");
    fs.symlinkSync(outside, path.join(base, "Alias"));
    fs.symlinkSync(path.join(base, "notes.txt"), path.join(base, "file-link"));
    fs.symlinkSync(path.join(base, "gone"), path.join(base, "broken-link"));
    const listing = /** @type {any} */ (await list(base));
    assert.deepEqual(
      listing.entries.map((/** @type {{ name: string }} */ entry) => entry.name),
      ["Alias", "Video 1", "video 2", "Video 10", "Zed"],
    );
    // A link to a folder stands for its target.
    assert.equal(listing.entries[0].path, outside);
    assert.equal(listing.entries[1].path, path.join(base, "Video 1"));
    assert.ok(
      listing.entries.every((/** @type {{ taken: boolean }} */ entry) => entry.taken === false),
    );
    assert.equal(listing.videoCount, 2, "hidden files are not footage");
    assert.equal(listing.parent, area);
  });

  test("the top of a drive and of a volume has no parent", async () => {
    assert.equal(/** @type {any} */ (await list("/")).parent, null);
    const volume = path.join(world.volumesDir, "Backup SSD");
    fs.mkdirSync(path.join(volume, "inside"), { recursive: true });
    const top = /** @type {any} */ (await list(volume));
    assert.equal(top.parent, null);
    assert.equal(/** @type {any} */ (await list(path.join(volume, "inside"))).parent, volume);
  });

  test("a folder that is, holds or lies inside a channel, or the data directory, is taken", async () => {
    const holder = world.mkdir("holder");
    const dir = world.mkdir("holder/channel");
    const owner = world.makeUser("owner@example.com");
    await world.makeChannel(owner, "Taken Channel", { dir });
    fs.mkdirSync(path.join(dir, "Video A"));
    fs.mkdirSync(path.join(holder, "free"));
    const around = /** @type {any} */ (await list(holder));
    const flags = Object.fromEntries(
      around.entries.map((/** @type {any} */ e) => [e.name, e.taken]),
    );
    assert.deepEqual(flags, { channel: true, free: false });
    const inside = /** @type {any} */ (await list(dir));
    assert.deepEqual(
      inside.entries.map((/** @type {any} */ e) => [e.name, e.taken]),
      [["Video A", true]],
    );
    // The folder that holds the channel is taken in its parent's listing; the data directory too.
    const top = /** @type {any} */ (await list(world.root));
    const named = Object.fromEntries(top.entries.map((/** @type {any} */ e) => [e.name, e.taken]));
    assert.equal(named["holder"], true);
    assert.equal(named["data"], true);
    assert.equal(named["area"], false);
    fs.mkdirSync(path.join(world.dataDir, "inner"));
    const data = /** @type {any} */ (await list(world.dataDir));
    assert.ok(data.entries.length > 0);
    assert.ok(data.entries.every((/** @type {any} */ e) => e.taken === true));
  });

  test("a missing folder, a file and a folder that cannot be read are notFound", async (t) => {
    const file = path.join(area, "a-file.txt");
    fs.writeFileSync(file, "x");
    await rejectsCode(list(file), "notFound");
    await rejectsCode(list(path.join(area, "missing")), "notFound");
    await rejectsCode(list(path.join(area, "missing", "deeper")), "notFound");
    if (process.getuid?.() !== 0) {
      const locked = world.mkdir("locked");
      fs.chmodSync(locked, 0o000);
      try {
        await rejectsCode(list(locked), "notFound");
      } finally {
        fs.chmodSync(locked, 0o700);
      }
    } else {
      t.diagnostic("root can read everything, locked folder not tried");
    }
  });

  test("text that is no full path is invalidInput and .. is forbidden", async () => {
    await rejectsCode(list("relative"), "invalidInput");
    await rejectsCode(list(`${area}/../area`), "forbidden");
  });

  test("a user is forbidden from every function, whatever the path", async () => {
    await rejectsCode(world.callRpc(alice, "fsPlaces"), "forbidden");
    await rejectsCode(world.callRpc(alice, "fsList", {}), "forbidden");
    await rejectsCode(world.callRpc(alice, "fsList", { path: area }), "forbidden");
    await rejectsCode(world.callRpc(alice, "fsList", { path: "/" }), "forbidden");
    await rejectsCode(
      world.callRpc(alice, "fsCreateFolder", { parent: area, name: "By Alice" }),
      "forbidden",
    );
    assert.equal(fs.existsSync(path.join(area, "By Alice")), false);
  });
});

describe("making folders in the picker", () => {
  /** @type {ReturnType<typeof createWorld>} */
  let world;
  /** @type {string} */
  let area;
  /** @type {{ id: string, email: string }} */
  let admin;

  before(() => {
    world = createWorld();
    area = world.mkdir("area");
    admin = world.makeAdmin("admin@example.com");
  });
  after(() => world.cleanup());

  /** @param {string} parent @param {string} name */
  const make = (parent, name) => world.callRpc(admin, "fsCreateFolder", { parent, name });

  test("makes the folder anywhere and answers its path", async () => {
    const result = /** @type {any} */ (await make(area, "New folder"));
    assert.equal(result.path, path.join(area, "New folder"));
    assert.ok(fs.statSync(result.path).isDirectory());
    const home = /** @type {any} */ (await make(world.homeDir, "In home"));
    assert.equal(home.path, path.join(world.homeDir, "In home"));
  });

  test("an existing name is conflict and nothing changes", async () => {
    await rejectsCode(make(area, "New folder"), "conflict");
  });

  test("names that are not one plain name are invalidInput", async () => {
    const before = fs.readdirSync(area).length;
    for (const bad of ["..", ".", "a/b", "a\\b", ".hidden", " lead", "x\u0000y", "a".repeat(121)]) {
      await rejectsCode(make(area, bad), "invalidInput");
    }
    assert.equal(fs.readdirSync(area).length, before);
  });

  test("never inside the data directory", async () => {
    const before = fs.readdirSync(world.dataDir);
    const error = await rejectsCode(make(world.dataDir, "x"), "invalidInput");
    assert.equal(error.message, "This folder belongs to VidAI's own data.");
    await rejectsCode(make(path.join(world.dataDir, "deeper", "still"), "x"), "invalidInput");
    // A link into it does not help.
    fs.symlinkSync(world.dataDir, path.join(area, "data-link"));
    await rejectsCode(make(path.join(area, "data-link"), "x"), "invalidInput");
    assert.deepEqual(fs.readdirSync(world.dataDir), before);
    // The folder around it is fine.
    await make(world.root, "Next to data");
  });

  test("a missing parent or a file as parent is invalidInput", async () => {
    await rejectsCode(make(path.join(area, "nope", "deeper"), "x"), "invalidInput");
    assert.equal(fs.existsSync(path.join(area, "nope")), false);
    const file = path.join(area, "file.txt");
    fs.writeFileSync(file, "x");
    await rejectsCode(make(file, "x"), "invalidInput");
  });
});

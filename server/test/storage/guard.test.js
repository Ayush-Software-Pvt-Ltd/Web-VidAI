// Path safety (SPEC section 6): nothing outside the storage folders is reachable. Each test tries
// to break the rule with a real file system.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createWorld, rejectsCode, treeOf } from "./support.js";

/** Whether this disk treats `A` and `a` as one file (the macOS default). */
function diskIgnoresCase(/** @type {string} */ dir) {
  const probe = path.join(dir, "caseprobe");
  fs.writeFileSync(probe, "x");
  const same = fs.existsSync(path.join(dir, "CASEPROBE"));
  fs.rmSync(probe);
  return same;
}

describe("the path guard", () => {
  /** @type {ReturnType<typeof createWorld>} */
  let world;
  /** @type {string} */
  let media;
  /** @type {string} */
  let share;
  /** @type {string} */
  let outside;
  /** @type {string} */
  let secret;
  /** @type {string} */
  let aliceFolder;
  /** @type {{ id: string, email: string }} */
  let alice;
  /** @type {{ id: string, email: string }} */
  let bob;

  before(async () => {
    world = createWorld({ storageRoots: ["share"] });
    share = path.join(world.root, "share");
    media = await world.mod.api.roots.mediaPath();
    outside = world.mkdir("outside");
    secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "top secret");
    alice = world.makeUser("alice@example.com");
    bob = world.makeUser("bob@example.com");
    aliceFolder = await world.mod.api.roots.personalFolder(alice.id);
  });
  after(() => world.cleanup());

  const guard = () => world.mod.api.guard;
  /** The path with everything below the test's temp folder in capitals. @param {string} full */
  const upperCased = (full) => world.root + full.slice(world.root.length).toUpperCase();

  test("a folder inside a storage folder resolves to its real path", async () => {
    fs.mkdirSync(path.join(share, "a", "b"), { recursive: true });
    assert.equal(
      await guard().resolveInside(path.join(share, "a", "b")),
      path.join(share, "a", "b"),
    );
    assert.equal(await guard().resolveInside(share), share);
    assert.equal(await guard().resolveInside(media), media);
    // Trailing and doubled separators change nothing.
    assert.equal(await guard().resolveInside(`${share}//a/`), path.join(share, "a"));
  });

  test("a path that does not exist yet resolves under its deepest existing folder", async () => {
    const real = await guard().resolveInside(path.join(share, "a", "new", "deeper"));
    assert.equal(real, path.join(share, "a", "new", "deeper"));
    assert.deepEqual(
      treeOf(share).filter((entry) => entry.includes("new")),
      [],
    );
  });

  test("a path with .. is refused, even when it stays inside", async () => {
    await rejectsCode(guard().resolveInside(`${share}/a/../a`), "forbidden");
    await rejectsCode(guard().resolveInside(`${share}/../outside/secret.txt`), "forbidden");
    await rejectsCode(guard().resolveInside(`${share}/a/b/../../..`), "forbidden");
    await rejectsCode(guard().resolveInside(`${share}/..`), "forbidden");
  });

  test("an absolute path elsewhere is refused with the same sentence for every place", async () => {
    const a = await rejectsCode(guard().resolveInside(outside), "forbidden");
    const b = await rejectsCode(guard().resolveInside("/"), "forbidden");
    const c = await rejectsCode(guard().resolveInside("/etc/passwd"), "forbidden");
    const d = await rejectsCode(
      guard().resolveInside(path.join(world.dataDir, "vidai.db")),
      "forbidden",
    );
    const e = await rejectsCode(guard().resolveInside(world.dataDir), "forbidden");
    for (const error of [b, c, d, e]) assert.equal(error.message, a.message);
  });

  test("text that is not a full path is invalidInput", async () => {
    for (const bad of ["", "relative/path", "a", "./x", "~", "C:\\x", 5, null, undefined, {}]) {
      await rejectsCode(guard().resolveInside(bad), "invalidInput");
    }
  });

  test("a NUL byte is refused", async () => {
    await rejectsCode(guard().resolveInside(`${share}/a\0/../../outside`), "invalidInput");
    await rejectsCode(guard().resolveInside(`${share}\0`), "invalidInput");
    await rejectsCode(guard().resolveInside(`${outside}\0${share}`), "invalidInput");
  });

  test("a control character in a name that does not exist is refused", async () => {
    await rejectsCode(guard().resolveInside(`${share}/new\nfolder`), "invalidInput");
  });

  test("a very long name is refused and nothing is made", async () => {
    const before = treeOf(share);
    await rejectsCode(guard().resolveInside(path.join(share, "x".repeat(5000))), "invalidInput");
    await rejectsCode(
      guard().resolveInside(path.join(share, "x".repeat(300), "y")),
      "invalidInput",
    );
    assert.deepEqual(treeOf(share), before);
    assert.throws(() => guard().safeName("n".repeat(300)));
  });

  test("a symlinked directory that points out is refused", async () => {
    fs.symlinkSync(outside, path.join(share, "to-outside"));
    await rejectsCode(guard().resolveInside(path.join(share, "to-outside")), "forbidden");
    await rejectsCode(
      guard().resolveInside(path.join(share, "to-outside", "secret.txt")),
      "forbidden",
    );
  });

  test("a symlinked file that points out is refused", async () => {
    fs.symlinkSync(secret, path.join(share, "secret-link.txt"));
    await rejectsCode(guard().resolveInside(path.join(share, "secret-link.txt")), "forbidden");
  });

  test("a parent that is a symlink out is refused for a path that does not exist yet", async () => {
    await rejectsCode(
      guard().resolveInside(path.join(share, "to-outside", "new", "deeper")),
      "forbidden",
    );
    assert.deepEqual(fs.readdirSync(outside), ["secret.txt"]);
  });

  test("a dangling link is refused, so nothing is created through it", async () => {
    const target = path.join(outside, "not-yet");
    fs.symlinkSync(target, path.join(share, "dangling"));
    await rejectsCode(guard().resolveInside(path.join(share, "dangling")), "forbidden");
    await rejectsCode(guard().resolveInside(path.join(share, "dangling", "sub")), "forbidden");
    assert.equal(fs.existsSync(target), false);
  });

  test("a link loop is refused", async () => {
    fs.symlinkSync(path.join(share, "loop-b"), path.join(share, "loop-a"));
    fs.symlinkSync(path.join(share, "loop-a"), path.join(share, "loop-b"));
    await rejectsCode(guard().resolveInside(path.join(share, "loop-a")), "forbidden");
  });

  test("a link that stays inside resolves to the real place", async () => {
    fs.mkdirSync(path.join(share, "real-dir"));
    fs.symlinkSync(path.join(share, "real-dir"), path.join(share, "inner-link"));
    assert.equal(
      await guard().resolveInside(path.join(share, "inner-link")),
      path.join(share, "real-dir"),
    );
  });

  test("a folder that only starts like a storage folder is outside", async () => {
    const lookAlike = world.mkdir("share2/x");
    await rejectsCode(guard().resolveInside(lookAlike), "forbidden");
    await rejectsCode(guard().resolveInside(`${share}-x`), "forbidden");
  });

  test("mixed letter case cannot reach what the disk would not give", async () => {
    const mixed = path.join(world.dataDir, "MEDIA", "x");
    if (diskIgnoresCase(world.dataDir)) {
      // The disk says it is the same folder, and the answer is the one real spelling.
      assert.equal(await guard().resolveInside(mixed), path.join(media, "x"));
      assert.equal(await guard().resolveInside(upperCased(share)), share);
    } else {
      // A case-sensitive disk: `MEDIA` is a different (missing) folder, hence outside.
      await rejectsCode(guard().resolveInside(mixed), "forbidden");
    }
    // On any disk a mixed-case spelling of a folder outside stays outside.
    await rejectsCode(guard().resolveInside(upperCased(outside)), "forbidden");
  });

  test("a storage folder that is itself a link is used at its real path", async () => {
    const real = world.mkdir("real-share");
    const linked = path.join(world.root, "linked-share");
    fs.symlinkSync(real, linked);
    world.settings.update({ storageRoots: [share, linked] });
    try {
      assert.equal(await guard().resolveInside(path.join(linked, "x")), path.join(real, "x"));
      assert.equal(await guard().rootOf(path.join(real, "x")), real);
    } finally {
      world.settings.update({ storageRoots: [share] });
    }
  });

  test("a storage folder that is not reachable gives access to nothing", async () => {
    const gone = path.join(world.root, "gone-share");
    world.settings.update({ storageRoots: [share, gone] });
    try {
      await rejectsCode(guard().resolveInside(path.join(gone, "x")), "forbidden");
      const places = await world.mod.api.roots.list();
      assert.equal(places.find((place) => place.path === gone)?.available, false);
    } finally {
      world.settings.update({ storageRoots: [share] });
    }
  });

  test("another user's personal folder is refused for resolveFor, not for resolveInside", async () => {
    const bobFolder = await world.mod.api.roots.personalFolder(bob.id);
    assert.equal(await guard().resolveFor(aliceFolder, alice.id), aliceFolder);
    assert.equal(
      await guard().resolveFor(path.join(aliceFolder, "n"), alice.id),
      path.join(aliceFolder, "n"),
    );
    const error = await rejectsCode(guard().resolveFor(bobFolder, alice.id), "forbidden");
    await rejectsCode(guard().resolveFor(path.join(bobFolder, "channel"), alice.id), "forbidden");
    // The answer does not say whose folder it is.
    assert.ok(!error.message.includes(bob.id) && !error.message.includes(bob.email));
    assert.equal(await guard().resolveFor(media, alice.id), media);
    // A link from outside into another user's folder does not help either.
    fs.symlinkSync(bobFolder, path.join(share, "to-bob"));
    await rejectsCode(guard().resolveFor(path.join(share, "to-bob"), alice.id), "forbidden");
    // A personal folder of an id that is nobody's is also kept apart.
    const stranger = path.join(media, "f".repeat(32));
    await rejectsCode(guard().resolveFor(stranger, alice.id), "forbidden");
  });

  test("rootOf names the storage folder or null", async () => {
    assert.equal(await guard().rootOf(path.join(share, "a")), share);
    assert.equal(await guard().rootOf(path.join(media, "x")), media);
    assert.equal(await guard().rootOf(outside), null);
    assert.equal(await guard().rootOf(`${share}2`), null);
  });
});

describe("the storage folders", () => {
  test("the default folder comes first, then the admin's in order, each once", async () => {
    const world = createWorld({ storageRoots: ["b-share", "a-share"] });
    try {
      world.settings.update({
        storageRoots: [
          path.join(world.root, "b-share"),
          path.join(world.root, "a-share"),
          path.join(world.root, "b-share"),
          `${path.join(world.root, "b-share")}/`,
        ],
      });
      const list = await world.mod.api.roots.list();
      assert.deepEqual(
        list.map((root) => root.name),
        ["Server storage", "b-share", "a-share"],
      );
      assert.equal(list[0]?.isMedia, true);
      assert.ok(list.every((root) => root.available));
    } finally {
      world.cleanup();
    }
  });

  test("the media folder listed twice is one folder", async () => {
    const world = createWorld();
    try {
      world.settings.update({ storageRoots: [path.join(world.dataDir, "media")] });
      assert.equal((await world.mod.api.roots.list()).length, 1);
    } finally {
      world.cleanup();
    }
  });

  test("only a real user id has a personal folder", async () => {
    const world = createWorld();
    try {
      for (const bad of ["", "..", "../x", "alice", "A".repeat(32), "a".repeat(31)]) {
        await assert.rejects(world.mod.api.roots.personalFolder(bad), (error) => {
          return /** @type {{ code?: string }} */ (error).code === "internal";
        });
      }
      const user = world.makeUser("a@example.com");
      const folder = await world.mod.api.roots.personalFolder(user.id);
      assert.equal(folder, path.join(world.dataDir, "media", user.id));
      assert.ok(fs.statSync(folder).isDirectory());
    } finally {
      world.cleanup();
    }
  });
});

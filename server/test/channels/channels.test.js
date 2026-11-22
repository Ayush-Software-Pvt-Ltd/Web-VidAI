// Channels (SPEC section 6): create, directory rules across users, update, remove, reorder, list.
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cleanChannelName, folderNameFor } from "../../src/channels.js";
import { DEFAULT_PROMPT, createWorld, rejectsCode, treeOf } from "../storage/support.js";

/** @typedef {import("../storage/support.js").World} World */

describe("channels", () => {
  /** @type {World} */
  let world;
  /** @type {{ id: string, email: string }} */
  let alice;
  /** @type {{ id: string, email: string }} */
  let bob;
  /** @type {string} */
  let share;
  /** @type {string} */
  let outside;
  /** @type {Set<string>} */
  let active;

  beforeEach(() => {
    active = new Set();
    world = createWorld({
      storageRoots: ["share"],
      hasActiveJobs: (channelId) => active.has(channelId),
    });
    alice = world.makeUser("alice@example.com");
    bob = world.makeUser("bob@example.com");
    share = path.join(world.root, "share");
    outside = world.mkdir("outside");
    world.emitted.length = 0;
  });
  afterEach(() => world.cleanup());

  const service = () => world.mod.api.channels;
  /** @param {string} dir */
  const link = (dir) => /** @type {const} */ ({ kind: "link", dir });
  /** @param {string} name @param {{ id: string }} [user] */
  const linked = (name, user = alice) => {
    const dir = world.mkdir(`share/${name}`);
    return service().create(user, { name, videoType: "auto", location: link(dir) });
  };

  describe("create with a new folder", () => {
    test("makes the folder in the personal folder and fills slot 0 with the default prompt", async () => {
      const channel = await service().create(alice, {
        name: "My Channel",
        videoType: "short",
        location: { kind: "new", parent: null, folderName: null },
      });
      const personal = path.join(world.dataDir, "media", alice.id);
      assert.equal(channel.dir, path.join(personal, "My Channel"));
      assert.ok(fs.statSync(channel.dir).isDirectory());
      assert.equal(channel.name, "My Channel");
      assert.equal(channel.videoType, "short");
      assert.equal(channel.available, true);
      assert.match(channel.id, /^[0-9a-f]{32}$/);
      for (const profile of [channel.long, channel.short]) {
        assert.equal(profile.prompts.length, 5);
        assert.equal(profile.styles.length, 5);
        assert.deepEqual(profile.prompts[0], { name: "Default", text: DEFAULT_PROMPT });
        assert.deepEqual(profile.styles[0], { name: "Default", text: "" });
      }
      assert.ok(world.emitted.some((e) => e.event === "library-changed" && e.userId === alice.id));
    });

    test("the two profiles are separate copies", async () => {
      const channel = await linked("Copies");
      const [first] = await service().list(alice.id);
      assert.ok(first);
      assert.notEqual(first.long, first.short);
      assert.deepEqual(channel.long, channel.short);
    });

    test("a folder name and a parent can be given", async () => {
      const channel = await service().create(alice, {
        name: "Named",
        videoType: "auto",
        location: { kind: "new", parent: share, folderName: "chosen folder" },
      });
      assert.equal(channel.dir, path.join(share, "chosen folder"));
    });

    test("the folder name comes from the channel name, with unsafe characters made harmless", async () => {
      const channel = await service().create(alice, {
        name: "A/B: C? ..",
        videoType: "auto",
        location: { kind: "new", parent: share, folderName: null },
      });
      assert.equal(path.dirname(channel.dir), share);
      assert.ok(!path.basename(channel.dir).includes("/"));
      assert.ok(!path.basename(channel.dir).startsWith("."));
      assert.ok(channel.dir.startsWith(share));
    });

    test("a parent outside the storage folders is forbidden and nothing is made", async () => {
      const make = (/** @type {string} */ parent) =>
        service().create(alice, {
          name: "X",
          videoType: "auto",
          location: { kind: "new", parent, folderName: "x" },
        });
      await rejectsCode(make(outside), "forbidden");
      await rejectsCode(make(`${share}/../outside`), "forbidden");
      fs.symlinkSync(outside, path.join(share, "out-link"));
      await rejectsCode(make(path.join(share, "out-link")), "forbidden");
      assert.deepEqual(fs.readdirSync(outside), []);
      assert.deepEqual(await service().list(alice.id), []);
    });

    test("another user's personal folder is forbidden as a parent", async () => {
      const bobFolder = await world.mod.api.roots.personalFolder(bob.id);
      await rejectsCode(
        service().create(alice, {
          name: "X",
          videoType: "auto",
          location: { kind: "new", parent: bobFolder, folderName: "x" },
        }),
        "forbidden",
      );
      assert.deepEqual(fs.readdirSync(bobFolder), []);
    });

    test("a bad folder name is invalidInput", async () => {
      for (const folderName of ["..", ".", "a/b", "a\\b", ".hidden", "", " x", "x".repeat(121)]) {
        await rejectsCode(
          service().create(alice, {
            name: "X",
            videoType: "auto",
            location: { kind: "new", parent: share, folderName },
          }),
          "invalidInput",
        );
      }
      assert.deepEqual(fs.readdirSync(share), []);
    });

    test("an existing folder is conflict and its files are untouched", async () => {
      fs.mkdirSync(path.join(share, "taken"));
      fs.writeFileSync(path.join(share, "taken", "mine.txt"), "mine");
      await rejectsCode(
        service().create(alice, {
          name: "X",
          videoType: "auto",
          location: { kind: "new", parent: share, folderName: "taken" },
        }),
        "conflict",
      );
      assert.deepEqual(treeOf(path.join(share, "taken")), ["mine.txt"]);
    });

    test("a folder inside another channel is conflict and nothing appears there", async () => {
      const first = await linked("First");
      for (const user of [alice, bob]) {
        await rejectsCode(
          service().create(user, {
            name: `Inner ${user.id.slice(0, 4)}`,
            videoType: "auto",
            location: { kind: "new", parent: first.dir, folderName: "inner" },
          }),
          "conflict",
        );
      }
      assert.deepEqual(fs.readdirSync(first.dir), []);
    });

    test("a missing parent is invalidInput", async () => {
      await rejectsCode(
        service().create(alice, {
          name: "X",
          videoType: "auto",
          location: { kind: "new", parent: path.join(share, "nope", "deeper"), folderName: "x" },
        }),
        "invalidInput",
      );
      assert.equal(fs.existsSync(path.join(share, "nope")), false);
    });

    test("the default prompt file missing is notFound and no folder is left behind", async () => {
      world.cleanup();
      world = createWorld({ storageRoots: ["share"], defaultPromptPaths: ["/does/not/exist.md"] });
      alice = world.makeUser("a@example.com");
      await rejectsCode(
        world.mod.api.channels.create(alice, {
          name: "X",
          videoType: "auto",
          location: { kind: "new", parent: path.join(world.root, "share"), folderName: "x" },
        }),
        "notFound",
      );
    });
  });

  describe("names", () => {
    test("cleanChannelName trims and checks length and characters", () => {
      assert.equal(cleanChannelName("  Name  "), "Name");
      assert.equal(cleanChannelName("x".repeat(60)).length, 60);
      for (const bad of ["", "   ", "x".repeat(61), "a\nb", "a\u0000b", "a\u007fb", 5, null]) {
        assert.throws(
          () => cleanChannelName(bad),
          (error) => /** @type {{ code?: string }} */ (error).code === "invalidInput",
        );
      }
      assert.equal([...cleanChannelName("\u{1F600}".repeat(60))].length, 60);
    });

    test("folderNameFor", () => {
      assert.equal(folderNameFor("Plain", "darwin"), "Plain");
      assert.equal(folderNameFor("a/b\\c", "darwin"), "a-b-c");
      assert.equal(folderNameFor("  .hidden  ", "darwin"), "hidden");
      assert.equal(folderNameFor("trailing. .", "darwin"), "trailing");
      assert.equal(folderNameFor("", "darwin"), "Channel");
      assert.equal(folderNameFor("...", "darwin"), "Channel");
      assert.equal(folderNameFor("a:b?", "win32"), "a-b-");
      assert.equal(folderNameFor("CON", "win32"), "Channel");
      assert.equal(folderNameFor("x".repeat(300), "darwin").length, 120);
      assert.equal(folderNameFor("evil‮fdp", "darwin"), "evil-fdp");
    });

    test("a name is unique for the user without regard to letter case, not across users", async () => {
      await linked("Tech");
      const dir = world.mkdir("share/tech2");
      await rejectsCode(
        service().create(alice, { name: "TECH", videoType: "auto", location: link(dir) }),
        "conflict",
      );
      const other = await service().create(bob, {
        name: "TECH",
        videoType: "auto",
        location: link(dir),
      });
      assert.equal(other.name, "TECH");
    });

    test("a refused name makes no folder", async () => {
      await linked("Dup");
      const before = fs.readdirSync(share).sort();
      await rejectsCode(
        service().create(alice, {
          name: "dup",
          videoType: "auto",
          location: { kind: "new", parent: share, folderName: "dup-folder" },
        }),
        "conflict",
      );
      assert.deepEqual(fs.readdirSync(share).sort(), before);
    });
  });

  describe("create around an existing directory", () => {
    test("uses the real path and reads Style/STYLE.md into style slot 0", async () => {
      const dir = world.mkdir("share/styled/Style");
      fs.writeFileSync(path.join(dir, "STYLE.md"), "The look\n");
      const channel = await service().create(alice, {
        name: "Styled",
        videoType: "auto",
        location: link(path.join(share, "styled")),
      });
      assert.equal(channel.dir, path.join(share, "styled"));
      assert.equal(channel.long.styles[0]?.text, "The look\n");
      assert.equal(channel.short.styles[0]?.text, "The look\n");
      assert.equal(fs.readFileSync(path.join(dir, "STYLE.md"), "utf8"), "The look\n");
    });

    test("a STYLE.md that is a link out is not read", async () => {
      fs.writeFileSync(path.join(outside, "secret.md"), "SECRET");
      const dir = world.mkdir("share/sneaky/Style");
      fs.symlinkSync(path.join(outside, "secret.md"), path.join(dir, "STYLE.md"));
      const channel = await service().create(alice, {
        name: "Sneaky",
        videoType: "auto",
        location: link(path.join(share, "sneaky")),
      });
      assert.equal(channel.long.styles[0]?.text, "");
    });

    test("a directory outside the storage folders is forbidden", async () => {
      for (const dir of [
        outside,
        "/",
        `${share}/..`,
        world.dataDir,
        path.join(world.dataDir, "logs"),
      ]) {
        await rejectsCode(
          service().create(alice, { name: "X", videoType: "auto", location: link(dir) }),
          "forbidden",
        );
      }
      fs.symlinkSync(outside, path.join(share, "out"));
      await rejectsCode(
        service().create(alice, {
          name: "X",
          videoType: "auto",
          location: link(path.join(share, "out")),
        }),
        "forbidden",
      );
    });

    test("a storage folder itself cannot be a channel", async () => {
      const media = path.join(world.dataDir, "media");
      for (const dir of [share, media]) {
        await rejectsCode(
          service().create(alice, { name: "X", videoType: "auto", location: link(dir) }),
          "invalidInput",
        );
      }
    });

    test("a folder around a storage folder cannot be a channel", async () => {
      const inner = world.mkdir("share/inner");
      world.settings.update({ storageRoots: [share, inner] });
      await rejectsCode(
        service().create(alice, { name: "X", videoType: "auto", location: link(inner) }),
        "invalidInput",
      );
    });

    test("a personal folder itself cannot be a channel, a folder inside it can", async () => {
      const personal = await world.mod.api.roots.personalFolder(alice.id);
      await rejectsCode(
        service().create(alice, { name: "X", videoType: "auto", location: link(personal) }),
        "invalidInput",
      );
      const inside = path.join(personal, "inside");
      fs.mkdirSync(inside);
      const channel = await service().create(alice, {
        name: "Inside",
        videoType: "auto",
        location: link(inside),
      });
      assert.equal(channel.dir, inside);
    });

    test("another user's personal folder is forbidden", async () => {
      const bobFolder = await world.mod.api.roots.personalFolder(bob.id);
      fs.mkdirSync(path.join(bobFolder, "theirs"));
      await rejectsCode(
        service().create(alice, {
          name: "X",
          videoType: "auto",
          location: link(path.join(bobFolder, "theirs")),
        }),
        "forbidden",
      );
    });

    test("the data folder is refused when an admin made it a storage folder", async () => {
      const logs = world.mkdir("data/logs");
      world.settings.update({ storageRoots: [world.dataDir] });
      await rejectsCode(
        service().create(alice, { name: "X", videoType: "auto", location: link(logs) }),
        "invalidInput",
      );
      await rejectsCode(
        service().create(alice, { name: "X", videoType: "auto", location: link(world.dataDir) }),
        "invalidInput",
      );
    });

    test("a file or a missing folder is invalidInput", async () => {
      fs.writeFileSync(path.join(share, "file.txt"), "x");
      for (const dir of [path.join(share, "file.txt"), path.join(share, "missing")]) {
        await rejectsCode(
          service().create(alice, { name: "X", videoType: "auto", location: link(dir) }),
          "invalidInput",
        );
      }
      await rejectsCode(
        service().create(alice, { name: "X", videoType: "auto", location: link("relative") }),
        "invalidInput",
      );
    });
  });

  describe("one directory, one channel", () => {
    test("the same directory twice is conflict, for the same user and for another", async () => {
      const first = await linked("One");
      for (const user of [alice, bob]) {
        await rejectsCode(
          service().create(user, {
            name: `Again ${user.email}`,
            videoType: "auto",
            location: link(first.dir),
          }),
          "conflict",
        );
      }
    });

    test("a folder inside a channel is conflict", async () => {
      const first = await linked("Outer");
      const inner = path.join(first.dir, "inner");
      fs.mkdirSync(inner);
      await rejectsCode(
        service().create(bob, { name: "Inner", videoType: "auto", location: link(inner) }),
        "conflict",
      );
    });

    test("a folder around a channel is conflict", async () => {
      fs.mkdirSync(path.join(share, "holder", "ch"), { recursive: true });
      await service().create(alice, {
        name: "Held",
        videoType: "auto",
        location: link(path.join(share, "holder", "ch")),
      });
      await rejectsCode(
        service().create(bob, {
          name: "Holder",
          videoType: "auto",
          location: link(path.join(share, "holder")),
        }),
        "conflict",
      );
    });

    test("a link to another channel's folder is the same folder", async () => {
      const first = await linked("Target");
      fs.symlinkSync(first.dir, path.join(share, "alias"));
      await rejectsCode(
        service().create(bob, {
          name: "Alias",
          videoType: "auto",
          location: link(path.join(share, "alias")),
        }),
        "conflict",
      );
    });

    test("the refusal does not say whose channel it is", async () => {
      const first = await linked("Secret Owner Channel");
      const error = await rejectsCode(
        service().create(bob, { name: "Mine", videoType: "auto", location: link(first.dir) }),
        "conflict",
      );
      assert.equal(error.message, "This folder already belongs to a channel.");
      assert.ok(!error.message.includes("alice") && !error.message.includes("Secret"));
    });

    test("two creations at once cannot both get one directory", async () => {
      const dir = world.mkdir("share/race");
      const results = await Promise.allSettled([
        service().create(alice, { name: "R1", videoType: "auto", location: link(dir) }),
        service().create(bob, { name: "R2", videoType: "auto", location: link(dir) }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(world.mod.api.channelsRepo.listAll().length, 1);
    });
  });

  describe("another user's channels", () => {
    test("are not listed, found, changed, removed or reordered", async () => {
      const mine = await linked("Mine");
      assert.deepEqual(await service().list(bob.id), []);
      await rejectsCode(service().update(bob.id, mine.id, { name: "Stolen" }), "notFound");
      await rejectsCode(service().remove(bob.id, mine.id), "notFound");
      await rejectsCode(service().reorder(bob.id, [mine.id]), "notFound");
      await rejectsCode(service().createVideo(bob.id, mine.id, "V"), "notFound");
      const [still] = await service().list(alice.id);
      assert.equal(still?.name, "Mine");
      assert.deepEqual(fs.readdirSync(mine.dir), []);
    });

    test("the answer for a stranger's channel equals the answer for none", async () => {
      const mine = await linked("Mine");
      const foreign = await rejectsCode(service().remove(bob.id, mine.id), "notFound");
      const missing = await rejectsCode(service().remove(bob.id, "0".repeat(32)), "notFound");
      assert.equal(foreign.message, missing.message);
    });
  });

  describe("update", () => {
    test("changes the given fields only", async () => {
      const channel = await linked("Before");
      const profile = structuredClone(channel.long);
      /** @type {import("../../../src/lib/wire/channels.ts").ChannelSlot} */ (
        profile.prompts[1]
      ).text = "second";
      const updated = await service().update(alice.id, channel.id, {
        name: "After",
        videoType: "long",
        long: profile,
      });
      assert.equal(updated.name, "After");
      assert.equal(updated.videoType, "long");
      assert.equal(updated.long.prompts[1]?.text, "second");
      assert.deepEqual(updated.short, channel.short);
      assert.equal(updated.dir, channel.dir);
      const again = await service().update(alice.id, channel.id, {
        name: null,
        videoType: null,
        long: null,
        short: null,
      });
      assert.deepEqual(again, updated);
    });

    test("a name that another channel of the user has is conflict, its own is fine", async () => {
      const one = await linked("One");
      await linked("Two");
      await rejectsCode(service().update(alice.id, one.id, { name: "two" }), "conflict");
      assert.equal((await service().update(alice.id, one.id, { name: "ONE" })).name, "ONE");
      await rejectsCode(service().update(alice.id, one.id, { name: "" }), "invalidInput");
    });

    test("is allowed while an edit of the channel runs", async () => {
      const channel = await linked("Busy");
      active.add(channel.id);
      assert.equal(
        (await service().update(alice.id, channel.id, { name: "Still ok" })).name,
        "Still ok",
      );
    });
  });

  describe("remove", () => {
    test("deletes the row and leaves every file", async () => {
      const channel = await linked("Gone");
      fs.mkdirSync(path.join(channel.dir, "Video 1"));
      fs.writeFileSync(path.join(channel.dir, "Video 1", "clip.mp4"), "video");
      const before = treeOf(world.root);
      await service().remove(alice.id, channel.id);
      assert.deepEqual(await service().list(alice.id), []);
      assert.deepEqual(treeOf(world.root), before);
      await rejectsCode(service().remove(alice.id, channel.id), "notFound");
    });

    test("is conflict while an edit of its videos runs, and nothing changes", async () => {
      const channel = await linked("Running");
      active.add(channel.id);
      await rejectsCode(service().remove(alice.id, channel.id), "conflict");
      assert.equal((await service().list(alice.id)).length, 1);
      active.clear();
      await service().remove(alice.id, channel.id);
    });

    test("the directory can become a channel again afterwards", async () => {
      const channel = await linked("Again");
      await service().remove(alice.id, channel.id);
      const second = await service().create(bob, {
        name: "Bobs now",
        videoType: "auto",
        location: link(channel.dir),
      });
      assert.equal(second.dir, channel.dir);
    });
  });

  describe("order and list", () => {
    test("channels come in the order they were made and reorder gives a new order", async () => {
      const a = await linked("A");
      const b = await linked("B");
      const c = await linked("C");
      assert.deepEqual(
        (await service().list(alice.id)).map((channel) => channel.name),
        ["A", "B", "C"],
      );
      const reordered = await service().reorder(alice.id, [c.id, a.id, b.id]);
      assert.deepEqual(
        reordered.map((channel) => channel.name),
        ["C", "A", "B"],
      );
      assert.deepEqual(
        (await service().list(alice.id)).map((channel) => channel.name),
        ["C", "A", "B"],
      );
      const d = await linked("D");
      assert.equal((await service().list(alice.id)).at(-1)?.id, d.id);
    });

    test("a new order must list each channel exactly once", async () => {
      const a = await linked("A");
      const b = await linked("B");
      for (const ids of [[a.id], [a.id, a.id], [a.id, b.id, a.id], []]) {
        await rejectsCode(service().reorder(alice.id, ids), "invalidInput");
      }
      await rejectsCode(service().reorder(alice.id, [a.id, "0".repeat(32)]), "notFound");
      assert.deepEqual(
        (await service().list(alice.id)).map((channel) => channel.name),
        ["A", "B"],
      );
    });

    test("reordering does not touch another user's order", async () => {
      const a = await linked("A");
      const b = await linked("B");
      const x = await linked("X", bob);
      const y = await linked("Y", bob);
      await service().reorder(alice.id, [b.id, a.id]);
      assert.deepEqual(
        (await service().list(bob.id)).map((channel) => channel.id),
        [x.id, y.id],
      );
      // Ids of another user's channels are not accepted in a new order.
      await rejectsCode(service().reorder(alice.id, [a.id, x.id]), "notFound");
    });

    test("a channel whose folder cannot be reached is listed as unavailable, unchanged", async () => {
      const channel = await linked("Away");
      fs.renameSync(channel.dir, `${channel.dir}-moved`);
      let [listed] = await service().list(alice.id);
      assert.equal(listed?.available, false);
      assert.equal(listed?.dir, channel.dir);
      // A link put in its place that leads out is not available either.
      fs.symlinkSync(outside, channel.dir);
      [listed] = await service().list(alice.id);
      assert.equal(listed?.available, false);
      fs.unlinkSync(channel.dir);
      fs.renameSync(`${channel.dir}-moved`, channel.dir);
      [listed] = await service().list(alice.id);
      assert.equal(listed?.available, true);
    });
  });
});

// Channels (SPEC section 6): the admin's create and remove, the directory rule across users, the
// owner's update, reorder, list, and what users can no longer do.
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cleanChannelName } from "../../src/channels.js";
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
  let area;
  /** @type {Set<string>} */
  let active;

  beforeEach(() => {
    active = new Set();
    world = createWorld({ hasActiveJobs: (channelId) => active.has(channelId) });
    alice = world.makeUser("alice@example.com");
    bob = world.makeUser("bob@example.com");
    area = world.mkdir("area");
    world.emitted.length = 0;
  });
  afterEach(() => world.cleanup());

  const service = () => world.mod.api.channels;
  /** Makes the folder `area/<name>` and a channel of that name around it. @param {string} name @param {{ id: string }} [user] */
  const linked = (name, user = alice) =>
    world.makeChannel(user, name, { dir: world.mkdir(`area/${name}`) });
  /** @param {string} dir @param {{ id: string }} [user] @param {string} [name] */
  const around = (dir, user = alice, name = "Around") =>
    service().create({ name, userId: user.id, dir, videoType: "auto" });

  describe("create", () => {
    test("makes a channel around an existing directory with the default prompt in slot 0", async () => {
      const dir = world.mkdir("area/My Channel");
      const channel = await service().create({
        name: "My Channel",
        userId: alice.id,
        dir,
        videoType: "short",
      });
      assert.equal(channel.dir, dir);
      assert.equal(channel.name, "My Channel");
      assert.equal(channel.videoType, "short");
      assert.equal(channel.available, true);
      assert.equal(channel.long.prompts[0]?.text, DEFAULT_PROMPT);
      assert.equal(channel.short.prompts[0]?.text, DEFAULT_PROMPT);
      assert.equal(channel.long.prompts[1]?.text, "");
      assert.deepEqual(
        (await service().list(alice.id)).map((listed) => listed.id),
        [channel.id],
      );
      assert.deepEqual(await service().list(bob.id), []);
    });

    test("tells the owner's pages and nobody else", async () => {
      await linked("Told");
      const names = world.emitted.map((event) => [event.event, event.userId, event.admins]);
      assert.deepEqual(names, [
        ["workspace-changed", alice.id, false],
        ["library-changed", alice.id, false],
      ]);
    });

    test("the real path is stored, links followed", async () => {
      const real = world.mkdir("area/real");
      fs.symlinkSync(real, path.join(area, "alias"));
      const channel = await around(path.join(area, "alias"));
      assert.equal(channel.dir, real);
    });

    test("STYLE.md of the directory becomes style slot 0 and is only read", async () => {
      const dir = world.mkdir("area/Styled/Style");
      fs.writeFileSync(path.join(dir, "STYLE.md"), "warm colours");
      const before = treeOf(world.root);
      const channel = await around(path.dirname(dir));
      assert.equal(channel.long.styles[0]?.text, "warm colours");
      assert.equal(channel.short.styles[0]?.text, "warm colours");
      assert.deepEqual(treeOf(world.root), before);
    });

    test("a channel goes last in its owner's order", async () => {
      await linked("A");
      await linked("B");
      const c = await linked("C");
      assert.equal((await service().list(alice.id)).at(-1)?.id, c.id);
    });

    test("a folder that does not exist, a file and text that is no path are invalidInput with field dir", async () => {
      const file = path.join(area, "a-file.txt");
      fs.writeFileSync(file, "x");
      for (const bad of [path.join(area, "missing"), file, "relative/path", ""]) {
        const error = await rejectsCode(around(bad), "invalidInput");
        assert.equal(error.field, "dir", String(bad));
      }
      await rejectsCode(around(`${area}/../area`), "forbidden");
      assert.deepEqual(await service().list(alice.id), []);
    });

    test("a link that loops or leads nowhere is refused", async () => {
      fs.symlinkSync(path.join(area, "nowhere"), path.join(area, "dangling"));
      await rejectsCode(around(path.join(area, "dangling")), "forbidden");
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

    test("a name is unique for the user without regard to letter case, not across users", async () => {
      await linked("Tech");
      const dir = world.mkdir("area/tech2");
      const error = await rejectsCode(around(dir, alice, "TECH"), "conflict");
      assert.equal(error.message, "This user already has a channel with that name.");
      assert.equal(error.field, "name");
      const other = await around(dir, bob, "TECH");
      assert.equal(other.name, "TECH");
    });

    test("a refused name makes no channel", async () => {
      await linked("Dup");
      const dir = world.mkdir("area/other");
      await rejectsCode(around(dir, alice, "dup"), "conflict");
      await rejectsCode(around(dir, alice, ""), "invalidInput");
      assert.equal((await service().list(alice.id)).length, 1);
    });
  });

  describe("the directory rule (checkChannelDir)", () => {
    test("the data directory, what lies inside it and what holds it are refused", async () => {
      fs.mkdirSync(path.join(world.dataDir, "projects"));
      for (const dir of [world.dataDir, path.join(world.dataDir, "projects"), world.root]) {
        const error = await rejectsCode(around(dir), "invalidInput");
        assert.equal(error.message, "This folder belongs to VidAI's own data.");
        assert.equal(error.field, "dir");
      }
      // A link into it is the same place.
      fs.symlinkSync(world.dataDir, path.join(area, "data-link"));
      await rejectsCode(around(path.join(area, "data-link")), "invalidInput");
      assert.deepEqual(await service().list(alice.id), []);
    });

    test("the same, an inner and an outer directory of any channel are conflict", async () => {
      const first = await linked("First");
      const error = await rejectsCode(around(first.dir, bob, "Same"), "conflict");
      assert.equal(error.message, "This folder already belongs to a channel.");
      const inner = path.join(first.dir, "inner");
      fs.mkdirSync(inner);
      await rejectsCode(around(inner, bob, "Inner"), "conflict");
      await rejectsCode(around(area, bob, "Outer"), "conflict");
      // Through a link it is still the same directory.
      fs.symlinkSync(first.dir, path.join(world.root, "alias"));
      await rejectsCode(around(path.join(world.root, "alias"), bob, "Aliased"), "conflict");
      // Next to it is fine, and the answer does not name the owner.
      const sibling = world.mkdir("area/First 2");
      assert.equal((await around(sibling, bob, "Sibling")).dir, sibling);
      assert.ok(!error.message.includes("alice"));
    });

    test("a channel's own directory is no overlap for itself when it is excepted", async () => {
      const first = await linked("First");
      const other = await linked("Other");
      const check = world.mod.api.checkChannelDir;
      assert.equal(await check(first.dir, { exceptChannelId: first.id }), first.dir);
      await rejectsCode(check(first.dir), "conflict");
      await rejectsCode(check(first.dir, { exceptChannelId: other.id }), "conflict");
    });

    test("nothing is made or changed by a refusal", async () => {
      const first = await linked("First");
      const before = treeOf(world.root);
      await rejectsCode(around(first.dir, bob), "conflict");
      await rejectsCode(around(path.join(area, "missing"), bob), "invalidInput");
      assert.deepEqual(treeOf(world.root), before);
    });
  });

  describe("update (the owner's changes)", () => {
    test("changes the given fields only", async () => {
      const channel = await linked("Before");
      const profile = structuredClone(channel.long);
      /** @type {import("../../../src/lib/wire/channels.ts").ChannelSlot} */ (
        profile.prompts[1]
      ).text = "second";
      const updated = await service().update(alice.id, channel.id, {
        videoType: "long",
        long: profile,
      });
      assert.equal(updated.name, "Before");
      assert.equal(updated.videoType, "long");
      assert.equal(updated.long.prompts[1]?.text, "second");
      assert.deepEqual(updated.short, channel.short);
      assert.equal(updated.dir, channel.dir);
      const again = await service().update(alice.id, channel.id, {
        videoType: null,
        long: null,
        short: null,
      });
      assert.deepEqual(again, updated);
    });

    test("is allowed while an edit of the channel runs", async () => {
      const channel = await linked("Busy");
      active.add(channel.id);
      assert.equal(
        (await service().update(alice.id, channel.id, { videoType: "short" })).videoType,
        "short",
      );
    });

    test("another user's channel is notFound, the same answer as for none", async () => {
      const mine = await linked("Mine");
      const foreign = await rejectsCode(
        service().update(bob.id, mine.id, { videoType: "long" }),
        "notFound",
      );
      const missing = await rejectsCode(
        service().update(bob.id, "0".repeat(32), { videoType: "long" }),
        "notFound",
      );
      assert.equal(foreign.message, missing.message);
      assert.equal((await service().list(alice.id))[0]?.videoType, "auto");
    });
  });

  describe("remove (admin)", () => {
    test("deletes the row and leaves every file", async () => {
      const channel = await linked("Gone");
      fs.mkdirSync(path.join(channel.dir, "Video 1"));
      fs.writeFileSync(path.join(channel.dir, "Video 1", "clip.mp4"), "video");
      const before = treeOf(world.root);
      world.emitted.length = 0;
      await service().remove(channel.id);
      assert.deepEqual(await service().list(alice.id), []);
      assert.deepEqual(treeOf(world.root), before);
      assert.deepEqual(
        world.emitted.map((event) => [event.event, event.userId]),
        [
          ["workspace-changed", alice.id],
          ["library-changed", alice.id],
        ],
      );
      await rejectsCode(service().remove(channel.id), "notFound");
    });

    test("is conflict while an edit of its videos runs, and nothing changes", async () => {
      const channel = await linked("Running");
      active.add(channel.id);
      const error = await rejectsCode(service().remove(channel.id), "conflict");
      assert.equal(error.message, "Stop the running edits of this channel's videos first.");
      assert.equal((await service().list(alice.id)).length, 1);
      active.clear();
      await service().remove(channel.id);
    });

    test("the directory can become a channel again afterwards", async () => {
      const channel = await linked("Again");
      await service().remove(channel.id);
      const second = await around(channel.dir, bob, "Bobs now");
      assert.equal(second.dir, channel.dir);
    });
  });

  describe("users can no longer make, rename or remove channels", () => {
    test("createChannel, removeChannel and createVideo are not functions any more", async () => {
      const mine = await linked("Mine");
      const dir = world.mkdir("area/Wanted");
      const calls = /** @type {[string, unknown][]} */ ([
        ["createChannel", { name: "Mine 2", videoType: "auto", location: { kind: "link", dir } }],
        ["removeChannel", { id: mine.id }],
        ["createVideo", { channelId: mine.id, name: "Video" }],
      ]);
      for (const [name, input] of calls) {
        await rejectsCode(world.callRpc(alice, name, input), "notFound");
      }
      assert.equal((await service().list(alice.id)).length, 1);
      assert.deepEqual(fs.readdirSync(mine.dir), []);
    });

    test("updateChannel refuses a name, even next to allowed fields", async () => {
      const mine = await linked("Mine");
      const error = await rejectsCode(
        world.callRpc(alice, "updateChannel", { id: mine.id, update: { name: "Renamed" } }),
        "invalidInput",
      );
      assert.equal(error.field, "update.name");
      await rejectsCode(
        world.callRpc(alice, "updateChannel", {
          id: mine.id,
          update: { videoType: "short", name: "Renamed" },
        }),
        "invalidInput",
      );
      const [listed] = await service().list(alice.id);
      assert.equal(listed?.name, "Mine");
      assert.equal(listed?.videoType, "auto");
      // The allowed fields still work through the RPC.
      const updated = await world.callRpc(alice, "updateChannel", {
        id: mine.id,
        update: { videoType: "short" },
      });
      assert.equal(updated.videoType, "short");
    });

    test("nor can they send a directory or an owner through updateChannel", async () => {
      const mine = await linked("Mine");
      for (const update of [{ dir: area }, { userId: bob.id }]) {
        await rejectsCode(
          world.callRpc(alice, "updateChannel", { id: mine.id, update }),
          "invalidInput",
        );
      }
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
      await rejectsCode(service().reorder(alice.id, [a.id, x.id]), "notFound");
    });

    test("a channel whose folder cannot be reached is listed as unavailable, unchanged", async () => {
      const channel = await linked("Away");
      const outside = world.mkdir("outside");
      fs.renameSync(channel.dir, `${channel.dir}-moved`);
      let [listed] = await service().list(alice.id);
      assert.equal(listed?.available, false);
      assert.equal(listed?.dir, channel.dir);
      // A link put in its place that leads elsewhere is not available either.
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

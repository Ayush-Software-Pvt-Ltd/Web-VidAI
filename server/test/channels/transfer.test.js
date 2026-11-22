// Channel documents (export, import that only updates), the default prompt, video folders and the
// workspace RPC functions.
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "../../src/channels.js";
import { DEFAULT_PROMPT, createWorld, rejectsCode, treeOf } from "../storage/support.js";

/** @typedef {import("../storage/support.js").World} World */

describe("channel documents and videos", () => {
  /** @type {World} */
  let world;
  /** @type {{ id: string, email: string }} */
  let alice;
  /** @type {{ id: string, email: string }} */
  let bob;

  beforeEach(() => {
    world = createWorld();
    alice = world.makeUser("alice@example.com");
    bob = world.makeUser("bob@example.com");
  });
  afterEach(() => world.cleanup());

  const service = () => world.mod.api.channels;
  /** @param {string} name @param {{ id: string }} [user] */
  const linked = (name, user = alice) =>
    world.makeChannel(user, name, { dir: world.mkdir(`area/${name}-${user.id.slice(0, 4)}`) });
  /** @param {string} text */
  const slots = (text) =>
    Array.from({ length: 5 }, (_, index) => ({ name: `S${index}`, text: `${text}${index}` }));

  describe("export and import", () => {
    test("export lists names, types and profiles, never directories", async () => {
      const channel = await linked("Tech");
      const document = service().exportDocument(alice.id);
      assert.equal(document.format, "vidai-channels");
      assert.equal(document.version, 1);
      assert.match(document.exportedAt, /^\d{4}-\d\d-\d\dT/);
      assert.deepEqual(document.channels, [
        { name: "Tech", videoType: "auto", long: channel.long, short: channel.short },
      ]);
      assert.ok(!JSON.stringify(document).includes(channel.dir));
      assert.ok(!JSON.stringify(document).includes(world.root));
      assert.deepEqual(service().exportDocument(bob.id).channels, []);
    });

    test("a document imports into another account without making channels or folders", async () => {
      await linked("Tech");
      await linked("News");
      const document = service().exportDocument(alice.id);
      const before = treeOf(world.root);
      const result = await service().importDocument(bob, document);
      assert.deepEqual(result, { updated: 0, skipped: ["Tech", "News"] });
      assert.deepEqual(await service().list(bob.id), []);
      assert.deepEqual(treeOf(world.root), before);
    });

    test("a channel of the same name (any letter case) is updated, the others are kept", async () => {
      const tech = await linked("Tech");
      const keep = await linked("Keep");
      const document = {
        format: "vidai-channels",
        version: 1,
        channels: [
          {
            name: "TECH",
            videoType: "short",
            long: { prompts: slots("p"), styles: slots("s") },
            short: { prompts: slots("q"), styles: slots("t") },
          },
        ],
      };
      const result = await service().importDocument(alice, document);
      assert.deepEqual(result, { updated: 1, skipped: [] });
      const [first, second] = await service().list(alice.id);
      assert.equal(first?.id, tech.id);
      assert.equal(first?.name, "Tech");
      assert.equal(first?.videoType, "short");
      assert.equal(first?.long.prompts[0]?.text, "p0");
      assert.equal(first?.long.prompts[0]?.name, "Default");
      assert.equal(first?.short.styles[4]?.text, "t4");
      assert.equal(first?.dir, tech.dir);
      assert.equal(second?.id, keep.id);
      assert.deepEqual(second?.long, keep.long);
    });

    test("names that match no channel come back in the file's order, matching ones are updated", async () => {
      const tech = await linked("Tech");
      const document = {
        format: "vidai-channels",
        version: 1,
        channels: [
          { name: "Zed", videoType: "long" },
          { name: "tech", videoType: "short" },
          { name: "Alpha" },
          { name: "Mid" },
        ],
      };
      const result = await service().importDocument(alice, document);
      assert.deepEqual(result, { updated: 1, skipped: ["Zed", "Alpha", "Mid"] });
      const channels = await service().list(alice.id);
      assert.deepEqual(
        channels.map((channel) => [channel.id, channel.videoType]),
        [[tech.id, "short"]],
      );
    });

    test("another user's channel of the same name is never touched", async () => {
      const theirs = await linked("Shared", bob);
      const document = {
        format: "vidai-channels",
        version: 1,
        channels: [{ name: "Shared", videoType: "short" }],
      };
      assert.deepEqual(await service().importDocument(alice, document), {
        updated: 0,
        skipped: ["Shared"],
      });
      assert.deepEqual((await service().list(bob.id))[0], theirs);
    });

    test("a file with a problem changes nothing at all", async () => {
      await linked("Existing");
      const before = treeOf(world.root);
      const rows = await service().list(alice.id);
      const good = { name: "Existing", videoType: "long" };
      for (const channels of [
        [good, { name: "" }],
        [good, { name: "x".repeat(61) }],
        [good, { name: "existing" }],
        [good, "text"],
        [good, null],
      ]) {
        await rejectsCode(
          service().importDocument(alice, { format: "vidai-channels", version: 1, channels }),
          "invalidInput",
        );
      }
      assert.deepEqual(treeOf(world.root), before);
      assert.deepEqual(await service().list(alice.id), rows);
    });

    test("documents that are not channel files are invalidInput", async () => {
      for (const document of [
        null,
        "text",
        [],
        {},
        { format: "other", version: 1, channels: [] },
        { format: "vidai-channels", channels: [] },
        { format: "vidai-channels", version: 0, channels: [] },
        { format: "vidai-channels", version: 1.5, channels: [] },
        { format: "vidai-channels", version: 2, channels: [] },
        { format: "vidai-channels", version: 1 },
        { format: "vidai-channels", version: 1, channels: "no" },
        { format: "vidai-settings", version: 3, channels: [] },
      ]) {
        await rejectsCode(service().importDocument(alice, document), "invalidInput");
      }
      const many = Array.from({ length: 101 }, (_, index) => ({ name: `C${index}` }));
      await rejectsCode(
        service().importDocument(alice, { format: "vidai-channels", version: 1, channels: many }),
        "invalidInput",
      );
    });

    test("an unknown video type is read as auto, extra fields are ignored", async () => {
      const channel = await linked("A");
      await service().update(alice.id, channel.id, { videoType: "long" });
      const result = await service().importDocument(alice, {
        format: "vidai-channels",
        version: 1,
        extra: true,
        channels: [{ name: "A", videoType: "weird", folder: "/etc", dir: "/etc", userId: bob.id }],
      });
      assert.deepEqual(result, { updated: 1, skipped: [] });
      const [after] = await service().list(alice.id);
      assert.equal(after?.videoType, "auto");
      // A "folder", "dir" or owner in the file is never used.
      assert.equal(after?.dir, channel.dir);
      assert.deepEqual(await service().list(bob.id), []);
    });

    test("a path in a name makes nothing, it only matches no channel", async () => {
      const before = treeOf(world.root);
      const result = await service().importDocument(alice, {
        format: "vidai-channels",
        version: 1,
        channels: [{ name: "../../escape" }, { name: "a/b" }, { name: ".." }],
      });
      assert.deepEqual(result, { updated: 0, skipped: ["../../escape", "a/b", ".."] });
      assert.deepEqual(treeOf(world.root), before);
    });

    test("only the channels format is accepted, a settings file of another program is refused", async () => {
      const settings = {
        format: "vidai-settings",
        version: 2,
        channels: [{ folderName: "Tech", long: { prompts: [{ name: "Mine", text: "p0" }] } }],
      };
      await rejectsCode(service().importDocument(alice, settings), "invalidInput");
      assert.deepEqual(await service().list(alice.id), []);
      assert.throws(() => parseDocument({ format: "vidai-settings", version: 1, channels: [] }));
      assert.throws(() => parseDocument({ format: "vidai-channels", version: 2, channels: [] }));
      assert.doesNotThrow(() =>
        parseDocument({ format: "vidai-channels", version: 1, channels: [] }),
      );
    });

    test("what is exported imports back unchanged", async () => {
      const channel = await linked("Round");
      await linked("Round", bob);
      const edited = structuredClone(channel.long);
      /** @type {import("../../../src/lib/wire/channels.ts").ChannelSlot} */ (
        edited.prompts[2]
      ).name = "Custom";
      await service().update(alice.id, channel.id, { long: edited, videoType: "short" });
      const document = service().exportDocument(alice.id);
      const result = await service().importDocument(bob, JSON.parse(JSON.stringify(document)));
      assert.deepEqual(result, { updated: 1, skipped: [] });
      const [copy] = await service().list(bob.id);
      assert.equal(copy?.videoType, "short");
      assert.deepEqual(copy?.long, edited);
    });
  });

  describe("the default prompt", () => {
    test("is read from the first file that exists", async () => {
      assert.equal(await service().defaultPrompt(), DEFAULT_PROMPT);
      const spare = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-prompt-"));
      try {
        const second = path.join(spare, "second.md");
        fs.writeFileSync(second, "second");
        world.cleanup();
        world = createWorld({ defaultPromptPaths: [path.join(spare, "missing.md"), second] });
        assert.equal(await world.mod.api.channels.defaultPrompt(), "second");
      } finally {
        fs.rmSync(spare, { recursive: true, force: true });
      }
    });

    test("is notFound when no file exists", async () => {
      world.cleanup();
      world = createWorld({ defaultPromptPaths: ["/does/not/exist.md"] });
      await rejectsCode(world.mod.api.channels.defaultPrompt(), "notFound");
    });

    test("the real installation has a default prompt file", async () => {
      const { defaultPromptPaths } = await import("../../src/channels.js");
      assert.ok(defaultPromptPaths().some((file) => fs.existsSync(file)));
    });
  });

  describe("video folders", () => {
    test("a video id resolves to its real folder inside the channel", async () => {
      const channel = await linked("Chan");
      fs.mkdirSync(path.join(channel.dir, "V1"));
      const resolved = await world.mod.api.folders.resolveVideo(alice.id, `${channel.id}/V1`);
      assert.equal(resolved.dir, path.join(channel.dir, "V1"));
      assert.equal(resolved.folderName, "V1");
      assert.equal(resolved.channelDir, channel.dir);
    });

    test("reserved folders, files and other users' ids are notFound", async () => {
      const channel = await linked("Chan");
      fs.mkdirSync(path.join(channel.dir, "Style"));
      fs.mkdirSync(path.join(channel.dir, "upload"));
      fs.mkdirSync(path.join(channel.dir, ".hidden"));
      fs.writeFileSync(path.join(channel.dir, "file"), "x");
      fs.mkdirSync(path.join(channel.dir, "V1"));
      const resolve = (/** @type {string} */ user, /** @type {unknown} */ id) =>
        world.mod.api.folders.resolveVideo(user, id);
      for (const id of [
        `${channel.id}/Style`,
        `${channel.id}/upload`,
        `${channel.id}/UPLOAD`,
        `${channel.id}/.hidden`,
        `${channel.id}/file`,
        `${channel.id}/missing`,
        `${channel.id}/..`,
        `${channel.id}/../x`,
        `${channel.id}/V1/..`,
        `${channel.id}/`,
        channel.id,
        "",
        null,
        42,
      ]) {
        await rejectsCode(resolve(alice.id, id), "notFound");
      }
      await rejectsCode(resolve(bob.id, `${channel.id}/V1`), "notFound");
    });
  });

  describe("video folders that are links", () => {
    test("a video folder that is a link is not a video, inside the channel or out of it", async () => {
      const channel = await linked("Chan");
      const outside = world.mkdir("outside");
      fs.mkdirSync(path.join(channel.dir, "Real"));
      fs.symlinkSync(outside, path.join(channel.dir, "Out"));
      fs.symlinkSync(path.join(channel.dir, "Real"), path.join(channel.dir, "Alias"));
      for (const name of ["Out", "Alias"]) {
        await rejectsCode(
          world.mod.api.folders.resolveVideo(alice.id, `${channel.id}/${name}`),
          "notFound",
        );
      }
      const real = await world.mod.api.folders.resolveVideo(alice.id, `${channel.id}/Real`);
      assert.equal(real.dir, path.join(channel.dir, "Real"));
    });

    test("a channel whose folder was replaced by a link is unreachable, not followed", async () => {
      const channel = await linked("Chan");
      fs.mkdirSync(path.join(channel.dir, "V1"));
      const moved = `${channel.dir}-moved`;
      fs.renameSync(channel.dir, moved);
      fs.symlinkSync(moved, channel.dir);
      await rejectsCode(
        world.mod.api.folders.resolveVideo(alice.id, `${channel.id}/V1`),
        "conflict",
      );
    });
  });

  describe("RPC", () => {
    test("getWorkspace answers channels, public settings and a null readiness", async () => {
      await linked("Tech");
      const workspace = /** @type {any} */ (await world.callRpc(alice, "getWorkspace"));
      assert.deepEqual(Object.keys(workspace).sort(), ["channels", "readiness", "settings"]);
      assert.equal(workspace.readiness, null);
      assert.equal(workspace.channels.length, 1);
      assert.equal(workspace.channels[0].name, "Tech");
      assert.ok(typeof workspace.settings === "object" && workspace.settings !== null);
      const bobs = /** @type {any} */ (await world.callRpc(bob, "getWorkspace"));
      assert.deepEqual(bobs.channels, []);
    });

    test("updateChannel and reorderChannels", async () => {
      const created = await linked("Rpc");
      const updated = /** @type {any} */ (
        await world.callRpc(alice, "updateChannel", {
          id: created.id,
          update: { videoType: "long", long: null, short: null },
        })
      );
      assert.equal(updated.name, "Rpc");
      assert.equal(updated.videoType, "long");
      const profile = { prompts: slots("p"), styles: slots("s") };
      const withProfile = /** @type {any} */ (
        await world.callRpc(alice, "updateChannel", {
          id: created.id,
          update: { videoType: "short", long: profile, short: null },
        })
      );
      assert.equal(withProfile.long.prompts[1].text, "p1");
      assert.equal(withProfile.long.prompts[0].name, "Default");
      assert.deepEqual(
        /** @type {any[]} */ (
          await world.callRpc(alice, "reorderChannels", { ids: [created.id] })
        ).map((channel) => channel.id),
        [created.id],
      );
    });

    test("input that is not valid is refused before anything happens", async () => {
      const bad = [
        ["updateChannel", { id: "x", update: { long: { prompts: [], styles: [] } } }],
        ["updateChannel", { id: "x", update: { videoType: "weird" } }],
        ["reorderChannels", { ids: "no" }],
        ["importChannels", {}],
        ["fsList", { path: 5 }],
        ["fsCreateFolder", { parent: "/x" }],
        ["cancelUpload", {}],
      ];
      const admin = world.makeAdmin("admin@example.com");
      for (const [name, input] of /** @type {[string, unknown][]} */ (bad)) {
        await assert.rejects(
          Promise.resolve().then(() =>
            world.callRpc(name.startsWith("fs") ? admin : alice, name, input),
          ),
          (error) => /** @type {{ code?: string }} */ (error).code === "invalidInput",
          name,
        );
      }
    });

    test("export, import and the default prompt", async () => {
      await linked("Doc");
      const document = /** @type {any} */ (await world.callRpc(alice, "exportChannels"));
      assert.equal(document.channels[0].name, "Doc");
      const result = await world.callRpc(bob, "importChannels", { document });
      assert.deepEqual(result, { updated: 0, skipped: ["Doc"] });
      assert.equal(await world.callRpc(alice, "getDefaultPrompt"), DEFAULT_PROMPT);
    });
  });
});

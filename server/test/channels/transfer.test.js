// Channel documents (export, import, the desktop settings file), the default prompt, new video
// folders and the workspace RPC functions.
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
    world = createWorld({ storageRoots: ["share"] });
    alice = world.makeUser("alice@example.com");
    bob = world.makeUser("bob@example.com");
  });
  afterEach(() => world.cleanup());

  const service = () => world.mod.api.channels;
  /** @param {string} name @param {{ id: string }} [user] */
  const linked = (name, user = alice) =>
    service().create(user, {
      name,
      videoType: "auto",
      location: { kind: "link", dir: world.mkdir(`share/${name}-${user.id.slice(0, 4)}`) },
    });
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

    test("a document imports into another account as new channels with new folders", async () => {
      await linked("Tech");
      await linked("News");
      const document = service().exportDocument(alice.id);
      const result = await service().importDocument(bob, document);
      assert.deepEqual(result, { updated: 0, created: 2 });
      const mine = await service().list(bob.id);
      assert.deepEqual(
        mine.map((channel) => channel.name),
        ["Tech", "News"],
      );
      const personal = path.join(world.dataDir, "media", bob.id);
      assert.deepEqual(
        mine.map((channel) => channel.dir),
        [path.join(personal, "Tech"), path.join(personal, "News")],
      );
      assert.ok(mine.every((channel) => fs.statSync(channel.dir).isDirectory()));
      assert.deepEqual(mine[0]?.long, (await service().list(alice.id))[0]?.long);
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
      assert.deepEqual(result, { updated: 1, created: 0 });
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

    test("new folders get a number when the name is taken, and nothing is overwritten", async () => {
      const personal = await world.mod.api.roots.personalFolder(alice.id);
      fs.mkdirSync(path.join(personal, "Tech"));
      fs.writeFileSync(path.join(personal, "Tech", "mine.txt"), "mine");
      const document = { format: "vidai-channels", version: 1, channels: [{ name: "Tech" }] };
      await service().importDocument(alice, document);
      const [channel] = await service().list(alice.id);
      assert.equal(channel?.dir, path.join(personal, "Tech 2"));
      assert.deepEqual(treeOf(path.join(personal, "Tech")), ["mine.txt"]);
    });

    test("a file with a problem changes nothing at all", async () => {
      await linked("Existing");
      const before = treeOf(world.root);
      const rows = (await service().list(alice.id)).length;
      const good = { name: "Good", videoType: "long" };
      for (const channels of [
        [good, { name: "" }],
        [good, { name: "x".repeat(61) }],
        [good, { name: "good" }],
        [good, "text"],
        [good, null],
      ]) {
        await rejectsCode(
          service().importDocument(alice, { format: "vidai-channels", version: 1, channels }),
          "invalidInput",
        );
      }
      assert.deepEqual(treeOf(world.root), before);
      assert.equal((await service().list(alice.id)).length, rows);
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
      await service().importDocument(alice, {
        format: "vidai-channels",
        version: 1,
        extra: true,
        channels: [{ name: "A", videoType: "weird", folder: "/etc" }],
      });
      const [channel] = await service().list(alice.id);
      assert.equal(channel?.videoType, "auto");
      // A "folder" or "dir" in the file is never used.
      assert.ok(channel?.dir.startsWith(path.join(world.dataDir, "media", alice.id)));
    });

    test("a path in a name cannot make the folder go elsewhere", async () => {
      await service().importDocument(alice, {
        format: "vidai-channels",
        version: 1,
        channels: [{ name: "../../escape" }, { name: "a/b" }, { name: ".." }],
      });
      const personal = path.join(world.dataDir, "media", alice.id);
      for (const channel of await service().list(alice.id)) {
        assert.equal(path.dirname(channel.dir), personal, channel.name);
      }
      assert.deepEqual(fs.readdirSync(world.dataDir).sort(), ["media"]);
    });

    test("the desktop settings file imports: folder names are channel names, slots are fixed", async () => {
      const result = await service().importDocument(alice, {
        format: "vidai-settings",
        version: 2,
        general: { reviewSoftware: "fcp" },
        channels: [
          {
            folderName: "Tech",
            long: {
              prompts: [
                { name: "Mine", text: "p0" },
                { name: " Fast ", text: "p1" },
                { name: "", text: "p2" },
              ],
              styles: [{ name: "Default", text: "s0" }],
            },
          },
          { folderName: "Old", videoType: "long", long: { prompt: "legacy", style: "look" } },
        ],
      });
      assert.deepEqual(result, { updated: 0, created: 2 });
      const [tech, old] = await service().list(alice.id);
      assert.deepEqual(
        tech?.long.prompts.map((slot) => [slot.name, slot.text]),
        [
          ["Default", "p0"],
          ["Fast", "p1"],
          ["Prompt 3", "p2"],
          ["Prompt 4", ""],
          ["Prompt 5", ""],
        ],
      );
      assert.equal(tech?.long.styles[4]?.name, "Style 5");
      assert.equal(tech?.videoType, "auto");
      assert.equal(old?.videoType, "long");
      assert.equal(old?.long.prompts[0]?.text, "legacy");
      assert.equal(old?.long.styles[0]?.text, "look");
    });

    test("the desktop file's version limit is 2, a channels file's is 1", () => {
      assert.throws(() => parseDocument({ format: "vidai-settings", version: 3, channels: [] }));
      assert.doesNotThrow(() =>
        parseDocument({ format: "vidai-settings", version: 1, channels: [] }),
      );
      assert.throws(() => parseDocument({ format: "vidai-channels", version: 2, channels: [] }));
    });

    test("what is exported imports back unchanged", async () => {
      const channel = await linked("Round");
      const edited = structuredClone(channel.long);
      /** @type {import("../../../src/lib/wire/channels.ts").ChannelSlot} */ (
        edited.prompts[2]
      ).name = "Custom";
      await service().update(alice.id, channel.id, { long: edited, videoType: "short" });
      const document = service().exportDocument(alice.id);
      await service().importDocument(bob, JSON.parse(JSON.stringify(document)));
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

  describe("new video folders", () => {
    test("makes the folder and answers the video id", async () => {
      const channel = await linked("Chan");
      const video = await service().createVideo(alice.id, channel.id, "  Video 1  ");
      assert.deepEqual(video, {
        id: `${channel.id}/Video 1`,
        channelId: channel.id,
        folderName: "Video 1",
      });
      assert.ok(fs.statSync(path.join(channel.dir, "Video 1")).isDirectory());
      assert.ok(world.emitted.some((e) => e.event === "library-changed"));
    });

    test("an existing name is conflict and its files are untouched", async () => {
      const channel = await linked("Chan");
      fs.mkdirSync(path.join(channel.dir, "Taken"));
      fs.writeFileSync(path.join(channel.dir, "Taken", "a.mp4"), "a");
      await rejectsCode(service().createVideo(alice.id, channel.id, "Taken"), "conflict");
      assert.deepEqual(treeOf(path.join(channel.dir, "Taken")), ["a.mp4"]);
    });

    test("reserved, hidden and path-like names are invalidInput", async () => {
      const channel = await linked("Chan");
      for (const name of [
        "Style",
        "STYLE",
        "Samples",
        "images",
        "Host Pictures",
        "CLAUDE_VE_x",
        ".hidden",
        "..",
        ".",
        "a/b",
        "a\\b",
        "../escape",
        "",
        "   ",
        "x".repeat(121),
        "x\u0000y",
        "evil‮fdp",
      ]) {
        await rejectsCode(service().createVideo(alice.id, channel.id, name), "invalidInput");
      }
      assert.deepEqual(fs.readdirSync(channel.dir), []);
      assert.deepEqual(fs.readdirSync(path.dirname(channel.dir)).includes("escape"), false);
    });

    test("a channel whose folder is gone is conflict, nothing is made", async () => {
      const channel = await linked("Chan");
      fs.renameSync(channel.dir, `${channel.dir}-gone`);
      await rejectsCode(service().createVideo(alice.id, channel.id, "V"), "conflict");
      assert.equal(fs.existsSync(channel.dir), false);
    });

    test("a channel directory that became a link out is conflict, nothing is made outside", async () => {
      const channel = await linked("Chan");
      const outside = world.mkdir("outside");
      fs.renameSync(channel.dir, `${channel.dir}-gone`);
      fs.symlinkSync(outside, channel.dir);
      await rejectsCode(service().createVideo(alice.id, channel.id, "V"), "conflict");
      assert.deepEqual(fs.readdirSync(outside), []);
    });
  });

  describe("video folders", () => {
    test("a video id resolves to its real folder inside the channel", async () => {
      const channel = await linked("Chan");
      await service().createVideo(alice.id, channel.id, "V1");
      const resolved = await world.mod.api.folders.resolveVideo(alice.id, `${channel.id}/V1`);
      assert.equal(resolved.dir, path.join(channel.dir, "V1"));
      assert.equal(resolved.folderName, "V1");
      assert.equal(resolved.channelDir, channel.dir);
    });

    test("reserved folders, files and other users' ids are notFound", async () => {
      const channel = await linked("Chan");
      fs.mkdirSync(path.join(channel.dir, "Style"));
      fs.mkdirSync(path.join(channel.dir, ".hidden"));
      fs.writeFileSync(path.join(channel.dir, "file"), "x");
      await service().createVideo(alice.id, channel.id, "V1");
      const resolve = (/** @type {string} */ user, /** @type {unknown} */ id) =>
        world.mod.api.folders.resolveVideo(user, id);
      for (const id of [
        `${channel.id}/Style`,
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

    test("createChannel, updateChannel, reorderChannels and removeChannel", async () => {
      const dir = world.mkdir("share/rpc");
      const created = /** @type {any} */ (
        await world.callRpc(alice, "createChannel", {
          name: "Rpc",
          videoType: "long",
          location: { kind: "link", dir },
        })
      );
      assert.equal(created.dir, dir);
      const updated = /** @type {any} */ (
        await world.callRpc(alice, "updateChannel", {
          id: created.id,
          update: { name: "Renamed", videoType: null, long: null, short: null },
        })
      );
      assert.equal(updated.name, "Renamed");
      assert.equal(updated.videoType, "long");
      const profile = { prompts: slots("p"), styles: slots("s") };
      const withProfile = /** @type {any} */ (
        await world.callRpc(alice, "updateChannel", {
          id: created.id,
          update: { name: null, videoType: "short", long: profile, short: null },
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
      assert.equal(await world.callRpc(alice, "removeChannel", { id: created.id }), null);
      assert.deepEqual(
        /** @type {any} */ (await world.callRpc(alice, "getWorkspace")).channels,
        [],
      );
    });

    test("input that is not valid is refused before anything happens", async () => {
      const bad = [
        ["createChannel", {}],
        [
          "createChannel",
          {
            name: "x",
            videoType: "weird",
            location: { kind: "new", parent: null, folderName: null },
          },
        ],
        ["createChannel", { name: "x", videoType: "auto", location: { kind: "other" } }],
        ["createChannel", { name: "x", videoType: "auto", location: { kind: "link" } }],
        ["createChannel", { name: "x", videoType: "auto", location: { kind: "link", dir: 5 } }],
        ["updateChannel", { id: "x", update: { long: { prompts: [], styles: [] } } }],
        ["reorderChannels", { ids: "no" }],
        ["removeChannel", {}],
        ["createVideo", { channelId: "x" }],
        ["fsList", { path: 5 }],
        ["fsCreateFolder", { parent: "/x" }],
        ["createUpload", { videoId: "x", folder: "elsewhere", name: "a.mp4", size: 1 }],
        ["createUpload", { videoId: "x", folder: "video", name: "a.mp4", size: "1" }],
        ["cancelUpload", {}],
      ];
      for (const [name, input] of /** @type {[string, unknown][]} */ (bad)) {
        await assert.rejects(
          Promise.resolve().then(() => world.callRpc(alice, name, input)),
          (error) => /** @type {{ code?: string }} */ (error).code === "invalidInput",
          name,
        );
      }
      assert.deepEqual(
        treeOf(world.dataDir).filter((entry) => entry.startsWith("media/")),
        [`media/${alice.id}/`].filter((entry) => treeOf(world.dataDir).includes(entry)),
      );
    });

    test("an empty file is refused by createUpload", async () => {
      const dir = world.mkdir("share/up");
      const channel = await service().create(alice, {
        name: "Up",
        videoType: "auto",
        location: { kind: "link", dir },
      });
      const video = await service().createVideo(alice.id, channel.id, "V");
      await rejectsCode(
        Promise.resolve().then(() =>
          world.callRpc(alice, "createUpload", {
            videoId: video.id,
            folder: "video",
            name: "a.mp4",
            size: 0,
          }),
        ),
        "invalidInput",
      );
      const ticket = /** @type {any} */ (
        await world.callRpc(alice, "createUpload", {
          videoId: video.id,
          folder: "video",
          name: "a.mp4",
          size: 3,
        })
      );
      assert.equal(await world.callRpc(alice, "cancelUpload", { id: ticket.id }), null);
    });

    test("export, import, default prompt and createVideo", async () => {
      const dir = world.mkdir("share/doc");
      const channel = /** @type {any} */ (
        await world.callRpc(alice, "createChannel", {
          name: "Doc",
          videoType: "auto",
          location: { kind: "link", dir },
        })
      );
      const document = /** @type {any} */ (await world.callRpc(alice, "exportChannels"));
      assert.equal(document.channels[0].name, "Doc");
      const result = await world.callRpc(bob, "importChannels", { document });
      assert.deepEqual(result, { updated: 0, created: 1 });
      assert.equal(await world.callRpc(alice, "getDefaultPrompt"), DEFAULT_PROMPT);
      const video = /** @type {any} */ (
        await world.callRpc(alice, "createVideo", { channelId: channel.id, name: "V" })
      );
      assert.equal(video.folderName, "V");
    });
  });
});

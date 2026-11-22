// The admin's channel functions (SPEC section 6, "Channels"): list, create, update (name, owner,
// folder, video type) and remove, who may call them, and what an owner or folder change does to
// the videos, the uploads and the users' views.
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createChannelsService } from "../../src/channels.js";
import { createUploadsRepo } from "../../src/db/uploads.js";
import { createLibraryWorld } from "../library/support.js";
import { DEFAULT_PROMPT, createWorld, rejectsCode } from "../storage/support.js";

/** @typedef {import("../storage/support.js").World} World */

const ADMIN_FUNCTIONS = [
  "adminListChannels",
  "adminCreateChannel",
  "adminUpdateChannel",
  "adminRemoveChannel",
];

describe("admin channels", () => {
  /** @type {World} */
  let world;
  /** @type {{ id: string, email: string, role: "admin" }} */
  let admin;
  /** @type {{ id: string, email: string }} */
  let alice;
  /** @type {{ id: string, email: string }} */
  let bob;
  /** @type {Set<string>} */
  let active;

  beforeEach(() => {
    active = new Set();
    world = createWorld({ hasActiveJobs: (channelId) => active.has(channelId) });
    admin = { ...world.makeAdmin("admin@example.com"), role: /** @type {const} */ ("admin") };
    alice = world.makeUser("alice@example.com");
    bob = world.makeUser("bob@example.com");
    world.emitted.length = 0;
  });
  afterEach(() => world.cleanup());

  /** @param {string} name @param {unknown} [input] */
  const asAdmin = (name, input) => world.callRpc(admin, name, input);
  /** @param {{ id: string }} user @param {string} name @param {{ id?: string }} [extra] */
  const make = (user, name, extra = {}) =>
    asAdmin("adminCreateChannel", {
      name,
      userId: user.id,
      dir: world.mkdir(`area/${name}-${extra.id ?? user.id.slice(0, 4)}`),
      videoType: "auto",
    });
  /** @param {string} id @param {Record<string, unknown>} update */
  const update = (id, update) => asAdmin("adminUpdateChannel", { id, update });
  const emittedFor = () => world.emitted.map((e) => `${e.event}:${e.userId}`);

  describe("who may call them", () => {
    test("a user gets forbidden from every function and nothing changes", async () => {
      const mine = await make(alice, "Mine");
      const dir = world.mkdir("area/Wanted");
      const inputs = /** @type {Record<string, unknown>} */ ({
        adminListChannels: {},
        adminCreateChannel: { name: "X", userId: alice.id, dir, videoType: "auto" },
        adminUpdateChannel: { id: mine.id, update: { userId: bob.id } },
        adminRemoveChannel: { id: mine.id },
      });
      for (const name of ADMIN_FUNCTIONS) {
        await rejectsCode(world.callRpc(alice, name, inputs[name]), "forbidden");
      }
      const all = await asAdmin("adminListChannels");
      assert.deepEqual(
        all.map((/** @type {any} */ c) => [c.name, c.userEmail]),
        [["Mine", "alice@example.com"]],
      );
    });

    test("a disabled owner changes nothing about the admin's view of a channel", async () => {
      const mine = await make(alice, "Mine");
      world.users.update(alice.id, { disabled: true });
      const [row] = await asAdmin("adminListChannels");
      assert.equal(row.id, mine.id);
      assert.equal(row.userId, alice.id);
      assert.equal(row.available, true);
      const moved = await update(mine.id, { userId: bob.id });
      assert.equal(moved.userId, bob.id);
    });

    test("deleting a user removes the user's channel rows", async () => {
      await make(alice, "Mine");
      const others = await make(bob, "Others");
      assert.equal(world.users.delete(alice.id), true);
      const rows = await asAdmin("adminListChannels");
      assert.deepEqual(
        rows.map((/** @type {any} */ c) => c.id),
        [others.id],
      );
    });
  });

  describe("adminListChannels", () => {
    test("orders by owner email, then name, without regard to letter case", async () => {
      await make(bob, "alpha");
      await make(alice, "Zulu");
      await make(alice, "alpha");
      await make(alice, "Bravo");
      const rows = await asAdmin("adminListChannels");
      assert.deepEqual(
        rows.map((/** @type {any} */ c) => `${c.userEmail}/${c.name}`),
        [
          "alice@example.com/alpha",
          "alice@example.com/Bravo",
          "alice@example.com/Zulu",
          "bob@example.com/alpha",
        ],
      );
    });

    test("tells owner, folder, type, availability, video count and busy", async () => {
      const channel = await make(alice, "Tech");
      for (const folder of ["001 A", "002 B", ".hidden", "Style", "CLAUDE_VE x", "upload"]) {
        fs.mkdirSync(path.join(channel.dir, folder));
      }
      fs.writeFileSync(path.join(channel.dir, "notes.txt"), "x");
      const [row] = await asAdmin("adminListChannels");
      assert.deepEqual(row, {
        id: channel.id,
        name: "Tech",
        dir: channel.dir,
        userId: alice.id,
        userEmail: "alice@example.com",
        videoType: "auto",
        available: true,
        videoCount: 2,
        busy: false,
      });
      active.add(channel.id);
      assert.equal((await asAdmin("adminListChannels"))[0].busy, true);
    });

    test("a folder that cannot be reached is unavailable with 0 videos", async () => {
      const channel = await make(alice, "Gone");
      fs.mkdirSync(path.join(channel.dir, "001 A"));
      fs.rmSync(channel.dir, { recursive: true });
      const [row] = await asAdmin("adminListChannels");
      assert.equal(row.available, false);
      assert.equal(row.videoCount, 0);
    });
  });

  describe("adminCreateChannel", () => {
    test("makes the channel for the user, last in their order, with the default profiles", async () => {
      await make(alice, "First");
      const created = await make(alice, "Second");
      assert.equal(created.userId, alice.id);
      assert.equal(created.userEmail, "alice@example.com");
      assert.equal(created.videoCount, 0);
      assert.equal(created.busy, false);
      const own = await world.callRpc(alice, "getWorkspace");
      assert.deepEqual(
        own.channels.map((/** @type {any} */ c) => c.name),
        ["First", "Second"],
      );
      assert.equal(own.channels[1].long.prompts[0].text, DEFAULT_PROMPT);
      assert.equal(own.channels[1].short.prompts[0].text, DEFAULT_PROMPT);
      assert.deepEqual(
        (await world.callRpc(bob, "getWorkspace")).channels,
        [],
        "nobody else sees it",
      );
    });

    test("an unknown user is notFound with field userId, and nothing is made", async () => {
      const error = await rejectsCode(
        asAdmin("adminCreateChannel", {
          name: "X",
          userId: "nobody",
          dir: world.mkdir("area/X"),
          videoType: "auto",
        }),
        "notFound",
      );
      assert.equal(error.field, "userId");
      assert.deepEqual(await asAdmin("adminListChannels"), []);
    });

    test("the name rule: 1 to 60 characters, no control characters, unique per user", async () => {
      const dir = () => world.mkdir(`area/d${Math.random().toString(16).slice(2)}`);
      const create = (/** @type {string} */ name, user = alice) =>
        asAdmin("adminCreateChannel", { name, userId: user.id, dir: dir(), videoType: "auto" });
      for (const bad of ["", "   ", "x".repeat(61), "bad\nname"]) {
        const error = await rejectsCode(create(bad), "invalidInput");
        assert.equal(error.field, "name");
      }
      await create("Tech");
      const error = await rejectsCode(create("TECH"), "conflict");
      assert.equal(error.field, "name");
      assert.equal(error.message, "This user already has a channel with that name.");
      await create("Tech", bob);
    });

    test("the folder rule: it must exist, stay out of the data directory and not overlap a channel", async () => {
      const own = await make(alice, "Own");
      /** @param {string} dir */
      const around = (dir) =>
        asAdmin("adminCreateChannel", { name: "Other", userId: bob.id, dir, videoType: "auto" });
      const missing = await rejectsCode(around(path.join(world.root, "no-such")), "invalidInput");
      assert.equal(missing.field, "dir");
      const data = await rejectsCode(around(world.dataDir), "invalidInput");
      assert.equal(data.field, "dir");
      await rejectsCode(around(own.dir), "conflict");
      await rejectsCode(around(path.dirname(own.dir)), "conflict");
      fs.mkdirSync(path.join(own.dir, "inner"));
      await rejectsCode(around(path.join(own.dir, "inner")), "conflict");
    });

    test("a wrong video type or a missing field is invalidInput", async () => {
      const dir = world.mkdir("area/T");
      await rejectsCode(
        asAdmin("adminCreateChannel", { name: "T", userId: alice.id, dir, videoType: "wide" }),
        "invalidInput",
      );
      await rejectsCode(
        asAdmin("adminCreateChannel", { name: "T", userId: alice.id, videoType: "auto" }),
        "invalidInput",
      );
    });

    test("tells the owner's pages and nobody else", async () => {
      await make(alice, "Mine");
      assert.deepEqual(emittedFor(), [
        `workspace-changed:${alice.id}`,
        `library-changed:${alice.id}`,
      ]);
    });
  });

  describe("adminUpdateChannel", () => {
    test("a null or missing field stays as it is", async () => {
      const channel = await make(alice, "Tech");
      const same = await update(channel.id, {
        name: null,
        userId: null,
        dir: null,
        videoType: null,
      });
      assert.deepEqual(same, channel);
      const type = await update(channel.id, { videoType: "short" });
      assert.deepEqual(type, { ...channel, videoType: "short" });
    });

    test("renames within the owner's names, without regard to letter case", async () => {
      const first = await make(alice, "First");
      await make(alice, "Second");
      await make(bob, "Taken");
      const clash = await rejectsCode(update(first.id, { name: "second" }), "conflict");
      assert.equal(clash.field, "name");
      for (const bad of ["", "x".repeat(61)]) {
        const error = await rejectsCode(update(first.id, { name: bad }), "invalidInput");
        assert.equal(error.field, "name");
      }
      // Another user's channel of that name is no clash; a new letter case of its own name is none.
      assert.equal((await update(first.id, { name: "Taken" })).name, "Taken");
      assert.equal((await update(first.id, { name: "TAKEN" })).name, "TAKEN");
      assert.equal((await update(first.id, { name: "  Trimmed " })).name, "Trimmed");
      const own = await world.callRpc(alice, "getWorkspace");
      assert.deepEqual(
        own.channels.map((/** @type {any} */ c) => c.name),
        ["Trimmed", "Second"],
      );
    });

    test("an unknown channel is notFound and an unknown owner is notFound with field userId", async () => {
      const channel = await make(alice, "Tech");
      await rejectsCode(update("nothing", { name: "X" }), "notFound");
      const error = await rejectsCode(update(channel.id, { userId: "nobody" }), "notFound");
      assert.equal(error.field, "userId");
    });

    test("a name and a video type change while an edit runs, an owner or folder change does not", async () => {
      const channel = await make(alice, "Tech");
      active.add(channel.id);
      assert.equal((await update(channel.id, { name: "Renamed" })).busy, true);
      await update(channel.id, { videoType: "long" });
      const message = "Stop the running edits of this channel's videos first.";
      const byOwner = await rejectsCode(update(channel.id, { userId: bob.id }), "conflict");
      assert.equal(byOwner.message, message);
      const byDir = await rejectsCode(
        update(channel.id, { dir: world.mkdir("area/Elsewhere") }),
        "conflict",
      );
      assert.equal(byDir.message, message);
      const [row] = await asAdmin("adminListChannels");
      assert.equal(row.userId, alice.id);
      assert.equal(row.dir, channel.dir);
      active.clear();
      assert.equal((await update(channel.id, { userId: bob.id })).userId, bob.id);
    });

    test("an owner change puts the channel last in the new owner's order and checks the name there", async () => {
      const a1 = await make(alice, "A1");
      const a2 = await make(alice, "A2");
      await make(bob, "B1");
      await make(bob, "A2", { id: "bob" });
      const clash = await rejectsCode(update(a2.id, { userId: bob.id }), "conflict");
      assert.equal(clash.field, "name");
      const moved = await update(a1.id, { userId: bob.id });
      assert.equal(moved.userId, bob.id);
      assert.equal(moved.userEmail, "bob@example.com");
      // Renaming in the same step lifts the clash.
      await update(a2.id, { userId: bob.id, name: "A2 from Alice" });
      const bobs = await world.callRpc(bob, "getWorkspace");
      assert.deepEqual(
        bobs.channels.map((/** @type {any} */ c) => c.name),
        ["B1", "A2", "A1", "A2 from Alice"],
      );
      const alices = await world.callRpc(alice, "getWorkspace");
      assert.deepEqual(alices.channels, []);
    });

    test("an owner change tells the new and the old owner, and no one else", async () => {
      const channel = await make(alice, "Tech");
      world.emitted.length = 0;
      await update(channel.id, { userId: bob.id });
      assert.deepEqual(
        emittedFor().sort(),
        [
          `library-changed:${alice.id}`,
          `library-changed:${bob.id}`,
          `workspace-changed:${alice.id}`,
          `workspace-changed:${bob.id}`,
        ].sort(),
      );
      world.emitted.length = 0;
      await update(channel.id, { name: "Renamed" });
      assert.deepEqual(emittedFor(), [`workspace-changed:${bob.id}`, `library-changed:${bob.id}`]);
    });

    test("a folder change takes the checked real path and applies the folder rule", async () => {
      const first = await make(alice, "First");
      const second = await make(bob, "Second");
      const target = world.mkdir("area/Target");
      const moved = await update(first.id, { dir: target });
      assert.equal(moved.dir, target);
      // The old folder is free again, its own folder is no clash for itself.
      assert.equal((await update(second.id, { dir: first.dir })).dir, first.dir);
      assert.equal((await update(first.id, { dir: target })).dir, target);
      const taken = await rejectsCode(update(second.id, { dir: target }), "conflict");
      assert.equal(taken.message, "This folder already belongs to a channel.");
      await rejectsCode(update(second.id, { dir: path.dirname(target) }), "conflict");
      const missing = await rejectsCode(
        update(second.id, { dir: path.join(world.root, "no-such") }),
        "invalidInput",
      );
      assert.equal(missing.field, "dir");
      const data = await rejectsCode(update(second.id, { dir: world.dataDir }), "invalidInput");
      assert.equal(data.field, "dir");
      const rows = await asAdmin("adminListChannels");
      assert.equal(rows.find((/** @type {any} */ c) => c.id === second.id).dir, first.dir);
    });

    test("a folder change counts the videos of the new folder", async () => {
      const channel = await make(alice, "Tech");
      const target = world.mkdir("area/Target");
      fs.mkdirSync(path.join(target, "001"));
      fs.mkdirSync(path.join(target, "002"));
      fs.mkdirSync(path.join(target, "003"));
      assert.equal((await update(channel.id, { dir: target })).videoCount, 3);
    });
  });

  describe("adminRemoveChannel", () => {
    test("removes the row and nothing in the folder, and tells the owner", async () => {
      const channel = await make(alice, "Tech");
      fs.mkdirSync(path.join(channel.dir, "001 A"));
      world.emitted.length = 0;
      assert.equal(await asAdmin("adminRemoveChannel", { id: channel.id }), null);
      assert.deepEqual(await asAdmin("adminListChannels"), []);
      assert.ok(fs.existsSync(path.join(channel.dir, "001 A")));
      assert.deepEqual(emittedFor(), [
        `workspace-changed:${alice.id}`,
        `library-changed:${alice.id}`,
      ]);
    });

    test("is conflict while an edit runs and notFound for an unknown channel", async () => {
      const channel = await make(alice, "Tech");
      active.add(channel.id);
      await rejectsCode(asAdmin("adminRemoveChannel", { id: channel.id }), "conflict");
      assert.equal((await asAdmin("adminListChannels")).length, 1);
      await rejectsCode(asAdmin("adminRemoveChannel", { id: "nothing" }), "notFound");
    });
  });
});

describe("admin channels and the videos", () => {
  /** @type {ReturnType<typeof createLibraryWorld>} */
  let w;
  /** @type {{ id: string, email: string, role: "admin" }} */
  let admin;
  /** @type {{ id: string, email: string }} */
  let alice;
  /** @type {{ id: string, email: string }} */
  let bob;

  beforeEach(() => {
    w = createLibraryWorld();
    admin = { id: w.admin.id, email: w.admin.email, role: "admin" };
    alice = w.alice;
    bob = w.bob;
  });
  afterEach(() => w.cleanup());

  const INPUTS = {
    productLinks: "https://example.com/p",
    notes: "Hello",
    promptSlot: 1,
    styleSlot: 2,
  };
  /** @param {string} id @param {Record<string, unknown>} update */
  const update = (id, update) => w.callRpc(admin, "adminUpdateChannel", { id, update });
  /** @param {any} user */
  const libraryOf = async (user) => (await w.call(user, "getLibrary")).channels;
  /** @param {any} user @param {string} channelId */
  const videosOf = async (user, channelId) =>
    (await libraryOf(user))
      .filter((/** @type {any} */ c) => c.channelId === channelId)
      .flatMap((/** @type {any} */ c) => c.videos.map((/** @type {any} */ v) => v.folderName));

  test("after an owner change the old owner sees nothing of the channel and the new owner sees it all", async () => {
    const mine = await w.channelOf(alice, "Tech");
    mine.video("001 A", "clip.mp4");
    mine.video("002 B", "clip.mp4");
    const videoId = `${mine.channel.id}/001 A`;
    await w.call(alice, "setVideoInputs", { videoId, inputs: INPUTS });
    assert.deepEqual(await videosOf(alice, mine.channel.id), ["002 B", "001 A"]);

    await update(mine.channel.id, { userId: bob.id });

    // Alice: no channel, no video, and the id answers notFound like an id that never existed.
    assert.deepEqual(await libraryOf(alice), []);
    assert.deepEqual((await w.callRpc(alice, "getWorkspace")).channels, []);
    const refused = await rejectsCode(w.call(alice, "getVideoInputs", { videoId }), "notFound");
    await rejectsCode(w.call(alice, "setVideoInputs", { videoId, inputs: INPUTS }), "notFound");
    await rejectsCode(w.call(alice, "archiveVideo", { videoId }), "notFound");
    const never = await rejectsCode(
      w.call(alice, "getVideoInputs", { videoId: `${mine.channel.id}/nothing` }),
      "notFound",
    );
    assert.equal(refused.message, never.message);
    // Bob: the channel and its videos, the inputs of the video row followed.
    assert.deepEqual(await videosOf(bob, mine.channel.id), ["002 B", "001 A"]);
    assert.deepEqual(await w.call(bob, "getVideoInputs", { videoId }), INPUTS);
    assert.deepEqual(
      (await w.callRpc(bob, "getWorkspace")).channels.map((/** @type {any} */ c) => c.id),
      [mine.channel.id],
    );
  });

  test("finished jobs, notes and revisions keep their user, and the video rows stay", async () => {
    const mine = await w.channelOf(alice, "Tech");
    mine.video("001 A", "clip.mp4");
    const videoId = `${mine.channel.id}/001 A`;
    await w.call(alice, "setVideoInputs", { videoId, inputs: INPUTS });
    const row = /** @type {{ id: string }} */ (
      w.db.get("SELECT id FROM videos WHERE channel_id = ?", mine.channel.id)
    );
    w.db.run(
      `INSERT INTO jobs (id, video_id, user_id, kind, queue, state, joined_at, video_type)
       VALUES ('job1', ?, ?, 'edit', 'edits', 'completed', 1, 'long')`,
      row.id,
      alice.id,
    );
    w.db.run(
      `INSERT INTO notes (id, video_id, user_id, frame, prompt, state, created_at)
       VALUES ('note1', ?, ?, 0, 'Make it red', 'done', 1)`,
      row.id,
      alice.id,
    );
    w.db.run(
      "INSERT INTO revisions (video_id, n, label, user_id, job_id, created_at) VALUES (?, 1, 'First', ?, 'job1', 1)",
      row.id,
      alice.id,
    );
    w.db.run(
      `INSERT INTO edit_log (at, user_id, user_email, video_label, event, message)
       VALUES (1, ?, 'alice@example.com', 'Tech / 001 A', 'completed', 'Done')`,
      alice.id,
    );

    await update(mine.channel.id, { userId: bob.id });

    assert.equal(w.db.get("SELECT user_id FROM jobs WHERE id = 'job1'")?.user_id, alice.id);
    assert.equal(w.db.get("SELECT user_id FROM notes WHERE id = 'note1'")?.user_id, alice.id);
    assert.equal(w.db.get("SELECT user_id FROM revisions WHERE n = 1")?.user_id, alice.id);
    assert.equal(w.db.get("SELECT COUNT(*) AS n FROM edit_log")?.n, 1);
    assert.equal(w.db.get("SELECT user_id FROM edit_log")?.user_id, alice.id);
    assert.equal(
      w.db.get("SELECT channel_id FROM videos WHERE id = ?", row.id)?.channel_id,
      mine.channel.id,
    );
    assert.equal(w.db.get("SELECT COUNT(*) AS n FROM notes")?.n, 1);
    assert.equal(w.db.get("SELECT COUNT(*) AS n FROM revisions")?.n, 1);
  });

  test("a folder change keeps the video rows: those with a folder in the new directory stay listed, the others wait", async () => {
    const mine = await w.channelOf(alice, "Tech");
    mine.video("001 A", "clip.mp4");
    mine.video("002 B", "clip.mp4");
    const a = `${mine.channel.id}/001 A`;
    const b = `${mine.channel.id}/002 B`;
    await w.call(alice, "setVideoInputs", { videoId: a, inputs: INPUTS });
    await w.call(alice, "setVideoInputs", { videoId: b, inputs: { ...INPUTS, notes: "B" } });
    const rows = () => w.db.get("SELECT COUNT(*) AS n FROM videos")?.n;
    assert.equal(rows(), 2);

    const target = w.mkdir("elsewhere");
    fs.mkdirSync(path.join(target, "001 A"));
    fs.writeFileSync(path.join(target, "001 A", "clip.mp4"), "x");
    fs.mkdirSync(path.join(target, "003 C"));
    fs.writeFileSync(path.join(target, "003 C", "clip.mp4"), "x");

    const moved = await update(mine.channel.id, { dir: target });
    assert.equal(moved.dir, target);
    assert.equal(moved.videoCount, 2);

    assert.deepEqual(await videosOf(alice, mine.channel.id), ["003 C", "001 A"]);
    assert.deepEqual(await w.call(alice, "getVideoInputs", { videoId: a }), INPUTS);
    assert.equal(rows(), 2, "the row of the folder that is not there stays in the database");
    await rejectsCode(w.call(alice, "getVideoInputs", { videoId: b }), "notFound");

    // It comes back when the folder does.
    fs.mkdirSync(path.join(target, "002 B"));
    fs.writeFileSync(path.join(target, "002 B", "clip.mp4"), "x");
    assert.deepEqual(await videosOf(alice, mine.channel.id), ["003 C", "002 B", "001 A"]);
    assert.equal((await w.call(alice, "getVideoInputs", { videoId: b })).notes, "B");
  });

  test("other users cannot reach a moved channel by its id, and the admin has no library function for it", async () => {
    const mine = await w.channelOf(alice, "Tech");
    mine.video("001 A", "clip.mp4");
    const videoId = `${mine.channel.id}/001 A`;
    await update(mine.channel.id, { userId: bob.id });
    await rejectsCode(w.call(admin, "getVideoInputs", { videoId }), "notFound");
    await rejectsCode(w.call(alice, "getVideoInputs", { videoId }), "notFound");
    assert.deepEqual(await w.call(bob, "getVideoInputs", { videoId }), {
      productLinks: "",
      notes: "",
      promptSlot: 0,
      styleSlot: 0,
    });
  });
});

describe("admin channels and unfinished uploads", () => {
  /** @type {World} */
  let world;
  /** @type {{ id: string }} */
  let alice;
  /** @type {{ id: string }} */
  let bob;
  /** @type {Set<string>} */
  let active;
  /** @type {string[]} */
  let cancelled;
  /** @type {ReturnType<typeof createChannelsService>} */
  let service;

  beforeEach(() => {
    active = new Set();
    cancelled = [];
    world = createWorld({ hasActiveJobs: (channelId) => active.has(channelId) });
    alice = world.makeUser("alice@example.com");
    bob = world.makeUser("bob@example.com");
    // The same service as the module's, with an uploads service that only records the calls.
    service = createChannelsService({
      db: world.db,
      channels: world.mod.api.channelsRepo,
      guard: world.mod.api.guard,
      uploads: {
        async cancelAllForChannel(channelId) {
          // The row still has its old owner and folder when the part files are looked for.
          const row = world.mod.api.channelsRepo.byId(channelId);
          cancelled.push(`${channelId}:${row?.userId}:${row?.dir}`);
        },
      },
      events: { emit: () => {} },
      clock: world.clock,
      hasActiveJobs: (channelId) => active.has(channelId),
      defaultPromptPaths: [path.join(world.root, "default_prompt.md")],
    });
  });
  afterEach(() => world.cleanup());

  const make = (/** @type {string} */ name, /** @type {{ id: string }} */ user = alice) =>
    service.adminCreate({
      name,
      userId: user.id,
      dir: world.mkdir(`area/${name}`),
      videoType: "auto",
    });
  const noCancel = { name: null, userId: null, dir: null, videoType: null };

  test("an owner change and a folder change cancel them, before the row changes", async () => {
    const channel = await make("Tech");
    await service.adminUpdate(channel.id, { ...noCancel, userId: bob.id });
    assert.deepEqual(cancelled, [`${channel.id}:${alice.id}:${channel.dir}`]);
    cancelled.length = 0;
    const target = world.mkdir("area/Target");
    await service.adminUpdate(channel.id, { ...noCancel, dir: target });
    assert.deepEqual(cancelled, [`${channel.id}:${bob.id}:${channel.dir}`]);
  });

  test("a rename, a video type change and the same owner or folder cancel nothing", async () => {
    const channel = await make("Tech");
    await service.adminUpdate(channel.id, { ...noCancel, name: "Renamed", videoType: "long" });
    await service.adminUpdate(channel.id, { ...noCancel, userId: alice.id, dir: channel.dir });
    assert.deepEqual(cancelled, []);
  });

  test("a refused change cancels nothing", async () => {
    const channel = await make("Tech");
    const other = await make("Other", bob);
    active.add(channel.id);
    await rejectsCode(service.adminUpdate(channel.id, { ...noCancel, userId: bob.id }), "conflict");
    active.clear();
    await rejectsCode(service.adminUpdate(channel.id, { ...noCancel, dir: other.dir }), "conflict");
    await rejectsCode(
      service.adminUpdate(channel.id, { ...noCancel, userId: "nobody" }),
      "notFound",
    );
    assert.deepEqual(cancelled, []);
  });

  test("the real uploads service ends the rows of the channel and of its videos", async () => {
    const channel = await world.mod.api.channels.create({
      name: "Real",
      userId: alice.id,
      dir: world.mkdir("area/Real"),
      videoType: "auto",
    });
    fs.mkdirSync(path.join(channel.dir, "001 A"));
    const repo = createUploadsRepo(world.db, { clock: world.clock });
    for (const folderName of [null, "001 A"]) {
      repo.create({
        userId: alice.id,
        channelId: channel.id,
        folderName,
        name: "a.mp4",
        size: 10,
      });
    }
    const count = () => world.db.get("SELECT COUNT(*) AS n FROM uploads")?.n;
    assert.equal(count(), 2);
    await world.callRpc({ id: "admin", role: "admin" }, "adminUpdateChannel", {
      id: channel.id,
      update: { userId: bob.id },
    });
    assert.equal(count(), 0);
  });

  test("removing a channel cancels them too", async () => {
    const channel = await make("Tech");
    await service.remove(channel.id);
    assert.deepEqual(cancelled, [`${channel.id}:${alice.id}:${channel.dir}`]);
  });
});

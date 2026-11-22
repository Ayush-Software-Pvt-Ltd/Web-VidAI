import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createSessions } from "../../src/auth/sessions.js";
import { createSetup } from "../../src/auth/setup.js";
import { createThrottle } from "../../src/auth/throttle.js";
import { createSessionsRepo } from "../../src/db/sessions.js";
import { createSettingsRepo } from "../../src/db/settings.js";
import { createSecrets } from "../../src/secrets.js";
import { createSettings } from "../../src/settings.js";
import { createRpc } from "../../src/rpc/index.js";
import { createDiskWorld, layoutVideo } from "../disk/support.js";
import { rejectsWith } from "./support.js";

/** The disk functions registered in a real `createRpc`, with real sessions. */
function createRpcWorld() {
  const w = createDiskWorld();
  const sessions = createSessions({
    sessions: createSessionsRepo(w.db),
    users: w.users,
    clock: w.clock,
  });
  const rpc = createRpc({
    db: w.db,
    users: w.users,
    sessions,
    settings: createSettings({ repo: createSettingsRepo(w.db) }),
    secrets: createSecrets({ db: w.db, keyFile: "unused", memory: true }),
    throttle: createThrottle({ clock: w.clock }),
    setup: createSetup({ users: w.users, log: { info() {}, warn() {} } }),
    events: { emit() {}, closeUser() {} },
    clock: w.clock,
    version: "test",
  });
  rpc.register(w.disk.rpc);
  /** @param {{ id: string } | null} user */
  const ctx = (user) => {
    const meta = { address: "10.0.0.1", userAgent: "test" };
    const session = user ? sessions.authenticate(sessions.create(user.id, meta).token, meta) : null;
    return { ...meta, session, setSessionCookie: () => {} };
  };
  return {
    ...w,
    rpc,
    ctx,
    /** @param {{ id: string } | null} user @param {string} name @param {unknown} [input] */
    call: (user, name, input) => /** @type {Promise<any>} */ (rpc.call(name, input, ctx(user))),
  };
}

test("both functions are registered and need a session", async () => {
  const w = createRpcWorld();
  try {
    assert.ok(w.rpc.names().includes("getDiskUse"));
    assert.ok(w.rpc.names().includes("cleanWorkingFiles"));
    await rejectsWith(w.call(null, "getDiskUse"), "unauthenticated");
    await rejectsWith(w.call(null, "cleanWorkingFiles", { videoId: "a/b" }), "unauthenticated");
  } finally {
    w.cleanup();
  }
});

test("getDiskUse answers the signed-in user's videos only", async () => {
  const w = createRpcWorld();
  try {
    const mine = await w.channelOf(w.alice, "Mine");
    const theirs = await w.channelOf(w.bob, "Theirs");
    layoutVideo(mine.video("ep"));
    theirs.video("secret");
    const use = await w.call(w.alice, "getDiskUse");
    assert.deepEqual(
      use.videos.map((/** @type {any} */ v) => v.folderName),
      ["ep"],
    );
    assert.deepEqual(Object.keys(use).sort(), ["measuring", "totals", "videos"]);
    assert.deepEqual(Object.keys(use.videos[0]).sort(), [
      "archived",
      "channelId",
      "channelName",
      "folderName",
      "measuredAt",
      "measuring",
      "sizes",
      "videoId",
    ]);
    await w.scheduler.drain();
    const done = await w.call(w.alice, "getDiskUse");
    assert.deepEqual(Object.keys(done.videos[0].sizes).sort(), [
      "finals",
      "project",
      "sources",
      "total",
      "working",
    ]);
    assert.equal(done.totals.total, 1755);
    assert.deepEqual(await w.call(w.bob, "getDiskUse").then((u) => u.videos.length), 1);
  } finally {
    w.cleanup();
  }
});

test("getDiskUse takes no input", async () => {
  const w = createRpcWorld();
  try {
    await rejectsWith(w.call(w.alice, "getDiskUse", { videoId: "x" }), "invalidInput");
  } finally {
    w.cleanup();
  }
});

test("cleanWorkingFiles checks its input", async () => {
  const w = createRpcWorld();
  try {
    for (const input of [{}, { videoId: 5 }, { videoId: "" }, { videoId: "a/b", extra: 1 }]) {
      await rejectsWith(w.call(w.alice, "cleanWorkingFiles", input), "invalidInput");
    }
  } finally {
    w.cleanup();
  }
});

test("cleanWorkingFiles cleans the user's own video", async () => {
  const w = createRpcWorld();
  try {
    const mine = await w.channelOf(w.alice, "Mine");
    const dir = mine.video("ep");
    layoutVideo(dir);
    const result = await w.call(w.alice, "cleanWorkingFiles", { videoId: `${mine.channel.id}/ep` });
    assert.deepEqual(result, { freedBytes: 340, leftover: 0 });
    assert.deepEqual(fs.readdirSync(path.join(dir, "CLAUDE_VE")), []);
    const log = await w.call(w.alice, "cleanWorkingFiles", { videoId: `${mine.channel.id}/ep` });
    assert.deepEqual(log, { freedBytes: 0, leftover: 0 }, "an empty working folder is fine");
  } finally {
    w.cleanup();
  }
});

test("cleanWorkingFiles never touches another user's video, with the message of a missing one", async () => {
  const w = createRpcWorld();
  try {
    const theirs = await w.channelOf(w.bob, "Theirs");
    const dir = theirs.video("ep");
    layoutVideo(dir);
    const foreign = await w
      .call(w.alice, "cleanWorkingFiles", { videoId: `${theirs.channel.id}/ep` })
      .catch((error) => error);
    const missing = await w
      .call(w.alice, "cleanWorkingFiles", { videoId: `${theirs.channel.id}/nope` })
      .catch((error) => error);
    assert.equal(foreign.code, "notFound");
    assert.equal(foreign.message, missing.message);
    assert.ok(fs.existsSync(path.join(dir, "CLAUDE_VE/scratch.bin")));
  } finally {
    w.cleanup();
  }
});

test("an admin may clean anybody's video", async () => {
  const w = createRpcWorld();
  try {
    const theirs = await w.channelOf(w.bob, "Theirs");
    const dir = theirs.video("ep");
    layoutVideo(dir);
    const result = await w.call(w.admin, "cleanWorkingFiles", {
      videoId: `${theirs.channel.id}/ep`,
    });
    assert.equal(result.freedBytes, 340);
    assert.deepEqual(fs.readdirSync(path.join(dir, "CLAUDE_VE")), []);
  } finally {
    w.cleanup();
  }
});

test("a refusal reaches the caller as a conflict with a sentence for the user", async () => {
  const w = createRpcWorld();
  try {
    const mine = await w.channelOf(w.alice, "Mine");
    mine.video("ep");
    await rejectsWith(
      w.call(w.alice, "cleanWorkingFiles", { videoId: `${mine.channel.id}/ep` }),
      "conflict",
      /no working files to delete/,
    );
  } finally {
    w.cleanup();
  }
});

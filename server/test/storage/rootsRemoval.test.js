// Taking a storage folder out of the admin's list while channels lie in it (docs/SPEC.md sections
// 5 and 6): refused with a sentence that names the folder and counts channels and users; the
// default storage folder can never be removed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createWorld, rejectsCode } from "./support.js";

/**
 * @param {import("./support.js").World} world
 * @param {Record<string, unknown>} change
 */
const beforeChange = (world, change) =>
  world.mod.hooks.beforeSettingsChange(/** @type {never} */ (world.settings.check(change)));

/**
 * A channel of the user whose folder is `relative` (made) under the world's root.
 * @param {import("./support.js").World} world
 * @param {{ id: string }} user
 * @param {string} name
 * @param {string} relative
 */
const channelIn = (world, user, name, relative) =>
  world.makeChannel(user, name, { location: { kind: "link", dir: world.mkdir(relative) } });

test("a folder with channels cannot be removed: the sentence names it and counts", async (t) => {
  const world = createWorld({ storageRoots: ["share"] });
  t.after(world.cleanup);
  const alice = world.makeUser("alice@example.com");
  const bob = world.makeUser("bob@example.com");
  await channelIn(world, alice, "One", "share/one");
  await channelIn(world, alice, "Two", "share/two");
  await channelIn(world, bob, "Three", "share/three");
  const share = path.join(world.root, "share");

  const error = await rejectsCode(beforeChange(world, { storageRoots: [] }), "conflict");
  assert.equal(error.message, `3 channels of 2 users are in ${share}. Move or remove them first.`);
  // The setting was not touched by the check.
  assert.deepEqual(world.settings.getAll().storageRoots, [share]);
});

test("one channel of one user: the sentence is singular", async (t) => {
  const world = createWorld({ storageRoots: ["share"] });
  t.after(world.cleanup);
  const alice = world.makeUser("alice@example.com");
  await channelIn(world, alice, "One", "share/one");
  const error = await rejectsCode(beforeChange(world, { storageRoots: [] }), "conflict");
  assert.equal(
    error.message,
    `1 channel of 1 user is in ${path.join(world.root, "share")}. Move or remove it first.`,
  );
});

test("an empty folder, a folder that stays and other settings are not refused", async (t) => {
  const world = createWorld({ storageRoots: ["share", "other"] });
  t.after(world.cleanup);
  const alice = world.makeUser("alice@example.com");
  await channelIn(world, alice, "One", "share/one");
  const share = path.join(world.root, "share");
  const other = path.join(world.root, "other");
  // The empty folder goes, the one with the channel stays.
  await beforeChange(world, { storageRoots: [share] });
  // Nothing about the folders: nothing to check.
  await beforeChange(world, { maxEdits: 3 });
  // Adding a folder is fine.
  await beforeChange(world, { storageRoots: [share, other, path.join(world.root, "new")] });
});

test("channels in the default folder never block anything, and it cannot be removed", async (t) => {
  const world = createWorld({ storageRoots: ["share"] });
  t.after(world.cleanup);
  const alice = world.makeUser("alice@example.com");
  await world.makeChannel(alice, "Mine");
  await beforeChange(world, { storageRoots: [] });
  world.settings.update({ storageRoots: [] });
  const roots = await world.mod.api.roots.list();
  assert.equal(roots.length, 1);
  assert.equal(roots[0]?.isMedia, true);
  assert.equal(roots[0]?.path, fs.realpathSync(path.join(world.dataDir, "media")));
  // Writing the default folder into the list changes nothing: it is listed once and stays.
  world.settings.update({ storageRoots: [path.join(world.dataDir, "media")] });
  assert.equal((await world.mod.api.roots.list()).length, 1);
  await beforeChange(world, { storageRoots: [] });
});

test("real paths are compared: a link to the folder, and the folder spelled differently", async (t) => {
  const world = createWorld({ storageRoots: ["share"] });
  t.after(world.cleanup);
  const alice = world.makeUser("alice@example.com");
  await channelIn(world, alice, "One", "share/one");
  const share = path.join(world.root, "share");
  const link = path.join(world.root, "link-to-share");
  fs.symlinkSync(share, link);

  // The same real folder is still listed under another spelling: nothing is removed.
  await beforeChange(world, { storageRoots: [link] });
  // A new list that holds a folder around the channel keeps it inside a storage folder.
  await beforeChange(world, { storageRoots: [world.root] });
  // A link to the folder that is removed does not hide the channels in it.
  world.settings.update({ storageRoots: [link] });
  const error = await rejectsCode(beforeChange(world, { storageRoots: [] }), "conflict");
  assert.match(error.message, /^1 channel of 1 user is in /);
  assert.ok(error.message.includes(link));
});

test("a folder that cannot be reached right now still holds its channels", async (t) => {
  const world = createWorld({ storageRoots: ["share"] });
  t.after(world.cleanup);
  const alice = world.makeUser("alice@example.com");
  await channelIn(world, alice, "One", "share/one");
  // The share is unmounted (here: renamed away).
  fs.renameSync(path.join(world.root, "share"), path.join(world.root, "gone"));
  const error = await rejectsCode(beforeChange(world, { storageRoots: [] }), "conflict");
  assert.match(error.message, /^1 channel of 1 user is in /);
});

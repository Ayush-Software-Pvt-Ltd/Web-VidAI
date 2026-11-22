import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../../src/db/open.js";
import { createChannelsRepo } from "../../src/db/channels.js";
import { createUsersRepo } from "../../src/db/users.js";
import { createUploadsRepo } from "../../src/db/uploads.js";
import { createVideosRepo, emptyInputs, parseInputs, validateInputs } from "../../src/db/videos.js";
import { createFakeClock } from "../storage/support.js";

const PROFILE = {
  prompts: Array.from({ length: 5 }, (_, i) => ({ name: `P${i}`, text: "" })),
  styles: Array.from({ length: 5 }, (_, i) => ({ name: `S${i}`, text: "" })),
};

function setup() {
  const clock = createFakeClock();
  const db = openDatabase(":memory:", { clock });
  const users = createUsersRepo(db, { clock });
  const channels = createChannelsRepo(db, { clock });
  const user = users.create({
    email: "u@example.com",
    passwordHash: "h",
    role: "user",
    mayMarkUrgent: false,
  });
  const channel = channels.create({
    userId: user.id,
    name: "One",
    dir: "/x/one",
    videoType: "auto",
    long: PROFILE,
    short: PROFILE,
  });
  return { clock, db, user, channel, channels, videos: createVideosRepo(db, { clock }) };
}

test("ensure makes one row with a 16 byte hex key and is idempotent", () => {
  const { videos, channel, clock } = setup();
  assert.equal(videos.find(channel.id, "001 A"), undefined);
  const first = videos.ensure(channel.id, "001 A");
  assert.match(first.key, /^[0-9a-f]{32}$/);
  assert.equal(first.createdAt, clock.now());
  assert.equal(first.typeOverride, null);
  assert.deepEqual(first.inputs, emptyInputs());
  assert.equal(first.archivedAt, null);
  clock.advance(1000);
  const again = videos.ensure(channel.id, "001 A");
  assert.deepEqual(again, first);
  assert.deepEqual(videos.find(channel.id, "001 A"), first);
  assert.deepEqual(videos.byKey(first.key), first);
  assert.equal(videos.byKey("nope"), undefined);
  assert.notEqual(videos.ensure(channel.id, "002 B").key, first.key);
});

test("listForChannels returns the rows of those channels only", () => {
  const { videos, channel, channels, user } = setup();
  const other = channels.create({
    userId: user.id,
    name: "Two",
    dir: "/x/two",
    videoType: "auto",
    long: PROFILE,
    short: PROFILE,
  });
  videos.ensure(channel.id, "a");
  videos.ensure(channel.id, "b");
  videos.ensure(other.id, "c");
  assert.deepEqual(
    videos
      .listForChannels([channel.id])
      .map((v) => v.folderName)
      .sort(),
    ["a", "b"],
  );
  assert.equal(videos.listForChannels([channel.id, other.id]).length, 3);
  assert.deepEqual(videos.listForChannels([]), []);
});

test("type override, session, progress memory and archive are stored and cleared", () => {
  const { videos, channel } = setup();
  const { key } = videos.ensure(channel.id, "v");
  videos.setTypeOverride(key, "short");
  assert.equal(videos.byKey(key)?.typeOverride, "short");
  videos.setTypeOverride(key, null);
  assert.equal(videos.byKey(key)?.typeOverride, null);

  videos.setSession(key, "sess-1", "opencode2");
  assert.deepEqual(
    [videos.byKey(key)?.sessionId, videos.byKey(key)?.sessionHarness],
    ["sess-1", "opencode2"],
  );
  videos.clearSession(key);
  assert.deepEqual([videos.byKey(key)?.sessionId, videos.byKey(key)?.sessionHarness], [null, null]);
  assert.throws(() => videos.setSession(key, "s", /** @type {never} */ ("other")));
  assert.throws(() => videos.setSession(key, "", "claudeCode"));

  assert.equal(videos.byKey(key)?.progressMemory, null);
  videos.setProgressMemory(key, { seconds: [1, 2] });
  assert.deepEqual(videos.byKey(key)?.progressMemory, { seconds: [1, 2] });
  videos.setProgressMemory(key, null);
  assert.equal(videos.byKey(key)?.progressMemory, null);

  videos.setArchived(key, 5000);
  assert.equal(videos.byKey(key)?.archivedAt, 5000);
  videos.setArchived(key, null);
  assert.equal(videos.byKey(key)?.archivedAt, null);
});

test("listArchived lists archived rows newest first", () => {
  const { videos, channel } = setup();
  const a = videos.ensure(channel.id, "a");
  const b = videos.ensure(channel.id, "b");
  videos.ensure(channel.id, "c");
  videos.setArchived(a.key, 100);
  videos.setArchived(b.key, 200);
  assert.deepEqual(
    videos.listArchived([channel.id]).map((v) => v.folderName),
    ["b", "a"],
  );
  assert.deepEqual(videos.listArchived([]), []);
});

test("inputs are validated on the way in and read leniently on the way out", () => {
  const { videos, channel, db } = setup();
  const { key } = videos.ensure(channel.id, "v");
  const good = { productLinks: "https://example.com/a", notes: "n", promptSlot: 2, styleSlot: 4 };
  assert.deepEqual(videos.setInputs(key, good), good);
  assert.deepEqual(videos.getInputs(key), good);
  assert.equal(videos.getInputs("missing"), undefined);

  const bad = [
    null,
    [],
    "x",
    { ...good, extra: 1 },
    { ...good, productLinks: 3 },
    { ...good, notes: "x".repeat(20_001) },
    { ...good, promptSlot: 5 },
    { ...good, styleSlot: -1 },
    { ...good, promptSlot: 1.5 },
    { ...good, styleSlot: "1" },
    { notes: "", promptSlot: 0, styleSlot: 0 },
  ];
  for (const input of bad) {
    assert.throws(
      () => videos.setInputs(key, input),
      { code: "invalidInput" },
      JSON.stringify(input),
    );
    assert.throws(() => validateInputs(input), { code: "invalidInput" });
  }
  assert.deepEqual(videos.getInputs(key), good, "a refused change leaves the stored inputs");

  // A damaged stored value falls back to the default field by field.
  db.run(
    "UPDATE videos SET inputs = ? WHERE id = ?",
    JSON.stringify({ productLinks: "keep", notes: 5, promptSlot: 9, styleSlot: 3 }),
    key,
  );
  assert.deepEqual(videos.getInputs(key), {
    productLinks: "keep",
    notes: "",
    promptSlot: 0,
    styleSlot: 3,
  });
  assert.deepEqual(parseInputs("not json"), emptyInputs());
  assert.deepEqual(parseInputs("[1]"), emptyInputs());
  assert.deepEqual(parseInputs(null), emptyInputs());
});

test("removing a channel removes its videos; removing a video removes its uploads", () => {
  const { videos, channel, db, channels, user, clock } = setup();
  const uploads = createUploadsRepo(db, { clock });
  const upload = uploads.create({
    userId: user.id,
    channelId: channel.id,
    folderName: "v",
    name: "a.mp4",
    size: 10,
  });
  const channelUpload = uploads.create({
    userId: user.id,
    channelId: channel.id,
    folderName: null,
    name: "logo.png",
    size: 10,
  });
  assert.equal(channelUpload.videoKey, null);
  assert.equal(channelUpload.folderName, null);
  assert.equal(uploads.countInProgress(channel.id, "v"), 1, "only the video's own upload counts");
  const row = videos.find(channel.id, "v");
  assert.ok(row, "an upload makes the video row through the repository");
  assert.equal(upload.videoKey, row.key);
  videos.ensure(channel.id, "w");

  videos.remove(row.key);
  assert.equal(videos.byKey(row.key), undefined);
  assert.equal(uploads.byId(upload.id), undefined);
  assert.ok(uploads.byId(channelUpload.id), "a channel upload belongs to no video");
  assert.deepEqual(
    uploads.listForTarget(channel.id, null).map((row) => row.id),
    [channelUpload.id],
  );

  channels.delete(channel.id);
  assert.equal(uploads.byId(channelUpload.id), undefined);
  assert.deepEqual(videos.listForChannels([channel.id]), []);
});

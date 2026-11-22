import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createUploadsRepo } from "../../src/db/uploads.js";
import { createLibraryWorld, fakeJobs, rejectsCode, settle, write } from "./support.js";

/** @param {ReturnType<typeof createLibraryWorld>} w */
const libraryChanged = (w) => w.libraryEvents.filter((event) => event.event === "library-changed");

test("getLibrary lists the user's channels and videos, newest first", async () => {
  const w = createLibraryWorld();
  try {
    const main = await w.channelOf(w.alice);
    main.video("001 A", "clip.mp4");
    main.video("002 B");
    const library = await w.call(w.alice, "getLibrary");
    assert.equal(library.channels.length, 1);
    const [channel] = library.channels;
    assert.equal(channel.channelId, main.channel.id);
    assert.equal(channel.available, true);
    assert.deepEqual(
      channel.videos.map((/** @type {any} */ v) => v.folderName),
      ["002 B", "001 A"],
    );
    const a = channel.videos[1];
    assert.equal(a.id, `${main.channel.id}/001 A`);
    assert.equal(a.arollCount, 1);
    assert.equal(a.job, null);
    assert.equal(a.edited, false);
    assert.equal(a.finalRendered, false);
    assert.equal(a.uploading, false);
    assert.deepEqual(a.actions, ["startEdit", "upload"]);
  } finally {
    w.cleanup();
  }
});

test("a missing channel directory is unavailable, not an error", async () => {
  const w = createLibraryWorld();
  try {
    const main = await w.channelOf(w.alice);
    main.video("001 A");
    fs.renameSync(main.dir, `${main.dir}-moved`);
    const library = await w.call(w.alice, "getLibrary");
    assert.deepEqual(library.channels, [
      { channelId: main.channel.id, available: false, videos: [] },
    ]);
  } finally {
    w.cleanup();
  }
});

test("an unchanged result emits nothing, a changed one emits once", async () => {
  const w = createLibraryWorld();
  try {
    const main = await w.channelOf(w.alice);
    main.video("001 A");
    await w.library.api.rescan(w.alice.id);
    assert.equal(libraryChanged(w).length, 1);
    const first = libraryChanged(w)[0];
    assert.equal(first.userId, w.alice.id);
    assert.equal(first.admins, false);

    await w.library.api.rescan(w.alice.id);
    await w.library.api.rescan(w.alice.id);
    assert.equal(libraryChanged(w).length, 1, "no change, no event");

    main.video("002 B");
    await w.library.api.rescan(w.alice.id);
    assert.equal(libraryChanged(w).length, 2);
    const payload = /** @type {{ channels: { videos: unknown[] }[] }} */ (
      libraryChanged(w)[1].payload
    );
    assert.equal(payload.channels[0].videos.length, 2);
    await w.library.api.rescan(w.alice.id);
    assert.equal(libraryChanged(w).length, 2);
  } finally {
    w.cleanup();
  }
});

test("getLibrary tells other pages about a change it found, once", async () => {
  const w = createLibraryWorld();
  try {
    const main = await w.channelOf(w.alice);
    await w.call(w.alice, "getLibrary");
    const before = libraryChanged(w).length;
    await w.call(w.alice, "getLibrary");
    assert.equal(libraryChanged(w).length, before);
    main.video("001 A");
    await w.call(w.alice, "getLibrary");
    assert.equal(libraryChanged(w).length, before + 1);
    await w.call(w.alice, "getLibrary");
    assert.equal(libraryChanged(w).length, before + 1);
  } finally {
    w.cleanup();
  }
});

test("the timer rescans only the users with an open event stream", async () => {
  const w = createLibraryWorld({ watchedUsers: [] });
  try {
    const a = await w.channelOf(w.alice);
    const b = await w.channelOf(w.bob);
    a.video("a1");
    b.video("b1");
    w.library.start();
    assert.equal(w.fake.active(), 1);
    w.fake.tick();
    await settle();
    assert.equal(libraryChanged(w).length, 0, "nobody watches");

    // The watchers array is read at every tick.
    w.watching.push(w.alice.id);
    w.fake.tick();
    await settle();
    assert.deepEqual(
      libraryChanged(w).map((e) => e.userId),
      [w.alice.id],
    );
    a.video("a2");
    b.video("b2");
    w.fake.tick();
    await settle();
    assert.equal(libraryChanged(w).length, 2);
    assert.ok(libraryChanged(w).every((e) => e.userId === w.alice.id));

    w.library.stop();
    assert.equal(w.fake.active(), 0);
    w.library.start();
    w.library.start();
    assert.equal(w.fake.active(), 1, "starting twice keeps one timer");
  } finally {
    w.cleanup();
  }
});

test("rescans of one user are coalesced: a burst makes at most one extra scan", async () => {
  const w = createLibraryWorld();
  try {
    const main = await w.channelOf(w.alice);
    main.video("001 A");
    const scans = [];
    for (let i = 0; i < 6; i += 1) scans.push(w.library.api.rescan(w.alice.id));
    // Every caller gets a promise that finishes; a change made now is seen by the extra scan.
    main.video("002 B");
    scans.push(w.library.api.rescan(w.alice.id));
    await Promise.all(scans);
    const events = libraryChanged(w);
    assert.ok(events.length <= 2, `at most two events, got ${events.length}`);
    const last = /** @type {{ channels: { videos: unknown[] }[] }} */ (events.at(-1)?.payload);
    assert.equal(last.channels[0].videos.length, 2);
  } finally {
    w.cleanup();
  }
});

test("skipIfBusy joins the running scan without asking for another", async () => {
  const w = createLibraryWorld();
  try {
    const main = await w.channelOf(w.alice);
    main.video("001 A");
    const first = w.library.api.rescan(w.alice.id);
    const second = w.library.api.rescan(w.alice.id, { skipIfBusy: true });
    main.video("002 B");
    await Promise.all([first, second]);
    const last = /** @type {{ channels: { videos: unknown[] }[] }} */ (
      libraryChanged(w).at(-1)?.payload
    );
    // The video made after the scan started is not promised to be in it.
    assert.ok(last.channels[0].videos.length >= 1);
  } finally {
    w.cleanup();
  }
});

test("a user whose account is gone is not scanned and is forgotten", async () => {
  const w = createLibraryWorld();
  try {
    const main = await w.channelOf(w.alice);
    main.video("001 A");
    await w.library.api.rescan(w.alice.id);
    const before = libraryChanged(w).length;
    w.users.delete(w.alice.id);
    await w.library.api.rescan(w.alice.id);
    assert.equal(libraryChanged(w).length, before);
  } finally {
    w.cleanup();
  }
});

test("archiving removes a video from the list and archive history survives", async () => {
  const w = createLibraryWorld();
  try {
    const main = await w.channelOf(w.alice);
    main.video("001 A");
    main.video("002 B");
    const id = `${main.channel.id}/001 A`;
    await w.call(w.alice, "archiveVideo", { videoId: id });
    const library = await w.call(w.alice, "getLibrary");
    assert.deepEqual(
      library.channels[0].videos.map((/** @type {any} */ v) => v.folderName),
      ["002 B"],
    );
    const archived = await w.call(w.alice, "getArchived");
    assert.deepEqual(
      archived.map((/** @type {any} */ a) => [a.videoId, a.folderName, a.channelName]),
      [[id, "001 A", main.channel.name]],
    );
    assert.equal(archived[0].archivedAt, w.clock.now());

    // Archiving again changes nothing.
    w.clock.advance(5000);
    await w.call(w.alice, "archiveVideo", { videoId: id });
    assert.equal((await w.call(w.alice, "getArchived"))[0].archivedAt, archived[0].archivedAt);

    await w.call(w.alice, "unarchiveVideo", { videoId: id });
    await w.call(w.alice, "unarchiveVideo", { videoId: id });
    assert.deepEqual(await w.call(w.alice, "getArchived"), []);
    const again = await w.call(w.alice, "getLibrary");
    assert.deepEqual(
      again.channels[0].videos.map((/** @type {any} */ v) => v.folderName),
      ["002 B", "001 A"],
    );
  } finally {
    w.cleanup();
  }
});

test("archived videos are not scanned and a vanished archived folder leaves the archive", async () => {
  const w = createLibraryWorld();
  try {
    const main = await w.channelOf(w.alice);
    main.video("001 A");
    main.video("002 B");
    await w.call(w.alice, "archiveVideo", { videoId: `${main.channel.id}/001 A` });
    await w.call(w.alice, "archiveVideo", { videoId: `${main.channel.id}/002 B` });
    fs.rmSync(path.join(main.dir, "002 B"), { recursive: true });
    const library = await w.call(w.alice, "getLibrary");
    assert.deepEqual(library.channels[0].videos, []);
    const archived = await w.call(w.alice, "getArchived");
    assert.deepEqual(
      archived.map((/** @type {any} */ a) => a.folderName),
      ["001 A"],
    );
    // The pruned row is no longer archived (its job history is kept in the row).
    const row = w.library.api.videos.find(main.channel.id, "002 B");
    assert.equal(row?.archivedAt, null);
  } finally {
    w.cleanup();
  }
});

test("an unavailable channel never prunes the archive", async () => {
  const w = createLibraryWorld();
  try {
    const main = await w.channelOf(w.alice);
    main.video("001 A");
    const id = `${main.channel.id}/001 A`;
    await w.call(w.alice, "archiveVideo", { videoId: id });
    fs.renameSync(main.dir, `${main.dir}-unplugged`);
    await w.call(w.alice, "getLibrary");
    assert.deepEqual(await w.call(w.alice, "getArchived"), [], "nothing listed while unreachable");
    assert.notEqual(w.library.api.videos.find(main.channel.id, "001 A")?.archivedAt, null);
    fs.renameSync(`${main.dir}-unplugged`, main.dir);
    assert.equal((await w.call(w.alice, "getArchived")).length, 1);
  } finally {
    w.cleanup();
  }
});

test("archive is refused while a job of the video is active", async () => {
  /** @type {Map<string, unknown>} */
  const jobs = new Map();
  const w = createLibraryWorld({
    jobsFor: fakeJobs(jobs),
  });
  try {
    const main = await w.channelOf(w.alice);
    main.video("001 A");
    const id = `${main.channel.id}/001 A`;
    const { key } = await w.library.api.videoByWireId(w.alice.id, id);
    jobs.set(key, { state: "running", startsAt: null });
    await rejectsCode(w.call(w.alice, "archiveVideo", { videoId: id }), "conflict");
    jobs.set(key, { state: "completed", startsAt: null });
    await w.call(w.alice, "archiveVideo", { videoId: id });
    assert.equal((await w.call(w.alice, "getArchived")).length, 1);
  } finally {
    w.cleanup();
  }
});

test("the latest job and the actions follow the job manager's answer", async () => {
  /** @type {Map<string, unknown>} */
  const jobs = new Map();
  const w = createLibraryWorld({
    jobsFor: fakeJobs(jobs),
  });
  try {
    const main = await w.channelOf(w.alice);
    main.video("001 A");
    const id = `${main.channel.id}/001 A`;
    const { key } = await w.library.api.videoByWireId(w.alice.id, id);
    jobs.set(key, { id: "j1", state: "queued", startsAt: 123 });
    const asUser = (await w.call(w.alice, "getLibrary")).channels[0].videos[0];
    assert.equal(asUser.job.id, "j1");
    assert.deepEqual(asUser.actions, ["stop", "upload"]);
    // The same video seen by an admin gets startNow.
    const view = await w.library.api.videoView(w.alice.id, "admin", id);
    assert.deepEqual(view.actions, ["startNow", "stop", "upload"]);
  } finally {
    w.cleanup();
  }
});

test("an upload in progress blocks startEdit", async () => {
  const w = createLibraryWorld();
  try {
    const main = await w.channelOf(w.alice);
    main.video("001 A");
    const id = `${main.channel.id}/001 A`;
    createUploadsRepo(w.db, { clock: w.clock }).create({
      userId: w.alice.id,
      channelId: main.channel.id,
      folderName: "001 A",
      name: "a.mp4",
      size: 10,
    });
    const view = (await w.call(w.alice, "getLibrary")).channels[0].videos[0];
    assert.equal(view.id, id);
    assert.equal(view.uploading, true);
    assert.ok(!view.actions.includes("startEdit"));
    assert.ok(view.actions.includes("upload"));
  } finally {
    w.cleanup();
  }
});

test("an upload into the channel's folder blocks no video, and `upload` is not a video", async () => {
  const w = createLibraryWorld();
  try {
    const main = await w.channelOf(w.alice);
    main.video("001 A");
    main.video("upload", "logo.png");
    const uploads = createUploadsRepo(w.db, { clock: w.clock });
    uploads.create({
      userId: w.alice.id,
      channelId: main.channel.id,
      folderName: null,
      name: "logo.png",
      size: 10,
    });
    const library = await w.call(w.alice, "getLibrary");
    const videos = library.channels[0].videos;
    assert.deepEqual(
      videos.map((/** @type {{ id: string }} */ v) => v.id),
      [`${main.channel.id}/001 A`],
    );
    assert.equal(videos[0].uploading, false);
    assert.ok(videos[0].actions.includes("startEdit"));
  } finally {
    w.cleanup();
  }
});

test("types: detected from the A-roll, the channel setting and the override", async () => {
  const w = createLibraryWorld();
  try {
    const main = await w.channelOf(w.alice);
    const fixtures = path.join(import.meta.dirname, "../support/fixtures/media");
    fs.copyFileSync(
      path.join(fixtures, "portrait-faststart.mp4"),
      path.join(main.video("shorty"), "a.mp4"),
    );
    fs.copyFileSync(path.join(fixtures, "landscape.mp4"), path.join(main.video("longy"), "a.mp4"));
    main.video("empty");
    const byName = async () =>
      Object.fromEntries(
        (await w.call(w.alice, "getLibrary")).channels[0].videos.map((/** @type {any} */ v) => [
          v.folderName,
          v,
        ]),
      );
    let videos = await byName();
    assert.deepEqual(
      [videos.shorty.videoType, videos.shorty.typeSource, videos.shorty.detectedType],
      ["short", "detected", "short"],
    );
    assert.deepEqual([videos.longy.videoType, videos.longy.typeSource], ["long", "detected"]);
    assert.deepEqual(
      [videos.empty.videoType, videos.empty.typeSource, videos.empty.detectedType],
      ["long", "assumed", null],
    );

    const view = await w.call(w.alice, "setVideoTypeOverride", {
      videoId: `${main.channel.id}/longy`,
      videoType: "short",
    });
    assert.deepEqual(
      [view.videoType, view.typeSource, view.typeOverride],
      ["short", "override", "short"],
    );
    videos = await byName();
    assert.equal(videos.longy.videoType, "short");
    assert.equal(videos.longy.detectedType, "long");

    const cleared = await w.call(w.alice, "setVideoTypeOverride", {
      videoId: `${main.channel.id}/longy`,
      videoType: null,
    });
    assert.deepEqual([cleared.videoType, cleared.typeSource], ["long", "detected"]);
  } finally {
    w.cleanup();
  }
});

test("clearing an override that was never set makes no row", async () => {
  const w = createLibraryWorld();
  try {
    const main = await w.channelOf(w.alice);
    main.video("001 A");
    await w.call(w.alice, "setVideoTypeOverride", {
      videoId: `${main.channel.id}/001 A`,
      videoType: null,
    });
    assert.equal(w.library.api.videos.find(main.channel.id, "001 A"), undefined);
  } finally {
    w.cleanup();
  }
});

test("project, finals and the edited actions show in the view", async () => {
  const w = createLibraryWorld();
  try {
    const main = await w.channelOf(w.alice);
    const video = main.video("001 A");
    write(path.join(video, "output", "001 A.hf", "index.html"));
    write(path.join(video, "output", "final.mp4"));
    write(path.join(video, "CLAUDE_VE", "tmp.bin"));
    const view = (await w.call(w.alice, "getLibrary")).channels[0].videos[0];
    assert.equal(view.edited, true);
    assert.equal(view.finalRendered, true);
    assert.deepEqual(view.actions, [
      "reEdit",
      "renderFinal",
      "review",
      "upload",
      "diskCleanup",
      "archive",
    ]);
    assert.equal(view.output.project.path, "output/001 A.hf/index.html");
    assert.equal(JSON.stringify(view).includes(w.root), false, "no server path leaks");
  } finally {
    w.cleanup();
  }
});

test("videoByWireId and describeKey", async () => {
  const w = createLibraryWorld();
  try {
    const main = await w.channelOf(w.alice);
    main.video("001 A");
    const id = `${main.channel.id}/001 A`;
    const found = await w.library.api.videoByWireId(w.alice.id, id);
    assert.equal(found.folderName, "001 A");
    assert.equal(found.channel.id, main.channel.id);
    assert.match(found.key, /^[0-9a-f]{32}$/);
    assert.equal((await w.library.api.videoByWireId(w.alice.id, id)).key, found.key);
    const described = w.library.api.describeKey(found.key);
    assert.equal(described?.videoId, id);
    assert.equal(described?.userId, w.alice.id);
    assert.equal(w.library.api.describeKey("nope"), undefined);
    await rejectsCode(w.library.api.videoByWireId(w.bob.id, id), "notFound");
    await rejectsCode(
      w.library.api.videoByWireId(w.alice.id, `${main.channel.id}/missing`),
      "notFound",
    );
  } finally {
    w.cleanup();
  }
});

test("rescanAll scans every user with channels", async () => {
  const w = createLibraryWorld();
  try {
    (await w.channelOf(w.alice)).video("a");
    (await w.channelOf(w.bob)).video("b");
    await w.library.api.rescanAll();
    assert.deepEqual(
      libraryChanged(w)
        .map((e) => e.userId)
        .sort(),
      [w.alice.id, w.bob.id].sort(),
    );
  } finally {
    w.cleanup();
  }
});

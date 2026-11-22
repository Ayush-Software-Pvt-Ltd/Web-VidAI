import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fingerprintVideoFolder, measureVideoFolder } from "../../src/disk/measure.js";
import { canRestrict, createDiskWorld, layoutVideo, rejectsCode, write } from "./support.js";

/** Real measuring that counts its calls. */
function countingOps() {
  const calls = { measure: 0, fingerprint: 0 };
  return {
    calls,
    ops: {
      measure: (
        /** @type {string} */ dir,
        /** @type {string} */ name,
        /** @type {AbortSignal} */ signal,
      ) => {
        calls.measure += 1;
        return measureVideoFolder(dir, name, signal);
      },
      fingerprint: (/** @type {string} */ dir, /** @type {AbortSignal} */ signal) => {
        calls.fingerprint += 1;
        return fingerprintVideoFolder(dir, signal);
      },
    },
  };
}

test("getDiskUse lists every video of the user at once, archived ones marked, measuring queued", async () => {
  const w = createDiskWorld();
  try {
    const main = await w.channelOf(w.alice, "Main");
    const second = await w.channelOf(w.alice, "Second");
    const bobs = await w.channelOf(w.bob, "Bobs");
    layoutVideo(main.video("001 A"));
    main.video("002 B");
    second.video("x");
    bobs.video("secret");
    const row = await w.library.api.videoByWireId(w.alice.id, `${main.channel.id}/001 A`);
    w.library.api.videos.setArchived(row.key, w.clock.now());

    const use = await w.call(w.alice, "getDiskUse");
    assert.deepEqual(
      use.videos.map((/** @type {any} */ v) => [v.channelName, v.folderName, v.archived]),
      [
        ["Main", "002 B", false],
        ["Main", "001 A", true],
        ["Second", "x", false],
      ],
    );
    assert.ok(use.videos.every((/** @type {any} */ v) => v.sizes === null && v.measuring));
    assert.equal(use.measuring, true);
    assert.equal(use.totals.total, 0);
    assert.equal(use.videos[0].videoId, `${main.channel.id}/002 B`);
    assert.equal(use.videos[0].channelId, main.channel.id);
    assert.equal(use.videos[0].measuredAt, null);
  } finally {
    w.cleanup();
  }
});

test("background measuring runs one folder at a time and the answer fills in", async () => {
  const w = createDiskWorld();
  try {
    const main = await w.channelOf(w.alice);
    const expected = layoutVideo(main.video("001 A"));
    main.video("002 B", "clip.mp4", "12345");
    await w.call(w.alice, "getDiskUse");
    assert.equal(w.scheduler.size, 1, "one task is scheduled, not one per folder");
    assert.equal(await w.scheduler.step(), true);
    // After one task exactly one folder is done.
    assert.equal(w.scheduler.size, 1);
    const partial = await w.call(w.alice, "getDiskUse");
    assert.equal(partial.videos.filter((/** @type {any} */ v) => v.sizes).length, 1);
    assert.equal(partial.measuring, true);

    await w.scheduler.drain();
    const done = await w.call(w.alice, "getDiskUse");
    assert.equal(done.measuring, false);
    const a = done.videos.find((/** @type {any} */ v) => v.folderName === "001 A");
    const b = done.videos.find((/** @type {any} */ v) => v.folderName === "002 B");
    assert.deepEqual(a.sizes, expected);
    assert.equal(a.measuredAt, w.clock.now());
    assert.deepEqual(b.sizes, { working: 0, project: 0, finals: 0, sources: 5, total: 5 });
    assert.deepEqual(done.totals, {
      working: 340,
      project: 56,
      finals: 150,
      sources: 1214,
      total: 1760,
    });
  } finally {
    w.cleanup();
  }
});

test("the page is told with disk-use-changed, to its owner only, with the last one complete", async () => {
  const w = createDiskWorld();
  try {
    const main = await w.channelOf(w.alice);
    for (const name of ["a", "b", "c"]) main.video(name, "f.bin", name);
    await w.call(w.alice, "getDiskUse");
    await w.scheduler.drain();
    const events = w.diskEvents();
    // The clock does not move, so the throttle lets the first and the final one through.
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.userId, w.alice.id);
      assert.equal(event.admins, false);
    }
    const last = /** @type {any} */ (events[1]?.payload);
    assert.equal(last.measuring, false);
    assert.equal(last.videos.length, 3);
    assert.ok(last.videos.every((/** @type {any} */ v) => v.sizes && !v.measuring));
    assert.equal(/** @type {any} */ (events[0]).payload.measuring, true);
  } finally {
    w.cleanup();
  }
});

test("events are not throttled once the interval has passed", async () => {
  const w = createDiskWorld({ extra: { eventIntervalMs: 500 } });
  try {
    const main = await w.channelOf(w.alice);
    for (const name of ["a", "b", "c"]) main.video(name, "f.bin", name);
    await w.call(w.alice, "getDiskUse");
    while (w.scheduler.size > 0) {
      w.clock.advance(1000);
      await w.scheduler.step();
    }
    assert.equal(w.diskEvents().length, 3);
  } finally {
    w.cleanup();
  }
});

test("a fresh cache answers without queueing anything", async () => {
  const { ops, calls } = countingOps();
  const w = createDiskWorld({ extra: { ops, verifyAfterMs: 30_000 } });
  try {
    const main = await w.channelOf(w.alice);
    main.video("a", "f.bin");
    await w.call(w.alice, "getDiskUse");
    await w.scheduler.drain();
    assert.deepEqual(calls, { measure: 1, fingerprint: 1 });
    w.clock.advance(29_999);
    const use = await w.call(w.alice, "getDiskUse");
    assert.equal(w.scheduler.size, 0);
    assert.equal(use.measuring, false);
    assert.equal(use.videos[0].sizes.total, 1);
    assert.deepEqual(calls, { measure: 1, fingerprint: 1 });
  } finally {
    w.cleanup();
  }
});

test("after the verify time an unchanged folder is only fingerprinted, not measured again", async () => {
  const { ops, calls } = countingOps();
  const w = createDiskWorld({ extra: { ops } });
  try {
    const main = await w.channelOf(w.alice);
    main.video("a", "f.bin");
    await w.call(w.alice, "getDiskUse");
    await w.scheduler.drain();
    w.clock.advance(31_000);
    const use = await w.call(w.alice, "getDiskUse");
    // The known numbers are shown while the check runs.
    assert.equal(use.videos[0].measuring, true);
    assert.equal(use.videos[0].sizes.total, 1);
    await w.scheduler.drain();
    assert.deepEqual(calls, { measure: 1, fingerprint: 2 });
    const again = await w.call(w.alice, "getDiskUse");
    assert.equal(again.measuring, false);
    assert.equal(w.scheduler.size, 0);
  } finally {
    w.cleanup();
  }
});

test("a changed folder is measured again, and the old numbers stay until the new ones arrive", async () => {
  const { ops, calls } = countingOps();
  const w = createDiskWorld({ extra: { ops } });
  try {
    const main = await w.channelOf(w.alice);
    const dir = main.video("a", "f.bin", "123");
    await w.call(w.alice, "getDiskUse");
    await w.scheduler.drain();
    write(path.join(dir, "CLAUDE_VE/new.bin"), Buffer.alloc(50));
    w.clock.advance(31_000);
    const during = await w.call(w.alice, "getDiskUse");
    assert.equal(during.videos[0].sizes.total, 3);
    assert.equal(during.videos[0].measuring, true);
    await w.scheduler.drain();
    assert.equal(calls.measure, 2);
    const after = await w.call(w.alice, "getDiskUse");
    assert.equal(after.videos[0].sizes.working, 50);
    assert.equal(after.videos[0].sizes.total, 53);
  } finally {
    w.cleanup();
  }
});

test("invalidate makes the next look verify at once", async () => {
  const { ops, calls } = countingOps();
  const w = createDiskWorld({ extra: { ops } });
  try {
    const main = await w.channelOf(w.alice);
    const dir = main.video("a", "f.bin", "1");
    await w.call(w.alice, "getDiskUse");
    await w.scheduler.drain();
    write(path.join(dir, "CLAUDE_VE/new.bin"), Buffer.alloc(8));
    w.disk.api.invalidate(w.alice.id);
    await w.call(w.alice, "getDiskUse");
    await w.scheduler.drain();
    assert.equal(calls.measure, 2);
    assert.equal((await w.call(w.alice, "getDiskUse")).videos[0].sizes.working, 8);
  } finally {
    w.cleanup();
  }
});

test("a change too deep for the fingerprint is caught by the maximum age", async () => {
  const { ops, calls } = countingOps();
  const w = createDiskWorld({ extra: { ops, maxAgeMs: 120_000 } });
  try {
    const main = await w.channelOf(w.alice);
    const dir = main.video("a");
    write(path.join(dir, "CLAUDE_VE/p/q/deep.bin"), "x");
    await w.call(w.alice, "getDiskUse");
    await w.scheduler.drain();
    fs.appendFileSync(path.join(dir, "CLAUDE_VE/p/q/deep.bin"), "yyyy");
    w.clock.advance(40_000);
    await w.call(w.alice, "getDiskUse");
    await w.scheduler.drain();
    assert.equal(calls.measure, 1, "fingerprint equal and measurement still young");
    w.clock.advance(100_000);
    await w.call(w.alice, "getDiskUse");
    await w.scheduler.drain();
    assert.equal(calls.measure, 2);
    assert.equal((await w.call(w.alice, "getDiskUse")).videos[0].sizes.total, 5);
  } finally {
    w.cleanup();
  }
});

test("stop cancels the measuring in progress and what is queued", async () => {
  /** @type {AbortSignal | null} */
  let seen = null;
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => (release = () => resolve(undefined)));
  let started = () => {};
  const startedPromise = new Promise((resolve) => (started = () => resolve(undefined)));
  const w = createDiskWorld({
    extra: {
      ops: {
        fingerprint: async () => "fp",
        measure: async (_dir, _name, signal) => {
          seen = signal;
          started();
          await gate;
          return signal.aborted
            ? null
            : { working: 1, project: 0, finals: 0, sources: 0, total: 1 };
        },
      },
    },
  });
  try {
    const main = await w.channelOf(w.alice);
    main.video("a");
    main.video("b");
    await w.call(w.alice, "getDiskUse");
    const running = w.scheduler.step();
    await startedPromise;
    w.disk.stop();
    assert.equal(/** @type {AbortSignal | null} */ (seen)?.aborted, true);
    release();
    await running;
    assert.equal(w.scheduler.size, 0, "nothing is scheduled any more");
    assert.equal(w.diskEvents().length, 0);
    // After stop the page can still ask; it gets an empty answer and nothing is queued.
    const use = await w.call(w.alice, "getDiskUse");
    assert.deepEqual(use.videos, []);
    assert.equal(w.scheduler.size, 0);
  } finally {
    w.cleanup();
  }
});

test("a measurement that fails is logged and does not stop the others", async () => {
  let calls = 0;
  const w = createDiskWorld({
    extra: {
      ops: {
        fingerprint: async () => "fp",
        measure: async () => {
          calls += 1;
          if (calls === 1) throw new Error("disk went away");
          return { working: 0, project: 0, finals: 0, sources: 4, total: 4 };
        },
      },
    },
  });
  try {
    const main = await w.channelOf(w.alice);
    main.video("a");
    main.video("b");
    await w.call(w.alice, "getDiskUse");
    await w.scheduler.drain();
    const use = await w.call(w.alice, "getDiskUse");
    assert.equal(use.videos.filter((/** @type {any} */ v) => v.sizes).length, 1);
    assert.ok(w.warnings.some((line) => /could not measure/.test(line)));
  } finally {
    w.cleanup();
  }
});

test("an unreachable channel is left out", async () => {
  const w = createDiskWorld();
  try {
    const main = await w.channelOf(w.alice, "Main");
    const other = await w.channelOf(w.alice, "Other");
    main.video("a");
    other.video("b");
    fs.renameSync(other.dir, `${other.dir}-moved`);
    const use = await w.call(w.alice, "getDiskUse");
    assert.deepEqual(
      use.videos.map((/** @type {any} */ v) => v.folderName),
      ["a"],
    );
  } finally {
    w.cleanup();
  }
});

test("forgetting a user drops their queued work and listing", async () => {
  const w = createDiskWorld();
  try {
    const main = await w.channelOf(w.alice);
    main.video("a");
    await w.call(w.alice, "getDiskUse");
    w.disk.hooks.onUserRemoved(w.alice.id);
    await w.scheduler.drain();
    assert.equal(w.diskEvents().length, 0);
  } finally {
    w.cleanup();
  }
});

// ---- cleanWorkingFiles ------------------------------------------------------------------------

test("cleanWorkingFiles deletes the working files, records the edit log line and forgets the size", async () => {
  const w = createDiskWorld();
  try {
    const main = await w.channelOf(w.alice, "Daily");
    const dir = main.video("ep 1");
    layoutVideo(dir);
    await w.call(w.alice, "getDiskUse");
    await w.scheduler.drain();
    w.libraryEvents.length = 0;

    const result = await w.call(w.alice, "cleanWorkingFiles", {
      videoId: `${main.channel.id}/ep 1`,
    });
    assert.deepEqual(result, { freedBytes: 340, leftover: 0 });
    assert.deepEqual(fs.readdirSync(path.join(dir, "CLAUDE_VE")), []);
    assert.ok(fs.existsSync(path.join(dir, "output/ep 1.hf/index.html")));

    const log = w.editLog.read({ id: w.alice.id, role: "user" });
    assert.equal(log.entries.length, 1);
    assert.equal(log.entries[0]?.event, "diskCleanup");
    assert.equal(log.entries[0]?.message, "Disk Cleanup freed 340 B");
    assert.equal(log.entries[0]?.videoLabel, "Daily / ep 1");
    assert.equal(log.entries[0]?.userEmail, "alice@example.com");

    // The cached size is gone: the page is told right away that the video is being measured.
    const events = w.diskEvents();
    assert.equal(events.length, 1);
    const video = /** @type {any} */ (events[0]).payload.videos[0];
    assert.equal(video.sizes, null);
    assert.equal(video.measuring, true);
    assert.deepEqual(w.rescans, [w.alice.id]);

    await w.scheduler.drain();
    const after = await w.call(w.alice, "getDiskUse");
    assert.equal(after.videos[0].sizes.working, 0);
    assert.equal(after.videos[0].sizes.total, 1755 - 340);
  } finally {
    w.cleanup();
  }
});

test("the edit log line shows the size with one decimal from MB up", async () => {
  const w = createDiskWorld();
  try {
    const main = await w.channelOf(w.alice);
    const dir = main.video("ep");
    fs.mkdirSync(path.join(dir, "CLAUDE_VE"));
    // A sparse file: 3.5 MB of size without using the disk.
    const big = path.join(dir, "CLAUDE_VE/big.bin");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, 3.5 * 1024 * 1024);
    await w.call(w.alice, "cleanWorkingFiles", { videoId: `${main.channel.id}/ep` });
    assert.equal(
      w.editLog.read({ id: w.alice.id, role: "user" }).entries[0]?.message,
      "Disk Cleanup freed 3.5 MB",
    );
  } finally {
    w.cleanup();
  }
});

test("a video that is not the user's own is not found, for a user", async () => {
  const w = createDiskWorld();
  try {
    const bobs = await w.channelOf(w.bob);
    const dir = bobs.video("ep");
    layoutVideo(dir);
    await rejectsCode(
      w.call(w.alice, "cleanWorkingFiles", { videoId: `${bobs.channel.id}/ep` }),
      "notFound",
    );
    assert.ok(fs.existsSync(path.join(dir, "CLAUDE_VE/scratch.bin")));
    assert.equal(w.editLog.count(), 0);
  } finally {
    w.cleanup();
  }
});

test("an admin may clean anybody's video; the line goes to the owner and says who did it", async () => {
  const w = createDiskWorld();
  try {
    const bobs = await w.channelOf(w.bob, "Bobs");
    const dir = bobs.video("ep");
    layoutVideo(dir);
    const result = await w.call(w.admin, "cleanWorkingFiles", { videoId: `${bobs.channel.id}/ep` });
    assert.equal(result.freedBytes, 340);
    assert.deepEqual(fs.readdirSync(path.join(dir, "CLAUDE_VE")), []);
    const log = w.editLog.read({ id: w.bob.id, role: "user" });
    assert.equal(log.entries[0]?.message, "Disk Cleanup freed 340 B (by an admin)");
    assert.deepEqual(w.rescans, [w.bob.id]);
    // An admin asking for a video id that nobody owns gets the same notFound.
    await rejectsCode(
      w.call(w.admin, "cleanWorkingFiles", { videoId: "nochannel/ep" }),
      "notFound",
    );
  } finally {
    w.cleanup();
  }
});

test("refused while the video has an active job; nothing is deleted or logged", async () => {
  const w = createDiskWorld();
  try {
    const main = await w.channelOf(w.alice);
    const dir = main.video("ep");
    layoutVideo(dir);
    const row = await w.library.api.videoByWireId(w.alice.id, `${main.channel.id}/ep`);
    w.active.add(row.key);
    const error = await rejectsCode(
      w.call(w.alice, "cleanWorkingFiles", { videoId: `${main.channel.id}/ep` }),
      "conflict",
    );
    assert.match(error.message, /job/);
    assert.ok(fs.existsSync(path.join(dir, "CLAUDE_VE/scratch.bin")));
    assert.equal(w.editLog.count(), 0);
    w.active.delete(row.key);
    await w.call(w.alice, "cleanWorkingFiles", { videoId: `${main.channel.id}/ep` });
    assert.equal(w.editLog.count(), 1);
  } finally {
    w.cleanup();
  }
});

test("a job that starts while the folder is being checked still stops the cleanup", async () => {
  /** @type {Set<string>} */
  const active = new Set();
  let asks = 0;
  const w = createDiskWorld({
    activeJob: (key) => {
      asks += 1;
      // The first look says no, the second (right before deleting) says yes.
      if (asks === 2) active.add(key);
      return active.has(key);
    },
  });
  try {
    const main = await w.channelOf(w.alice);
    const dir = main.video("ep");
    layoutVideo(dir);
    await rejectsCode(
      w.call(w.alice, "cleanWorkingFiles", { videoId: `${main.channel.id}/ep` }),
      "conflict",
    );
    assert.ok(fs.existsSync(path.join(dir, "CLAUDE_VE/scratch.bin")));
  } finally {
    w.cleanup();
  }
});

test("refused when there are no working files, when CLAUDE_VE is a link, or a file", async () => {
  const w = createDiskWorld();
  try {
    const main = await w.channelOf(w.alice);
    const id = (/** @type {string} */ name) => ({ videoId: `${main.channel.id}/${name}` });
    main.video("none");
    const none = await rejectsCode(w.call(w.alice, "cleanWorkingFiles", id("none")), "conflict");
    assert.equal(none.message, "There are no working files to delete.");

    const sources = main.video("linked", "a-roll.mp4", "video");
    fs.symlinkSync(path.join(sources, "."), path.join(sources, "CLAUDE_VE"));
    await rejectsCode(w.call(w.alice, "cleanWorkingFiles", id("linked")), "conflict");
    assert.equal(fs.readFileSync(path.join(sources, "a-roll.mp4"), "utf8"), "video");

    const file = main.video("file", "CLAUDE_VE", "x");
    await rejectsCode(w.call(w.alice, "cleanWorkingFiles", id("file")), "conflict");
    assert.ok(fs.existsSync(path.join(file, "CLAUDE_VE")));
    assert.equal(w.editLog.count(), 0);
  } finally {
    w.cleanup();
  }
});

test("hostile video ids cannot reach outside the video folder", async () => {
  const w = createDiskWorld();
  try {
    const main = await w.channelOf(w.alice);
    const victim = main.video("ep");
    layoutVideo(victim);
    // A sibling folder of the channel directory with its own working files.
    const outside = path.join(path.dirname(main.dir), "outside-video");
    write(path.join(outside, "CLAUDE_VE/keep.bin"), "keep");
    const hostile = [
      `${main.channel.id}/..`,
      `${main.channel.id}/../outside-video`,
      `${main.channel.id}/ep/..`,
      `${main.channel.id}/ep/../ep`,
      `${main.channel.id}/ep/CLAUDE_VE`,
      `${main.channel.id}/../../`,
      `${main.channel.id}/`,
      main.channel.id,
      "/etc",
      "../x/y",
      `${main.channel.id}/CLAUDE_VE`,
      `${main.channel.id}/.hidden`,
    ];
    for (const videoId of hostile) {
      await assert.rejects(
        w.call(w.alice, "cleanWorkingFiles", { videoId }),
        (error) => {
          const code = /** @type {{ code?: string }} */ (error).code;
          return code === "notFound" || code === "invalidInput";
        },
        videoId,
      );
    }
    assert.equal(fs.readFileSync(path.join(outside, "CLAUDE_VE/keep.bin"), "utf8"), "keep");
    assert.ok(fs.existsSync(path.join(victim, "CLAUDE_VE/scratch.bin")));
    assert.equal(w.editLog.count(), 0);
  } finally {
    w.cleanup();
  }
});

test("a video folder that is itself a link to another place is not a video", async () => {
  const w = createDiskWorld();
  try {
    const main = await w.channelOf(w.alice);
    const outside = path.join(path.dirname(main.dir), "elsewhere");
    write(path.join(outside, "CLAUDE_VE/keep.bin"), "keep");
    fs.symlinkSync(outside, path.join(main.dir, "sneaky"));
    await rejectsCode(
      w.call(w.alice, "cleanWorkingFiles", { videoId: `${main.channel.id}/sneaky` }),
      "notFound",
    );
    assert.equal(fs.readFileSync(path.join(outside, "CLAUDE_VE/keep.bin"), "utf8"), "keep");
    const use = await w.call(w.alice, "getDiskUse");
    assert.deepEqual(use.videos, []);
  } finally {
    w.cleanup();
  }
});

test("two cleanups of one video at once: the second is refused", async () => {
  const w = createDiskWorld();
  try {
    const main = await w.channelOf(w.alice);
    layoutVideo(main.video("ep"));
    const input = { videoId: `${main.channel.id}/ep` };
    const first = w.call(w.alice, "cleanWorkingFiles", input);
    const second = w.call(w.alice, "cleanWorkingFiles", input);
    const results = await Promise.allSettled([first, second]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const refused = results.find((r) => r.status === "rejected");
    assert.equal(/** @type {any} */ (refused)?.reason?.code, "conflict");
  } finally {
    w.cleanup();
  }
});

test("a cleanup while the folder is being measured discards that measurement and measures again", async () => {
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => (release = () => resolve(undefined)));
  let started = () => {};
  const startedPromise = new Promise((resolve) => (started = () => resolve(undefined)));
  let measures = 0;
  const w = createDiskWorld({
    extra: {
      ops: {
        fingerprint: async () => `fp${measures}`,
        measure: async (dir, name, signal) => {
          measures += 1;
          const before = await measureVideoFolder(dir, name, signal);
          if (measures === 1) {
            started();
            await gate;
          }
          return before;
        },
      },
    },
  });
  try {
    const main = await w.channelOf(w.alice);
    layoutVideo(main.video("ep"));
    await w.call(w.alice, "getDiskUse");
    const running = w.scheduler.step();
    await startedPromise;
    await w.call(w.alice, "cleanWorkingFiles", { videoId: `${main.channel.id}/ep` });
    release();
    await running;
    // The measurement from before the cleanup was thrown away and queued again.
    assert.equal((await w.call(w.alice, "getDiskUse")).videos[0].sizes, null);
    await w.scheduler.drain();
    const use = await w.call(w.alice, "getDiskUse");
    assert.equal(use.videos[0].sizes.working, 0);
    assert.equal(measures, 2);
  } finally {
    w.cleanup();
  }
});

test(
  "items that could not be removed are reported and logged",
  { skip: !canRestrict },
  async () => {
    const w = createDiskWorld();
    const locked = [];
    try {
      const main = await w.channelOf(w.alice);
      const dir = main.video("ep");
      write(path.join(dir, "CLAUDE_VE/free.bin"), Buffer.alloc(10));
      write(path.join(dir, "CLAUDE_VE/stuck/s.bin"), Buffer.alloc(10));
      locked.push(path.join(dir, "CLAUDE_VE/stuck"));
      fs.chmodSync(locked[0] ?? "", 0o555);
      const result = await w.call(w.alice, "cleanWorkingFiles", {
        videoId: `${main.channel.id}/ep`,
      });
      assert.deepEqual(result, { freedBytes: 10, leftover: 1 });
      assert.equal(
        w.editLog.read({ id: w.alice.id, role: "user" }).entries[0]?.message,
        "Disk Cleanup freed 10 B (1 item could not be removed)",
      );
    } finally {
      for (const folder of locked) fs.chmodSync(folder, 0o755);
      w.cleanup();
    }
  },
);

test("isCleaning tells the job manager while the deleting runs", async () => {
  /** @type {boolean[]} */
  const seen = [];
  /** @type {ReturnType<typeof createDiskWorld> | null} */
  let world = null;
  const w = createDiskWorld({
    activeJob: (key) => {
      seen.push(world?.disk.api.isCleaning(key) ?? false);
      return false;
    },
  });
  world = w;
  try {
    const main = await w.channelOf(w.alice);
    layoutVideo(main.video("ep"));
    const row = await w.library.api.videoByWireId(w.alice.id, `${main.channel.id}/ep`);
    assert.equal(w.disk.api.isCleaning(row.key), false);
    await w.call(w.alice, "cleanWorkingFiles", { videoId: `${main.channel.id}/ep` });
    // The first look is before the deleting starts, the second right before it.
    assert.deepEqual(seen, [false, true]);
    assert.equal(w.disk.api.isCleaning(row.key), false);
  } finally {
    w.cleanup();
  }
});

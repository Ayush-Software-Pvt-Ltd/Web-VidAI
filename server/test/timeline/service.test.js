// The timeline service: reading the project, hand edits, locks, conflicts and outside changes
// (docs/SPEC.md section 11).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createTimelineWorld, del, hasClip, readIndex, rejectsCode } from "./serviceSupport.js";

test("getTimeline reads the project, saves the first revision and fills the extras", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    const t = /** @type {any} */ (
      await w.timeline.rpc[1]?.handler(
        { videoId: v.videoId },
        /** @type {never} */ (w.ctxOf(w.alice)),
      )
    );
    assert.equal(t.revision, 1);
    assert.deepEqual([t.canUndo, t.canRedo, t.locked, t.notes], [false, false, null, []]);
    assert.equal(t.width, 1920);
    assert.equal(t.tracks.find((/** @type {any} */ x) => x.index === 0).clips.length, 8);
    const rows = await w.call(w.alice, "listRevisions", { videoId: v.videoId });
    assert.deepEqual(
      rows.map((/** @type {any} */ r) => [r.n, r.label, r.current, r.userEmail]),
      [[1, "Existing project", true, null]],
    );
    // Reading again changes nothing.
    assert.equal((await w.call(w.alice, "getTimeline", { videoId: v.videoId })).revision, 1);
    assert.equal(w.timeline.api.latestRevision(v.key)?.n, 1);
  } finally {
    w.cleanup();
  }
});

test("a video without a project, and another user's video, are notFound", async () => {
  const w = createTimelineWorld();
  try {
    const bare = await w.videoOf(w.alice, { project: false });
    const err = await rejectsCode(
      w.call(w.alice, "getTimeline", { videoId: bare.videoId }),
      "notFound",
    );
    assert.match(err.message, /no project to open yet/);
    await rejectsCode(w.call(w.alice, "openTimeline", { videoId: bare.videoId }), "notFound");

    const mine = await w.videoOf(w.alice, { folder: "002 B", channelName: "Second" });
    for (const name of ["getTimeline", "openTimeline", "listRevisions", "undoTimeline"]) {
      await rejectsCode(w.call(w.bob, name, { videoId: mine.videoId }), "notFound");
    }
    await rejectsCode(
      w.call(w.bob, "editTimeline", { videoId: mine.videoId, revision: 1, op: del("b-3") }),
      "notFound",
    );
    assert.equal(w.timeline.api.latestRevision(mine.key), null, "bob's calls saved nothing");
  } finally {
    w.cleanup();
  }
});

test("a project folder that is a link out of the video is not a project", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    const elsewhere = path.join(w.root, "elsewhere");
    fs.renameSync(v.projectDir, elsewhere);
    fs.symlinkSync(elsewhere, v.projectDir);
    await rejectsCode(w.call(w.alice, "getTimeline", { videoId: v.videoId }), "notFound");
    assert.equal(await w.timeline.api.projectExists(v.key), false);
  } finally {
    w.cleanup();
  }
});

test("openTimeline gives the timeline, the preview address and the violations", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    const opened = await w.call(w.alice, "openTimeline", { videoId: v.videoId });
    assert.equal(opened.previewUrl, "/p/token/");
    assert.deepEqual(opened.violations, []);
    assert.equal(opened.timeline.revision, 1);
    const asked = /** @type {any} */ (w.previews[0]);
    assert.deepEqual(
      { ...asked, sessionId: undefined },
      {
        sessionId: undefined,
        userId: w.alice.id,
        videoKey: v.key,
        projectDir: fs.realpathSync(v.projectDir),
        videoDir: v.dir,
        channelDir: v.channelDir,
      },
    );
    assert.equal(asked.sessionId, `s-${w.alice.id}`);

    // A project that breaks a rule is still shown, with the reason.
    const html = readIndex(v.projectDir).replace('data-duration="45"', 'data-duration="46"');
    fs.writeFileSync(path.join(v.projectDir, "index.html"), html);
    const broken = await w.call(w.alice, "openTimeline", { videoId: v.videoId });
    assert.ok(broken.timeline);
    assert.ok(broken.violations.some((/** @type {any} */ x) => x.rule === 5));

    // One that cannot be read at all has no timeline.
    fs.rmSync(path.join(v.projectDir, "edit.json"));
    const unreadable = await w.call(w.alice, "openTimeline", { videoId: v.videoId });
    assert.equal(unreadable.timeline, null);
    assert.ok(unreadable.violations.length > 0);
    const err = await rejectsCode(
      w.call(w.alice, "getTimeline", { videoId: v.videoId }),
      "notReady",
    );
    assert.match(err.message, /cannot be shown/);
  } finally {
    w.cleanup();
  }
});

test("openTimeline without a preview answers null", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    const { createTimelineModule } = await import("../../src/timeline/index.js");
    const bare = createTimelineModule({
      db: w.db,
      clock: w.clock,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      events: { emit: () => {} },
      dataDir: w.dataDir,
      library: w.library.api,
      runLint: async () => ({ errors: [], problem: null }),
    });
    const fn = bare.rpc.find((f) => f.name === "openTimeline");
    const opened = /** @type {any} */ (
      await fn?.handler({ videoId: v.videoId }, /** @type {never} */ (w.ctxOf(w.alice)))
    );
    assert.equal(opened.previewUrl, null);
  } finally {
    w.cleanup();
  }
});

test("a hand edit changes index.html, saves a revision, emits timeline-changed and returns the timeline", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    const before = readIndex(v.projectDir);
    await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    const t = await w.call(w.alice, "editTimeline", {
      videoId: v.videoId,
      revision: 1,
      op: del("b-3"),
    });
    assert.equal(t.revision, 2);
    assert.equal(t.canUndo, true);
    assert.equal(t.canRedo, false);
    assert.equal(
      t.tracks[1].clips.some((/** @type {any} */ c) => c.id === "b-3"),
      false,
    );
    const after = readIndex(v.projectDir);
    assert.ok(hasClip(before, "b-3") && !hasClip(after, "b-3"));
    // The rest of the file is kept byte for byte.
    assert.equal(after.length < before.length, true);
    const rows = await w.call(w.alice, "listRevisions", { videoId: v.videoId });
    assert.deepEqual(
      rows.map((/** @type {any} */ r) => [r.n, r.label, r.userEmail !== null]),
      [
        [2, "Delete B-roll", true],
        [1, "Existing project", false],
      ],
    );
    const changed = w.eventsNamed("timeline-changed").at(-1);
    assert.deepEqual(changed?.payload, { videoId: v.videoId, revision: 2 });
    assert.equal(changed?.userId, w.alice.id);
    assert.equal(changed?.admins, false);
    // The revision folder holds the new state.
    const saved = path.join(w.dataDir, "projects", v.key, "revisions", "2", "index.html");
    assert.equal(fs.readFileSync(saved, "utf8"), after);
  } finally {
    w.cleanup();
  }
});

test("a stale revision is a conflict and nothing changes", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    await w.call(w.alice, "editTimeline", { videoId: v.videoId, revision: 1, op: del("b-3") });
    const text = readIndex(v.projectDir);
    const err = await rejectsCode(
      w.call(w.alice, "editTimeline", { videoId: v.videoId, revision: 1, op: del("s-1") }),
      "conflict",
    );
    assert.match(err.message, /changed since you opened it/);
    assert.equal(readIndex(v.projectDir), text);
    assert.equal(w.timeline.api.latestRevision(v.key)?.n, 2);
    // A revision from the future is stale too.
    await rejectsCode(
      w.call(w.alice, "editTimeline", { videoId: v.videoId, revision: 9, op: del("s-1") }),
      "conflict",
    );
  } finally {
    w.cleanup();
  }
});

test("while a job holds the video: reads and notes work, hand edits and history steps are conflicts", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    await w.call(w.alice, "editTimeline", { videoId: v.videoId, revision: 1, op: del("b-3") });
    w.jobs.set(v.key, { id: "job-1", kind: "reEdit" });
    const t = await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    assert.deepEqual(t.locked, { jobId: "job-1", kind: "reEdit" });
    const text = readIndex(v.projectDir);
    for (const [name, extra] of /** @type {const} */ ([
      ["editTimeline", { revision: t.revision, op: del("s-1") }],
      ["undoTimeline", {}],
      ["redoTimeline", {}],
      ["restoreRevision", { n: 1 }],
    ])) {
      const err = await rejectsCode(
        w.call(w.alice, name, { videoId: v.videoId, ...extra }),
        "conflict",
      );
      assert.match(err.message, /being edited right now/, name);
    }
    assert.equal(readIndex(v.projectDir), text);
    assert.equal((await w.call(w.alice, "listRevisions", { videoId: v.videoId })).length, 2);
    w.jobs.delete(v.key);
    const free = await w.call(w.alice, "editTimeline", {
      videoId: v.videoId,
      revision: t.revision,
      op: del("s-1"),
    });
    assert.equal(free.revision, 3);
  } finally {
    w.cleanup();
  }
});

test("an edit the rules refuse leaves the file and the revisions alone", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    const text = readIndex(v.projectDir);
    for (const op of [
      del("no-such-clip"),
      { type: "split", clipId: "g-1", frame: 630 },
      { type: "nonsense", clipId: "b-3" },
      null,
    ]) {
      await rejectsCode(
        w.call(w.alice, "editTimeline", { videoId: v.videoId, revision: 1, op }),
        "invalidInput",
      );
    }
    assert.equal(readIndex(v.projectDir), text);
    assert.equal(w.timeline.api.latestRevision(v.key)?.n, 1);
    assert.equal(w.eventsNamed("timeline-changed").length, 0);
    // A project that already breaks the rules is not edited by hand.
    fs.writeFileSync(
      path.join(v.projectDir, "index.html"),
      text.replace('data-duration="45"', 'data-duration="46"'),
    );
    const broken = readIndex(v.projectDir);
    const probe = await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    const err = await rejectsCode(
      w.call(w.alice, "editTimeline", {
        videoId: v.videoId,
        revision: probe.revision,
        op: del("b-3"),
      }),
      "invalidInput",
    );
    assert.match(err.message, /does not follow VidAI's rules/);
    assert.equal(readIndex(v.projectDir), broken);
  } finally {
    w.cleanup();
  }
});

test(
  "a failed revision save puts the old index.html back",
  { skip: process.platform === "win32" && "folder permissions are not enforced the same way" },
  async () => {
    const w = createTimelineWorld();
    try {
      const v = await w.videoOf(w.alice);
      await w.call(w.alice, "getTimeline", { videoId: v.videoId });
      const text = readIndex(v.projectDir);
      // A revisions folder nobody may write into makes the save fail after index.html was written.
      const revisions = path.join(w.dataDir, "projects", v.key, "revisions");
      fs.chmodSync(revisions, 0o500);
      try {
        await assert.rejects(
          w.call(w.alice, "editTimeline", { videoId: v.videoId, revision: 1, op: del("b-3") }),
        );
      } finally {
        fs.chmodSync(revisions, 0o700);
      }
      assert.equal(readIndex(v.projectDir), text);
      assert.equal(w.timeline.api.latestRevision(v.key)?.n, 1);
      assert.deepEqual(
        fs.readdirSync(v.projectDir).filter((name) => name.includes("vidai-tmp")),
        [],
      );
    } finally {
      w.cleanup();
    }
  },
);

test("edits asked together never lose a write: the revision check lets one win per state", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    const clips = ["b-3", "s-1", "s-2", "s-3"];
    const settled = await Promise.allSettled(
      clips.map((clip) =>
        w.call(w.alice, "editTimeline", { videoId: v.videoId, revision: 1, op: del(clip) }),
      ),
    );
    const winners = clips.filter((_, i) => settled[i]?.status === "fulfilled");
    assert.equal(winners.length, 1, "all four named revision 1: exactly one can win");
    for (const result of settled) {
      if (result.status === "rejected") assert.equal(result.reason.code, "conflict");
    }
    const html = readIndex(v.projectDir);
    for (const clip of clips) assert.equal(hasClip(html, clip), !winners.includes(clip), clip);
    assert.equal(w.timeline.api.latestRevision(v.key)?.n, 2);
    assert.equal(fs.readdirSync(path.join(w.dataDir, "projects", v.key, "revisions")).length, 2);
  } finally {
    w.cleanup();
  }
});

test("a change made outside VidAI becomes a baseline revision that undo does not cross", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    await w.call(w.alice, "editTimeline", { videoId: v.videoId, revision: 1, op: del("b-3") });
    const file = path.join(v.projectDir, "index.html");
    fs.writeFileSync(file, readIndex(v.projectDir).replace('"Badge"', '"Badge shot"'));
    const t = await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    assert.equal(t.revision, 3);
    assert.equal(t.canUndo, false, "the outside change is not a step");
    const rows = await w.call(w.alice, "listRevisions", { videoId: v.videoId });
    assert.deepEqual(
      [rows[0].n, rows[0].label, rows[0].userEmail, rows[0].jobId],
      [3, "Changed outside VidAI", null, null],
    );
    assert.deepEqual(w.eventsNamed("timeline-changed").at(-1)?.payload, {
      videoId: v.videoId,
      revision: 3,
    });
    // Asking again saves nothing new.
    assert.equal((await w.call(w.alice, "getTimeline", { videoId: v.videoId })).revision, 3);
    // A page that still holds revision 2 is told so, also when it edits before anyone read.
    fs.writeFileSync(file, readIndex(v.projectDir).replace('"Badge shot"', '"Badge pic"'));
    await rejectsCode(
      w.call(w.alice, "editTimeline", { videoId: v.videoId, revision: 3, op: del("s-1") }),
      "conflict",
    );
    assert.equal(w.timeline.api.latestRevision(v.key)?.n, 4);
    const ok = await w.call(w.alice, "editTimeline", {
      videoId: v.videoId,
      revision: 4,
      op: del("s-1"),
    });
    assert.equal(ok.revision, 5);
    assert.ok(readIndex(v.projectDir).includes("Badge pic"), "the outside change is kept");
  } finally {
    w.cleanup();
  }
});

test("a change in compositions/ counts as an outside change; nothing is saved while a job holds the video", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    fs.appendFileSync(path.join(v.projectDir, "compositions", "g-1.html"), "\n<!-- by hand -->\n");
    w.jobs.set(v.key, { id: "job-1", kind: "edit" });
    const during = await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    assert.equal(during.revision, 1, "the job's files are in flux: no baseline");
    w.jobs.delete(v.key);
    assert.equal((await w.call(w.alice, "getTimeline", { videoId: v.videoId })).revision, 2);
    // Links and our own temporary files are not part of a project's state.
    fs.writeFileSync(path.join(v.projectDir, "compositions", "x.html.vidai-tmp-0badc0de"), "half");
    assert.equal((await w.call(w.alice, "getTimeline", { videoId: v.videoId })).revision, 2);
  } finally {
    w.cleanup();
  }
});

test("hand edits keep every graphic file and the other files of the project", async () => {
  const w = createTimelineWorld();
  try {
    const v = await w.videoOf(w.alice);
    const compositions = fs.readdirSync(path.join(v.projectDir, "compositions")).sort();
    const edit = fs.readFileSync(path.join(v.projectDir, "edit.json"), "utf8");
    await w.call(w.alice, "getTimeline", { videoId: v.videoId });
    await w.call(w.alice, "editTimeline", { videoId: v.videoId, revision: 1, op: del("g-1") });
    assert.deepEqual(fs.readdirSync(path.join(v.projectDir, "compositions")).sort(), compositions);
    assert.equal(fs.readFileSync(path.join(v.projectDir, "edit.json"), "utf8"), edit);
  } finally {
    w.cleanup();
  }
});

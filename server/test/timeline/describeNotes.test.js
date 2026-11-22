import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { composeTimelineEdit } from "../../src/jobs/promptTimeline.js";
import { createDescribeNotes, readProjectFacts } from "../../src/timeline/describeNotes.js";
import { createNotePictures } from "../../src/timeline/notePictures.js";
import { timelineInput } from "../jobs/promptSupport.js";
import { fakeRunner, listTree, tempFolder } from "./noteSupport.js";

const INDEX = `<!doctype html><html><body>
<div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="30" data-duration="10">
<video id="a-1" class="clip" src="assets/media/aroll.mp4" data-start="0" data-duration="10" data-track-index="0" data-vidai-kind="aroll" data-vidai-label="A"></video>
</div></body></html>`;

/** @type {import("../../src/timeline/clipsAt.js").ClipAt[]} */
const CLIPS = [
  {
    id: "g-1",
    kind: "graphic",
    label: "Big number",
    track: 1,
    start: 0,
    duration: 90,
    file: "compositions/g-1.html",
  },
  {
    id: "a-1",
    kind: "aroll",
    label: "Hook",
    track: 0,
    start: 0,
    duration: 300,
    file: "assets/media/aroll.mp4",
  },
  {
    id: "m-1",
    kind: "music",
    label: "Bed",
    track: 10,
    start: 0,
    duration: 300,
    file: "assets/music/bed.mp3",
  },
];

/**
 * @param {{ transcript?: string | null, index?: string, runner?: Parameters<typeof fakeRunner>[0] }} [options]
 */
function setup({ transcript = null, index = INDEX, runner: runnerOptions } = {}) {
  const t = tempFolder("vidai-describe-");
  const project = path.join(t.dir, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "index.html"), index);
  if (transcript !== null) fs.writeFileSync(path.join(project, "transcript.json"), transcript);
  const runner = fakeRunner(runnerOptions);
  const warnings = /** @type {string[]} */ ([]);
  const log = { info() {}, warn: (/** @type {string} */ m) => warnings.push(m) };
  const noteDir = (/** @type {string} */ key, /** @type {string} */ id) =>
    path.join(t.dir, "notes-of", key, id);
  const describeNotes = createDescribeNotes({
    clipsAt: async (_key, frame) => (frame < 300 ? CLIPS : []),
    projectDir: async () => project,
    noteDir,
    pictures: createNotePictures({
      cli: "/pkg/hyperframes.mjs",
      ffmpeg: "ffmpeg-bin",
      workDir: path.join(t.dir, "tmp"),
      start: runner.start,
      log,
    }),
    log,
  });
  /** @param {string} id @param {number} frame @param {import("../../src/timeline/noteBox.js").NoteShape | null} shape */
  const note = (id, frame, shape = null) => ({
    id,
    frame,
    seconds: frame / 30,
    shape,
    elementId: null,
    prompt: `Change at ${frame}.`,
    author: "user@example.com",
    createdAt: 1,
    folder: noteDir("k", id),
  });
  return { ...t, project, runner, warnings, describeNotes, note, noteDir };
}

test("the project's frame rate and size come from the root element", async () => {
  const t = setup();
  try {
    assert.deepEqual(await readProjectFacts(t.project), {
      fps: { num: 30, den: 1 },
      width: 1920,
      height: 1080,
    });
    assert.equal(await readProjectFacts(path.join(t.dir, "missing")), null);
    fs.writeFileSync(path.join(t.project, "index.html"), "<html></html>");
    assert.equal(await readProjectFacts(t.project), null);
  } finally {
    t.cleanup();
  }
});

test("a request gets its pictures, its clips as stored and the words around its time", async () => {
  const words = JSON.stringify({
    words: [
      { word: "take", start: 2.4, end: 2.6 },
      { word: "the", start: 2.6, end: 2.8 },
      { word: "offer", start: 2.8, end: 3.2 },
    ],
  });
  const t = setup({ transcript: words });
  try {
    const shape = { cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.1 };
    const result = await t.describeNotes("k", [
      t.note("a".repeat(32), 80, shape),
      t.note("b".repeat(32), 500),
    ]);
    assert.equal(result.length, 2);
    const [first, second] = result;
    assert.equal(first.frame, 80);
    assert.deepEqual(first.shape, shape);
    assert.equal(first.prompt, "Change at 80.");
    assert.equal(first.elementId, null);
    assert.equal(first.pictures.frame, path.join(t.noteDir("k", "a".repeat(32)), "frame.png"));
    assert.equal(first.pictures.closeup, path.join(t.noteDir("k", "a".repeat(32)), "closeup.png"));
    assert.equal(
      first.pictures.marked,
      path.join(t.noteDir("k", "a".repeat(32)), "frame-marked.png"),
    );
    assert.ok(path.isAbsolute(first.pictures.frame ?? ""));
    // The clips, highest track first, sound last, as `clipsAt` gave them, with the fields of the prompt.
    assert.deepEqual(
      first.clips.map((c) => c.id),
      ["g-1", "a-1", "m-1"],
    );
    assert.deepEqual(first.clips[0], {
      id: "g-1",
      kind: "graphic",
      label: "Big number",
      track: 1,
      file: "compositions/g-1.html",
    });
    // Frame 80 is at 2.6833 s, inside "the".
    assert.equal(first.spoken, "take [at this frame: the] offer");
    // The second has no shape (no close-up), no clips at frame 500, and no words near 16.7 s.
    assert.equal(second.pictures.closeup, null);
    assert.equal(second.pictures.marked, null);
    assert.ok(second.pictures.frame);
    assert.deepEqual(second.clips, []);
    assert.equal(second.spoken, "");
    // ONE capture for both.
    assert.equal(t.runner.calls.filter((c) => c.args.includes("snapshot")).length, 1);
  } finally {
    t.cleanup();
  }
});

test("without a transcript the words are an empty string", async () => {
  const t = setup();
  try {
    const [r] = await t.describeNotes("k", [t.note("a".repeat(32), 10)]);
    assert.equal(r.spoken, "");
  } finally {
    t.cleanup();
  }
});

test("with a damaged transcript the request still goes out", async () => {
  const t = setup({ transcript: "{ damaged" });
  try {
    const [r] = await t.describeNotes("k", [t.note("a".repeat(32), 10)]);
    assert.equal(r.spoken, "");
    assert.ok(r.pictures.frame);
  } finally {
    t.cleanup();
  }
});

test("a failed capture gives null pictures and the request still goes out", async () => {
  const t = setup({
    runner: {
      override: () => ({
        code: 1,
        stdout: "",
        stderr: "no browser\n",
        timedOut: false,
        stopped: false,
      }),
    },
  });
  try {
    const [r] = await t.describeNotes("k", [
      t.note("a".repeat(32), 10, { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2 }),
    ]);
    assert.deepEqual(r.pictures, { frame: null, closeup: null, marked: null });
    assert.deepEqual(
      r.clips.map((c) => c.id),
      ["g-1", "a-1", "m-1"],
    );
    assert.ok(t.warnings.some((w) => w.includes("no browser")));
  } finally {
    t.cleanup();
  }
});

test("a project without a usable index.html gives requests without pictures, never an error", async () => {
  const t = setup({ index: "<html></html>" });
  try {
    const [r] = await t.describeNotes("k", [t.note("a".repeat(32), 10)]);
    assert.deepEqual(r.pictures, { frame: null, closeup: null, marked: null });
    assert.equal(r.spoken, "");
    assert.equal(t.runner.calls.length, 0);
  } finally {
    t.cleanup();
  }
});

test("no requests, no work", async () => {
  const t = setup();
  try {
    assert.deepEqual(await t.describeNotes("k", []), []);
    assert.equal(t.runner.calls.length, 0);
  } finally {
    t.cleanup();
  }
});

test("the project folder is left as it was", async () => {
  const t = setup({ transcript: JSON.stringify({ words: [] }) });
  try {
    const before = listTree(t.project);
    await t.describeNotes("k", [
      t.note("a".repeat(32), 10, { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2 }),
    ]);
    assert.deepEqual(listTree(t.project), before);
  } finally {
    t.cleanup();
  }
});

test("the result composes into the message with the picture paths and the words", async () => {
  const t = setup({
    transcript: JSON.stringify({
      words: [
        { word: "hello", start: 0, end: 0.5 },
        { word: "there", start: 0.5, end: 1 },
      ],
    }),
  });
  try {
    const shape = { cx: 0.3, cy: 0.4, rx: 0.1, ry: 0.1 };
    const requests = await t.describeNotes("k", [
      t.note("a".repeat(32), 10, shape),
      t.note("b".repeat(32), 400),
    ]);
    const message = composeTimelineEdit({ ...timelineInput(), requests });
    const dir = t.noteDir("k", "a".repeat(32));
    assert.ok(message.includes(`- Full frame: ${path.join(dir, "frame.png")}`));
    assert.ok(
      message.includes(
        `- Full frame with my ellipse drawn on it (shows where the close-up sits): ${path.join(dir, "frame-marked.png")}`,
      ),
    );
    assert.ok(
      message.includes(
        `- Close-up of the area (read the detail from this one): ${path.join(dir, "closeup.png")}`,
      ),
    );
    assert.ok(message.includes('Words spoken around this time: "[at this frame: hello] there"'));
    assert.ok(message.includes('- g-1 | graphic | "Big number" | track 1 | compositions/g-1.html'));
    assert.ok(message.includes("REQUEST 2 OF 2"));
    assert.ok(message.includes("Words spoken around this time: none"));
    assert.ok(message.includes("Clips at this frame: none."));
  } finally {
    t.cleanup();
  }
});

test("pictures that could not be made are said so in the message", async () => {
  const t = setup({
    runner: {
      override: () => ({ code: 1, stdout: "", stderr: "x", timedOut: false, stopped: false }),
    },
  });
  try {
    const requests = await t.describeNotes("k", [t.note("a".repeat(32), 10)]);
    const message = composeTimelineEdit({ ...timelineInput(), requests });
    assert.ok(!message.includes("Full frame"));
    assert.ok(!message.includes("Close-up"));
    assert.ok(!message.includes("Pictures:\n"));
  } finally {
    t.cleanup();
  }
});

test("removeFor and sweep clean the request folders", async () => {
  const t = setup();
  try {
    const a = "a".repeat(32);
    const b = "b".repeat(32);
    await t.describeNotes("k", [t.note(a, 10), t.note(b, 20)]);
    assert.ok(fs.existsSync(path.join(t.noteDir("k", a), "frame.png")));
    await t.describeNotes.removeFor("k", a);
    assert.equal(fs.existsSync(t.noteDir("k", a)), false);
    assert.deepEqual(await t.describeNotes.sweep("k", []), [b]);
    assert.equal(fs.existsSync(t.noteDir("k", b)), false);
  } finally {
    t.cleanup();
  }
});

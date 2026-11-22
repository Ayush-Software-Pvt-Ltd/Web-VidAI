// Change requests, the pure part: input checks and the clips under a frame
// (docs/SPEC.md section 11, Change requests).

import assert from "node:assert/strict";
import test from "node:test";
import { parseProject } from "../../src/timeline/document.js";
import { clipsAtFrame } from "../../src/timeline/clipsAt.js";
import { MAX_PROMPT_CHARS, toNoteView, validateNote } from "../../src/timeline/notes.js";
import { fixture } from "./helpers.js";

const project = { duration: 1350, clipIds: new Set(["a-1", "b-2"]) };
const good = { frame: 100, shape: null, elementId: null, prompt: "Make it bigger" };

/** @param {Record<string, unknown>} change @param {RegExp} message */
function refused(change, message) {
  assert.throws(
    () => validateNote({ ...good, ...change }, project),
    (error) => {
      const e = /** @type {{ code: string, message: string }} */ (error);
      assert.equal(e.code, "invalidInput");
      assert.match(e.message, message);
      return true;
    },
  );
}

test("a valid request is accepted and the prompt is trimmed", () => {
  assert.deepEqual(validateNote({ ...good, prompt: "  Bigger \n" }, project), {
    ...good,
    prompt: "Bigger",
  });
  const full = {
    frame: 1349,
    shape: { cx: 0.5, cy: 0, rx: 1, ry: 0.01 },
    elementId: "b-2",
    prompt: "x",
  };
  assert.deepEqual(validateNote(full, project), full);
  // A missing shape or element is the whole frame.
  assert.deepEqual(validateNote({ frame: 0, prompt: "x" }, project), {
    frame: 0,
    shape: null,
    elementId: null,
    prompt: "x",
  });
});

test("the frame must be a whole number inside the video", () => {
  refused({ frame: -1 }, /not inside the video/);
  refused({ frame: 1350 }, /frames 0 to 1349/);
  refused({ frame: 1.5 }, /whole number/);
  refused({ frame: "3" }, /whole number/);
  refused({ frame: Number.NaN }, /whole number/);
});

test("the ellipse is fractions of the frame with positive radii", () => {
  refused({ shape: { cx: 0.5, cy: 0.5, rx: 0, ry: 0.2 } }, /above zero/);
  refused({ shape: { cx: 0.5, cy: 0.5, rx: 0.2, ry: -0.1 } }, /above zero/);
  refused({ shape: { cx: 0.5, cy: 0.5, rx: 1.01, ry: 0.2 } }, /at most the whole frame/);
  refused({ shape: { cx: -0.1, cy: 0.5, rx: 0.2, ry: 0.2 } }, /centre/);
  refused({ shape: { cx: 0.5, cy: 1.1, rx: 0.2, ry: 0.2 } }, /centre/);
  refused({ shape: { cx: 0.5, cy: 0.5, rx: 0.2 } }, /as numbers/);
  refused({ shape: { cx: "0.5", cy: 0.5, rx: 0.2, ry: 0.2 } }, /as numbers/);
  refused({ shape: { cx: Infinity, cy: 0.5, rx: 0.2, ry: 0.2 } }, /as numbers/);
  refused({ shape: "round" }, /ellipse/);
  refused({ shape: [1, 2] }, /ellipse/);
});

test("the clip must exist, the text must have 1 to 4000 characters after trimming", () => {
  refused({ elementId: "nope" }, /not in this video/);
  refused({ elementId: 7 }, /not in this video/);
  refused({ prompt: "" }, /Write what/);
  refused({ prompt: "   \n " }, /Write what/);
  refused({ prompt: 5 }, /Write what/);
  refused({ prompt: undefined }, /Write what/);
  refused({ prompt: "x".repeat(MAX_PROMPT_CHARS + 1) }, /at most 4000/);
  assert.equal(
    validateNote({ ...good, prompt: "x".repeat(MAX_PROMPT_CHARS) }, project).prompt.length,
    4000,
  );
  // Characters, not UTF-16 units: 4000 emoji are allowed.
  assert.equal(
    [...validateNote({ ...good, prompt: "\u{1F600}".repeat(4000) }, project).prompt].length,
    4000,
  );
  assert.throws(() => validateNote(null, project), /missing/);
  assert.throws(() => validateNote("text", project), /missing/);
});

test("toNoteView shows the wire fields and no author", () => {
  const view = toNoteView({
    id: "n1",
    videoKey: "k",
    userId: "u",
    frame: 3,
    shape: null,
    elementId: "a-1",
    prompt: "p",
    state: "running",
    jobId: "j",
    error: "It broke.",
    createdAt: 9,
  });
  assert.deepEqual(view, {
    id: "n1",
    frame: 3,
    shape: null,
    elementId: "a-1",
    prompt: "p",
    state: "running",
    jobId: "j",
    error: "It broke.",
    createdAt: 9,
  });
});

test("clipsAtFrame lists the clips under a frame from the top track down, sound last", () => {
  const parsed = parseProject(fixture("long").html);
  // Frame 210 (7 s): a-2 (A-roll), ov-1 (overlay 6.67 s to 9.67 s), s? none; 8.33 s has h-1 later.
  const at = (/** @type {number} */ frame) => clipsAtFrame(parsed, frame).map((c) => c.id);
  assert.deepEqual(at(210), ["ov-1", "a-2", "m-1"]);
  // Frame 250 (8.33 s): the hit joins, above the overlay.
  assert.deepEqual(at(250), ["h-1", "ov-1", "a-2", "m-1"]);
  // The last frame of a clip is inside, the frame after it is not (a-2 is 150 to 360).
  assert.ok(at(359).includes("a-2") && !at(360).includes("a-2"));
  assert.ok(at(360).includes("a-3"));
  // The end fade is on top, in the last 2 seconds.
  assert.equal(at(1300)[0], "fade-1");
  // Sound clips come after the pictures, the higher track first.
  const sound = clipsAtFrame(parsed, 700);
  assert.deepEqual(
    sound.map((c) => c.track),
    [...sound.map((c) => c.track)].sort((a, b) => (a >= 10 === b >= 10 ? b - a : a >= 10 ? 1 : -1)),
  );
  assert.deepEqual(clipsAtFrame(parsed, 5000), []);
  // What a clip plays: the media link, or the graphic's file.
  const g = clipsAtFrame(parsed, 650).find((c) => c.id === "g-1");
  assert.deepEqual(
    [g?.kind, g?.file, g?.track, g?.start, g?.duration],
    ["graphic", "compositions/g-1.html", 1, 600, 90],
  );
  assert.equal(
    clipsAtFrame(parsed, 210).find((c) => c.id === "a-2")?.file,
    "assets/media/aroll.mp4",
  );
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadWords, readWords, spokenAround, spokenAtFrame } from "../../src/timeline/spoken.js";
import { fpsOf, tempFolder } from "./noteSupport.js";

const fps = fpsOf(30, 1);
/** One word per half second starting at `from`. */
const talk = (/** @type {string[]} */ text, from = 0) =>
  text.map((word, i) => ({ word, start: from + i * 0.5, end: from + i * 0.5 + 0.4 }));

test("the word at the frame is marked and the words around it are kept", () => {
  const words = readWords({ words: talk(["so", "this", "is", "the", "offer", "for", "you"]) });
  // Frame 45 is at 1.5167 s: inside "the" (1.5 to 1.9).
  assert.equal(spokenAround(words, 1.5167), "so this is [at this frame: the] offer for you");
});

test("only the words from 4 seconds before to 4 seconds after are in", () => {
  const words = readWords({ words: talk(Array.from({ length: 40 }, (_, i) => `w${i}`)) });
  // At 10.25 s: window 6.25 to 14.25 s; w12 spans 6.0 to 6.4 (overlaps), w28 starts at 14.0.
  const line = spokenAround(words, 10.25);
  const parts = line.replace("[at this frame: ", "").replace("]", "").split(" ");
  assert.equal(parts[0], "w12");
  assert.equal(parts[parts.length - 1], "w28");
  assert.ok(line.includes("[at this frame: w20]"));
  assert.ok(!line.includes("w11 ") && !line.includes("w29"));
});

test("at the start of the video there are no words before", () => {
  const words = readWords({ words: talk(["hello", "and", "welcome"]) });
  assert.equal(spokenAround(words, 0.0167), "[at this frame: hello] and welcome");
});

test("at the end of the video the frame is after the last word", () => {
  const words = readWords({ words: talk(["thanks", "for", "watching"]) });
  // The last word ends at 1.4 s; at 1.45 s nothing is spoken.
  assert.equal(spokenAround(words, 1.45), "thanks for watching [at this frame: silence]");
  assert.equal(spokenAround(words, 1.2), "thanks for [at this frame: watching]");
});

test("in a silence the marker stands between the words", () => {
  const words = readWords({
    words: [
      { word: "before", start: 0, end: 0.5 },
      { word: "after", start: 3, end: 3.5 },
    ],
  });
  assert.equal(spokenAround(words, 1.5), "before [at this frame: silence] after");
});

test("a silence before the first word of the window", () => {
  const words = readWords({ words: [{ word: "late", start: 3, end: 3.4 }] });
  assert.equal(spokenAround(words, 1), "[at this frame: silence] late");
});

test("no words in the window gives an empty line", () => {
  const words = readWords({ words: [{ word: "far", start: 100, end: 100.5 }] });
  assert.equal(spokenAround(words, 5), "");
  assert.equal(spokenAround([], 5), "");
});

test("damaged entries are skipped and never throw", () => {
  const words = readWords({
    words: [
      null,
      "text",
      { word: 5, start: 0, end: 1 },
      { word: "nan", start: Number.NaN, end: 1 },
      { word: "backwards", start: 2, end: 1 },
      { word: "  ", start: 0, end: 1 },
      { word: "no times" },
      { word: "good   word", start: 1, end: 2 },
      { word: "first", start: 0, end: 0.5 },
    ],
  });
  assert.deepEqual(
    words.map((w) => w.word),
    ["first", "good word"],
  );
  assert.deepEqual(readWords(null), []);
  assert.deepEqual(readWords([]), []);
  assert.deepEqual(readWords({ words: "no" }), []);
  assert.deepEqual(readWords(42), []);
});

test("words are sorted by time whatever the order in the file", () => {
  const words = readWords({
    words: [
      { word: "b", start: 1, end: 1.4 },
      { word: "a", start: 0, end: 0.4 },
    ],
  });
  assert.equal(spokenAround(words, 0.2), "[at this frame: a] b");
});

test("a project without a transcript, with a damaged one and with a good one", async () => {
  const { dir, cleanup } = tempFolder("vidai-spoken-");
  try {
    assert.equal(await spokenAtFrame(dir, 10, fps), "");
    assert.deepEqual(await loadWords(dir), []);
    fs.writeFileSync(path.join(dir, "transcript.json"), "{ not json");
    assert.equal(await spokenAtFrame(dir, 10, fps), "");
    fs.writeFileSync(path.join(dir, "transcript.json"), JSON.stringify({ words: "wrong" }));
    assert.equal(await spokenAtFrame(dir, 10, fps), "");
    fs.writeFileSync(path.join(dir, "transcript.json"), "[1,2,3]");
    assert.equal(await spokenAtFrame(dir, 10, fps), "");
    fs.writeFileSync(
      path.join(dir, "transcript.json"),
      JSON.stringify({ words: talk(["one", "two"]) }),
    );
    // Frame 15 is at 0.5167 s: inside "two" (0.5 to 0.9).
    assert.equal(await spokenAtFrame(dir, 15, fps), "one [at this frame: two]");
  } finally {
    cleanup();
  }
});

test("the times are timeline seconds: the frame is compared with them directly", async () => {
  const { dir, cleanup } = tempFolder("vidai-spoken-");
  try {
    fs.writeFileSync(
      path.join(dir, "transcript.json"),
      JSON.stringify({ words: [{ word: "Hindi शब्द", start: 5, end: 5.6 }] }),
    );
    // Frame 151 of 30 fps is at 5.0167 s.
    assert.equal(await spokenAtFrame(dir, 150, fps), "[at this frame: Hindi शब्द]");
    assert.equal(await spokenAtFrame(dir, 3000, fps), "");
  } finally {
    cleanup();
  }
});

test("at 29.97 fps the frame time is exact", () => {
  const rate = fpsOf(30000, 1001);
  const words = readWords({ words: [{ word: "edge", start: 3.3366666, end: 3.4 }] });
  // Frame 100 spans 3.3367 to 3.3700; its middle 3.3533 is inside the word.
  assert.equal(
    spokenAround(words, ((2 * 100 + 1) * rate.den) / (2 * rate.num)),
    "[at this frame: edge]",
  );
});

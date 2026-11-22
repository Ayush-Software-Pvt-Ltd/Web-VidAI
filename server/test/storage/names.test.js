// The folder naming rules carried over from the desktop scanner (SPEC-desktop.md section 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  brollFolderName,
  isBrollName,
  isReservedChannelEntry,
  naturalCompare,
} from "../../src/storage/names.js";

test("reserved names inside a channel", () => {
  for (const name of [
    ".hidden",
    ".DS_Store",
    "CLAUDE_VE",
    "CLAUDE_VE_cache",
    "Style",
    "STYLE",
    "sample",
    "Samples",
    "images",
    "Pictures",
    "Host Images",
    "host pictures",
  ]) {
    assert.equal(isReservedChannelEntry(name), true, name);
  }
  for (const name of ["Video 1", "claude_ve", "My Style", "Images 2", "Host-Images"]) {
    assert.equal(isReservedChannelEntry(name), false, name);
  }
});

test("B-roll folder names", () => {
  for (const name of ["broll", "Broll", "B-roll", "b_rolls", "B Roll", "BROLLS", "b-rolls"]) {
    assert.equal(isBrollName(name), true, name);
  }
  for (const name of ["brolly", "b roll x", "roll", "bb-roll", "b--roll", "a-roll"]) {
    assert.equal(isBrollName(name), false, name);
  }
});

test("brollFolderName takes the first match in natural order, else Broll", () => {
  assert.equal(brollFolderName([]), "Broll");
  assert.equal(brollFolderName(["Sample", "Other"]), "Broll");
  assert.equal(brollFolderName(["B_Roll", "b-roll"]), "b-roll");
  assert.equal(brollFolderName(["x", "broll"]), "broll");
});

test("naturalCompare orders numbers as numbers and ignores case", () => {
  const sorted = ["Video 10", "video 2", "Video 1", "a", "B", "10", "9"].sort(naturalCompare);
  assert.deepEqual(sorted, ["9", "10", "a", "B", "Video 1", "video 2", "Video 10"]);
  assert.equal(naturalCompare("a", "a"), 0);
  // The order is total: names that look equal still compare.
  assert.notEqual(naturalCompare("a", "A"), 0);
  assert.equal(naturalCompare("a", "A"), -naturalCompare("A", "a"));
});

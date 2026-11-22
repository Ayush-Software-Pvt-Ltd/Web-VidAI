import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBytes } from "../../src/disk/format.js";

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

test("bytes and kilobytes are whole numbers", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1), "1 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(KB), "1 KB");
  assert.equal(formatBytes(1536), "2 KB");
  assert.equal(formatBytes(300 * KB), "300 KB");
});

test("megabytes and gigabytes have one decimal", () => {
  assert.equal(formatBytes(MB), "1.0 MB");
  assert.equal(formatBytes(1.5 * MB), "1.5 MB");
  assert.equal(formatBytes(512 * MB), "512.0 MB");
  assert.equal(formatBytes(GB), "1.0 GB");
  assert.equal(formatBytes(Math.round(12.3 * GB)), "12.3 GB");
  assert.equal(formatBytes(Math.round(12.34 * GB)), "12.3 GB");
  assert.equal(formatBytes(Math.round(12.36 * GB)), "12.4 GB");
});

test("a value that rounds up moves to the next unit", () => {
  assert.equal(formatBytes(1023.6 * KB), "1.0 MB");
  assert.equal(formatBytes(MB - 1), "1.0 MB");
  assert.equal(formatBytes(GB - 1), "1.0 GB");
  assert.equal(formatBytes(1023.94 * MB), "1023.9 MB");
});

test("gigabytes are the top unit", () => {
  assert.equal(formatBytes(2048 * GB), "2048.0 GB");
});

test("nonsense counts as nothing", () => {
  assert.equal(formatBytes(-5), "0 B");
  assert.equal(formatBytes(Number.NaN), "0 B");
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), "0 B");
});

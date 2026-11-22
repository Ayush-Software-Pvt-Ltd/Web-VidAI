import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createLogger } from "../../src/log.js";

describe("createLogger", () => {
  /** @type {string} */
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-log-"));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const clock = { now: () => Date.UTC(2026, 10, 22, 8, 30, 0) };

  test("one line per entry: ISO time, level, message", () => {
    const file = path.join(dir, "a", "server.log");
    const log = createLogger({ file, clock });
    log.info("started");
    log.warn("careful");
    log.error("broke", "details here");
    assert.equal(
      fs.readFileSync(file, "utf8"),
      [
        "2026-11-22T08:30:00.000Z INFO started",
        "2026-11-22T08:30:00.000Z WARN careful",
        "2026-11-22T08:30:00.000Z ERROR broke details here",
        "",
      ].join("\n"),
    );
  });

  test("an error detail brings its stack and an object its JSON", () => {
    const file = path.join(dir, "detail.log");
    const log = createLogger({ file, clock });
    log.error("failed", new Error("kaput"));
    log.info("shape", { a: 1 });
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /ERROR failed\nError: kaput\n\s+at /);
    assert.match(text, /INFO shape \{"a":1\}\n$/);
  });

  test("appends to an existing file", () => {
    const file = path.join(dir, "append.log");
    createLogger({ file, clock }).info("one");
    createLogger({ file, clock }).info("two");
    assert.equal(fs.readFileSync(file, "utf8").split("\n").length, 3);
  });

  test("rotates at the size limit and keeps only `keep` old files", () => {
    const file = path.join(dir, "rotate.log");
    const log = createLogger({ file, clock, maxBytes: 200, keep: 3 });
    for (let i = 0; i < 40; i++) log.info(`entry number ${i} with some padding to fill space`);
    const names = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith("rotate.log"))
      .sort();
    assert.deepEqual(names, ["rotate.log", "rotate.log.1", "rotate.log.2", "rotate.log.3"]);
    for (const name of names) {
      assert.ok(fs.statSync(path.join(dir, name)).size <= 200, name);
    }
    // Newest entries are in the current file, older in higher numbers.
    const current = fs.readFileSync(file, "utf8");
    assert.ok(current.includes("entry number 39"));
    assert.ok(fs.readFileSync(`${file}.1`, "utf8").includes("entry number"));
    const first = Number(/entry number (\d+)/.exec(fs.readFileSync(`${file}.1`, "utf8"))?.[1]);
    const oldest = Number(/entry number (\d+)/.exec(fs.readFileSync(`${file}.3`, "utf8"))?.[1]);
    assert.ok(oldest < first);
  });

  test("a file already over the limit is rotated on the first write", () => {
    const file = path.join(dir, "big.log");
    fs.writeFileSync(file, "x".repeat(300));
    createLogger({ file, clock, maxBytes: 200, keep: 2 }).info("fresh");
    assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "x".repeat(300));
    assert.match(fs.readFileSync(file, "utf8"), /fresh/);
  });

  test("a console target receives every line with its level", () => {
    /** @type {string[]} */
    const seen = [];
    const log = createLogger({
      file: null,
      clock,
      console: {
        write: (line, level) => {
          seen.push(`${level}:${line.trim()}`);
        },
      },
    });
    log.info("a");
    log.error("b");
    assert.deepEqual(seen, [
      "info:2026-11-22T08:30:00.000Z INFO a",
      "error:2026-11-22T08:30:00.000Z ERROR b",
    ]);
  });

  test("never throws: an unwritable file, a failing console, odd details", () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "x");
    const log = createLogger({
      file: path.join(blocker, "sub", "server.log"),
      clock,
      console: {
        write: () => {
          throw new Error("closed");
        },
      },
    });
    /** @type {Record<string, unknown>} */
    const circular = {};
    circular.self = circular;
    log.info("ok");
    log.warn("circular", circular);
    log.error("bigint", 10n);
  });
});

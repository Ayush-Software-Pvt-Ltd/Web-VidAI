// Recordings of real Claude Code stdout (server/test/support/fixtures/claude-stream/).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLine } from "../../src/agents/claude/protocol.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-stream");

/**
 * The raw text of a recording.
 * @param {string} name
 * @returns {string}
 */
export function fixtureText(name) {
  return fs.readFileSync(path.join(dir, name), "utf8");
}

/**
 * Every line of a recording as an event; a line that does not parse fails the test.
 * @param {string} name
 * @returns {import("../../src/agents/claude/protocol.js").StreamEvent[]}
 */
export function fixture(name) {
  return fixtureText(name)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const event = parseLine(line);
      if (event === null) throw new Error(`unparsed line: ${line}`);
      return event;
    });
}

/**
 * Events from raw JSON lines (blank lines and lines that do not parse are dropped).
 * @param {string} text
 * @returns {import("../../src/agents/claude/protocol.js").StreamEvent[]}
 */
export function lines(text) {
  return text.split("\n").flatMap((line) => {
    const event = parseLine(line);
    return event === null ? [] : [event];
  });
}

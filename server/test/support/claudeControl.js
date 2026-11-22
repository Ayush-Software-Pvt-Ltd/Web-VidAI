// Helpers of the tests of the Claude Code control helper (`server/src/agents/claude/`): temporary
// folders, the environments of the fakes, and an in-memory stand-in for a helper process.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The recorded answers of Claude Code's control requests. */
export const CONTROL_FIXTURES = path.join(here, "fixtures", "claude-control");
/** The fake Claude Code that answers `--version`, `auth status` and the control requests. */
export const FAKE_CLAUDE = path.join(CONTROL_FIXTURES, "fake-claude.sh");
/** A fake that never answers and ignores SIGTERM. */
export const FAKE_HANG = path.join(here, "fake-claude-hang.sh");
/** A fake that only records that it was started. */
export const FAKE_RECORDER = path.join(here, "fake-claude-recorder.sh");
/** The tests need a POSIX shell for the fakes. */
export const POSIX_ONLY = process.platform === "win32" ? "needs a POSIX shell" : false;

/** @type {string[]} */
const dirs = [];

/**
 * A new temporary folder, removed after the test file ran. Call at the top level or in a test.
 * @returns {string}
 */
export function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-claude-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The environment for the fake: a bare `PATH`, the fixtures, and a log file in `dir`.
 * @param {string} dir
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function fakeEnv(dir, extra = {}) {
  return {
    PATH: "/usr/bin:/bin",
    FAKE_CLAUDE_FIXTURES: CONTROL_FIXTURES,
    FAKE_CLAUDE_LOG: path.join(dir, "log"),
    ...extra,
  };
}

/**
 * The log the fakes write (empty when nothing was started).
 * @param {string} dir
 * @returns {string}
 */
export function logOf(dir) {
  try {
    return fs.readFileSync(path.join(dir, "log"), "utf8");
  } catch {
    return "";
  }
}

/** How often the fake helper was started, from its log. @param {string} dir @returns {number} */
export function startsIn(dir) {
  return logOf(dir)
    .split("\n")
    .filter((l) => l.startsWith("start ")).length;
}

/** Lets every pending promise callback run (all the fake clients answer in microtasks). */
export async function settle() {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A manual clock.
 * @param {number} [start]
 */
export function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    /** @param {number} ms */
    advance(ms) {
      now += ms;
    },
  };
}

/**
 * Timers that never fire by themselves: `fire()` runs the interval callbacks once.
 */
export function fakeTimers() {
  /** @type {Map<number, { fn: () => void, ms: number }>} */
  const intervals = new Map();
  let next = 1;
  const timers = {
    /** @type {typeof setInterval} */
    setInterval: /** @type {any} */ (
      (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
        const id = next;
        next += 1;
        intervals.set(id, { fn, ms });
        return { id, unref() {}, ref() {} };
      }
    ),
    /** @type {typeof clearInterval} */
    clearInterval: /** @type {any} */ (
      (/** @type {{ id: number } | undefined} */ handle) => {
        if (handle) intervals.delete(handle.id);
      }
    ),
  };
  return {
    ...timers,
    /** How many intervals are running. */
    get running() {
      return intervals.size;
    },
    /** The period of the first interval. */
    get period() {
      return [...intervals.values()][0]?.ms ?? null;
    },
    /** Runs every interval callback once (one tick). */
    fire() {
      for (const { fn } of [...intervals.values()]) fn();
    },
  };
}

/**
 * @typedef {object} FakeClientOptions
 * @property {number} startedAt
 * @property {Record<string, unknown>} answers By subtype: a value, an `Error` to reject with, or
 *   a function of the call number (from 1) returning either. A subtype that is missing never
 *   answers (the promise stays open until `close`).
 */

/**
 * An in-memory helper: records its requests, answers from `answers`, and counts its closing.
 * @param {FakeClientOptions} options
 */
export function fakeClient(options) {
  /** @type {string[]} */
  const calls = [];
  /** @type {Array<(error: Error) => void>} */
  const waiting = [];
  let alive = true;
  let closed = 0;
  return {
    pid: 4242,
    startedAt: options.startedAt,
    calls,
    get closed() {
      return closed;
    },
    /** Marks the process as dead, as when it exited by itself. */
    die() {
      alive = false;
    },
    isAlive: () => alive,
    /** @param {string} subtype @param {number} _timeoutMs @returns {Promise<unknown>} */
    request(subtype, _timeoutMs) {
      calls.push(subtype);
      const count = calls.filter((c) => c === subtype).length;
      if (!alive) return Promise.reject(new Error("Claude Code stopped unexpectedly."));
      if (!(subtype in options.answers)) {
        return new Promise((_resolve, reject) => waiting.push(reject));
      }
      const given = options.answers[subtype];
      const answer = typeof given === "function" ? given(count) : given;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    close() {
      closed += 1;
      alive = false;
      for (const reject of waiting.splice(0))
        reject(new Error("The Claude Code helper was closed."));
      return Promise.resolve();
    },
  };
}

/**
 * The recorded answer of a control request.
 * @param {string} name File in the fixtures folder, for example `get_usage.json`.
 * @returns {any}
 */
export function control(name) {
  return JSON.parse(fs.readFileSync(path.join(CONTROL_FIXTURES, name), "utf8"));
}

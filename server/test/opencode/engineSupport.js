// Shared by the OpenCode driver tests: a world of temporary folders, the fake OpenCode 2 program
// (`server/test/support/fake-opencode2.py`), and a collector for what a session reports.
//
// Not a test file (no `.test.js`), so `node --test` does not run it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAlive } from "../../src/platform/process.js";
import { startOpencodeSession } from "../../src/agents/opencode/session.js";

/** @typedef {import("../../src/agents/claude/session.js").SessionEvent} SessionEvent */
/** @typedef {import("../../src/agents/opencode/session.js").OpencodeSession} OpencodeSession */

export const FAKE = fileURLToPath(new URL("../support/fake-opencode2.py", import.meta.url));

/** The key the tests give the option. It is no real key. */
export const KEY = "sk-test-0123456789abcdef-not-a-real-key";
export const MODEL = "glm-5.3";

/** Timings that keep the tests fast; the defaults are tested separately. */
export const FAST = {
  pollMs: 10,
  drainMs: 500,
  stderrDrainMs: 100,
  closeGraceMs: 1_500,
  reconnectGapsMs: [20, 40],
  exitNoticeMs: 500,
};

/**
 * Fails with a clear message when the fake cannot run (never a silent skip).
 */
export function requireFake() {
  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  assert.equal(
    python.status,
    0,
    "python3 must be on PATH: the fake OpenCode 2 (server/test/support/fake-opencode2.py) needs it",
  );
  const mode = fs.statSync(FAKE).mode;
  assert.ok((mode & 0o111) !== 0, `${FAKE} must be executable (chmod +x)`);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Polls until `check` returns something other than `undefined`/`false`.
 * @template T
 * @param {string} what
 * @param {() => T | false | undefined} check
 * @param {number} [ms]
 * @returns {Promise<T>}
 */
export async function until(what, check, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

/**
 * The instructions of an edit, with the lines the fake reads.
 * @param {string} [video]
 * @returns {string}
 */
export function editPrompt(video = "Video A") {
  return `MAIN_FOLDER = ${video}\nCHANNEL_FOLDER = Channel\nREVIEW_OUTPUT_SOFTWARE = Final Cut Pro\n\nMake the edit.`;
}

/**
 * @typedef {object} World
 * @property {string} root
 * @property {string} state FAKE_STATE.
 * @property {string} editing The Editing Folder.
 * @property {string} home A home folder with a poisoned OpenCode configuration.
 * @property {string} jobDir
 * @property {Record<string, string>} env The base environment of a server.
 * @property {SessionEvent[]} events
 * @property {string[]} statuses
 * @property {string[]} warnings
 * @property {OpencodeSession[]} sessions
 * @property {string} launcher A program that records its pid in `launcher.pids` of FAKE_STATE and
 *   becomes the fake, so a test knows the pid of a server whose start failed.
 * @property {() => number[]} launched The pids the launcher recorded.
 * @property {(overrides?: Record<string, unknown>) => Promise<OpencodeSession>} start
 * @property {(name: string) => string} read A file of FAKE_STATE.
 * @property {(name: string) => boolean} has
 * @property {(prefix: string) => Array<[string, string]>} files Files of FAKE_STATE by prefix.
 * @property {() => Array<Record<string, string>>} calls What each server was started with.
 * @property {(session: string) => Array<Record<string, any>>} prompts
 * @property {(n: number) => Promise<void>} results Waits for the n-th `result` event.
 * @property {() => Promise<void>} exited Waits for the `exited` event.
 * @property {() => Array<Record<string, any>>} resultEvents
 */

/**
 * A world of temporary folders, with everything cleaned up after the test.
 * @param {import("node:test").TestContext} t
 * @param {Record<string, string>} [extraEnv] Variables of the server (`FAKE_SCENARIO`, ...).
 * @returns {World}
 */
export function makeWorld(t, extraEnv = {}) {
  requireFake();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-oc-"));
  const state = path.join(root, "state");
  const editing = path.join(root, "Editing Folder");
  const home = path.join(root, "home");
  const jobDir = path.join(root, "data", "opencode", "job-1");
  for (const dir of [state, editing, home]) fs.mkdirSync(dir, { recursive: true });
  const env = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: home,
    FAKE_STATE: state,
    FAKE_SCENARIO: "complete",
    ...extraEnv,
  };
  /** @type {SessionEvent[]} */
  const events = [];
  /** @type {string[]} */
  const statuses = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {OpencodeSession[]} */
  const sessions = [];

  /** @param {string} name */
  const read = (name) => fs.readFileSync(path.join(state, name), "utf8");
  /** @param {string} name */
  const has = (name) => fs.existsSync(path.join(state, name));

  const launcher = path.join(root, "launcher.sh");
  fs.writeFileSync(
    launcher,
    `#!/bin/sh\necho $$ >> "$FAKE_STATE/launcher.pids"\nexec "${FAKE}" "$@"\n`,
    { mode: 0o755 },
  );

  /** @type {World} */
  const world = {
    launcher,
    launched() {
      return has("launcher.pids")
        ? read("launcher.pids").split("\n").filter(Boolean).map(Number)
        : [];
    },
    root,
    state,
    editing,
    home,
    jobDir,
    env,
    events,
    statuses,
    warnings,
    sessions,
    async start(overrides = {}) {
      const session = await startOpencodeSession({
        command: FAKE,
        cwd: editing,
        env,
        jobDir,
        option: "opencodeGo",
        key: KEY,
        baseUrl: null,
        model: MODEL,
        effort: null,
        title: "Video A",
        onEvent: (event) => events.push(event),
        onStatus: (text) => statuses.push(text),
        onWarn: (text) => warnings.push(text),
        timings: FAST,
        ...overrides,
      });
      sessions.push(session);
      return session;
    },
    read,
    has,
    files(prefix) {
      return fs
        .readdirSync(state)
        .filter((name) => name.startsWith(prefix))
        .sort()
        .map((name) => [name.slice(prefix.length), read(name)]);
    },
    calls() {
      return fs
        .readdirSync(state)
        .filter((name) => name.startsWith("call."))
        .sort()
        .map((name) => {
          /** @type {Record<string, string>} */
          const call = {};
          for (const line of read(name).split("\n")) {
            const at = line.indexOf("=");
            if (at > 0) call[line.slice(0, at)] = line.slice(at + 1);
          }
          return call;
        });
    },
    prompts(session) {
      if (!has(`prompts.${session}`)) return [];
      return read(`prompts.${session}`)
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    resultEvents() {
      return events.flatMap((e) =>
        e.type === "line" && e.event.type === "result" ? [e.event] : [],
      );
    },
    async results(n) {
      await until(`result number ${n}`, () => world.resultEvents().length >= n);
    },
    async exited() {
      await until("the exit", () => events.some((e) => e.type === "exited"));
    },
  };

  t.after(async () => {
    for (const session of sessions) {
      session.close();
      let timer;
      await Promise.race([
        session.finished,
        new Promise((resolve) => {
          timer = setTimeout(resolve, 8_000);
        }),
      ]);
      clearTimeout(timer);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return world;
}

/**
 * Every pid listed in a file of `FAKE_STATE` (one per line).
 * @param {World} world
 * @param {string} name
 * @returns {number[]}
 */
export function pidsOf(world, name) {
  return world
    .read(name)
    .split("\n")
    .filter(Boolean)
    .map((line) => Number(line));
}

/**
 * Waits until none of `pids` is alive.
 * @param {number[]} pids
 */
export async function untilDead(pids) {
  for (const pid of pids) {
    await until(`process ${pid} to end`, () => !isAlive(pid));
  }
}

/**
 * The texts of the `text` of every assistant `line` event, for assertions on what was said.
 * @param {SessionEvent[]} events
 * @returns {string[]}
 */
export function lineTypes(events) {
  return events.flatMap((e) => (e.type === "line" ? [e.event.type] : [e.type]));
}

/**
 * A `fetch` for the tests of the event stream: it passes every request on, and lets the test cut
 * the event stream (`drop`) and, on the next connection, have everything the server sent before
 * delivered again first (a server that replays on reconnect).
 * @returns {{ fetch: typeof fetch, drop: () => void, connections: () => number }}
 */
export function droppableFetch() {
  /** @type {Uint8Array[]} */
  const recorded = [];
  let connections = 0;
  /** @type {(() => void) | null} */
  let cut = null;
  /** @type {typeof fetch} */
  const wrapped = async (input, init) => {
    if (!String(input).endsWith("/api/event")) return fetch(input, init);
    connections += 1;
    const replay = connections > 1 ? [...recorded] : [];
    const response = await fetch(input, init);
    const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
    let dropped = false;
    const body = new ReadableStream({
      start(controller) {
        cut = () => {
          dropped = true;
          void reader.cancel().catch(() => {});
          controller.error(new TypeError("terminated"));
        };
      },
      async pull(controller) {
        const next = replay.shift();
        if (next !== undefined) {
          controller.enqueue(next);
          return;
        }
        const { done, value } = await reader.read();
        if (dropped) return;
        if (done) {
          controller.close();
          return;
        }
        recorded.push(value);
        controller.enqueue(value);
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  };
  return {
    fetch: wrapped,
    drop: () => cut?.(),
    connections: () => connections,
  };
}

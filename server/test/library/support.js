// Shared set-up of the library tests: temporary folders, a fake ffprobe, and a whole world (the
// storage module, the library module on top of it, two users). Not a test file itself.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLibraryModule } from "../../src/library/index.js";
import { createWorld } from "../storage/support.js";

export { rejectsCode } from "../storage/support.js";

/** The media fixtures copied from the Rust tests. */
export const MEDIA_FIXTURES = path.join(import.meta.dirname, "../support/fixtures/media");

/** Makes a temporary folder (real path) and returns it with its cleanup. */
export function tempFolder() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vidai-library-")));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Writes a file (making its folders) and returns its path.
 * @param {string} file
 * @param {string | Buffer} [content]
 */
export function write(file, content = "x") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/**
 * Sets a file's modified time.
 * @param {string} file
 * @param {number} ms
 */
export function touch(file, ms) {
  fs.utimesSync(file, new Date(ms), new Date(ms));
}

/** Copies a media fixture to a path (making its folders). @param {string} name @param {string} to */
export function copyFixture(name, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(MEDIA_FIXTURES, name), to);
  return to;
}

/**
 * A fake `ffprobe` shell script. Its answer follows `FAKE_FFPROBE_MODE` (`ok`: a vertical video,
 * `garbage`, `hang`), and every call appends a line to `FAKE_FFPROBE_LOG`.
 * @param {string} dir
 * @returns {{ bin: string, log: string, calls: () => number, env: (mode: string) => Record<string, string> }}
 */
export function fakeFfprobe(dir) {
  const bin = path.join(dir, "fake-ffprobe.sh");
  const log = path.join(dir, "ffprobe-calls.log");
  write(
    bin,
    `#!/bin/sh
echo "$@" >> "$FAKE_FFPROBE_LOG"
case "$FAKE_FFPROBE_MODE" in
  ok) echo '{"streams":[{"width":1920,"height":1080,"side_data_list":[{"rotation":-90}]}]}' ;;
  garbage) echo 'this is not json' ;;
  hang) exec sleep 30 ;;
esac
`,
  );
  fs.chmodSync(bin, 0o755);
  return {
    bin,
    log,
    calls: () =>
      fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0,
    env: (mode) => ({
      PATH: process.env.PATH ?? "",
      VIDAI_FFPROBE_BIN: bin,
      FAKE_FFPROBE_MODE: mode,
      FAKE_FFPROBE_LOG: log,
    }),
  };
}

/**
 * A timer set that never fires by itself: tests call `tick()`.
 */
export function fakeTimers() {
  /** @type {Map<number, () => void>} */
  const handles = new Map();
  let next = 1;
  return {
    timers: {
      setInterval(/** @type {() => void} */ fn, /** @type {number} */ _ms) {
        handles.set(next, fn);
        return next++;
      },
      clearInterval(/** @type {unknown} */ handle) {
        handles.delete(/** @type {number} */ (handle));
      },
    },
    active: () => handles.size,
    tick() {
      for (const fn of [...handles.values()]) fn();
    },
  };
}

/** Lets pending promises and I/O callbacks run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * @param {object} [options]
 * @param {string[]} [options.watchedUsers]
 * @param {Parameters<typeof createLibraryModule>[0]["jobsFor"]} [options.jobsFor]
 * @param {Parameters<typeof createLibraryModule>[0]["mediaOptions"]} [options.mediaOptions]
 * @param {Record<string, string | undefined>} [options.env]
 */
export function createLibraryWorld({ jobsFor, mediaOptions, env, watchedUsers } = {}) {
  const world = createWorld();
  /** @type {{ event: string, payload: unknown, userId: string | null, admins: boolean }[]} */
  const libraryEvents = [];
  const events = {
    emit: (/** @type {(typeof libraryEvents)[number]} */ e) => void libraryEvents.push(e),
  };
  const fake = fakeTimers();
  /** @type {string[]} */
  const watching = watchedUsers ?? [];
  const library = createLibraryModule({
    db: world.db,
    channels: world.mod.api.channelsRepo,
    storage: world.mod.api,
    events,
    clock: world.clock,
    log: { info: () => {}, warn: (m) => void world.warnings.push(m), error: () => {} },
    env: env ?? { PATH: "", VIDAI_FFPROBE_BIN: path.join(world.root, "no-such-ffprobe") },
    ...(jobsFor ? { jobsFor } : {}),
    watchers: () => watching,
    timers: fake.timers,
    ...(mediaOptions ? { mediaOptions } : {}),
  });
  const admin = world.users.create({
    email: "admin@example.com",
    passwordHash: "hash",
    role: "admin",
    mayMarkUrgent: true,
  });
  const alice = world.makeUser("alice@example.com");
  const bob = world.makeUser("bob@example.com");

  /**
   * @param {{ id: string, email?: string, role?: string }} user
   */
  function ctxOf(user) {
    return {
      session: {
        id: `s-${user.id}`,
        user: {
          id: user.id,
          email: user.email ?? "user@example.com",
          role: /** @type {"admin" | "user"} */ (user.role ?? "user"),
        },
      },
      address: "127.0.0.1",
      userAgent: "test",
      setSessionCookie: () => {},
    };
  }

  /**
   * Calls a library RPC function as a user.
   * @param {{ id: string, email?: string, role?: string }} user
   * @param {string} name
   * @param {unknown} [input]
   * @returns {Promise<any>} The answer; tests check its shape.
   */
  async function call(user, name, input) {
    const fn = library.rpc.find((candidate) => candidate.name === name);
    if (!fn) throw new Error(`no RPC function ${name}`);
    return fn.handler(input ?? {}, /** @type {never} */ (ctxOf(user)));
  }

  /**
   * A channel of the user with a new folder, and a helper to make video folders in it.
   * @param {{ id: string }} user
   * @param {string} [name]
   */
  async function channelOf(user, name = "Main") {
    const channel = await world.makeChannel(user, name);
    const dir = fs.realpathSync(world.mod.api.channelsRepo.byId(channel.id)?.dir ?? "");
    return {
      channel,
      dir,
      /** @param {string} folder @param {string} [file] @param {string | Buffer} [content] */
      video(folder, file, content = "x") {
        const target = path.join(dir, folder);
        fs.mkdirSync(target, { recursive: true });
        if (file) write(path.join(target, file), content);
        return target;
      },
    };
  }

  return {
    ...world,
    library,
    libraryEvents,
    fake,
    watching,
    admin,
    alice,
    bob,
    ctxOf,
    call,
    channelOf,
    cleanup() {
      library.stop();
      world.cleanup();
    },
  };
}

/**
 * A `jobsFor` that answers from a map the test fills: video key to a partial job.
 * @param {Map<string, unknown>} jobs
 * @returns {(keys: string[]) => Map<string, import("../../../src/lib/wire/jobs.ts").JobView>}
 */
export function fakeJobs(jobs) {
  return (keys) =>
    /** @type {any} */ (
      new Map(keys.flatMap((key) => (jobs.has(key) ? [[key, jobs.get(key)]] : [])))
    );
}

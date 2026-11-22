// Shared set-up of the storage and channel tests: a real temporary data directory, an in-memory
// database, a fake clock, a recording event bus and the whole storage module on top of them. Not a
// test file itself.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { openDatabase } from "../../src/db/open.js";
import { createUsersRepo } from "../../src/db/users.js";
import { createSettingsRepo } from "../../src/db/settings.js";
import { createSettings } from "../../src/settings.js";
import { createLogger } from "../../src/log.js";
import { createStorageModule } from "../../src/storage/index.js";

/** @param {number} [start] */
export function createFakeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    /** @param {number} ms */
    advance(ms) {
      current += ms;
    },
  };
}

/** What the default prompt file of a test world holds. */
export const DEFAULT_PROMPT = "DEFAULT PROMPT TEXT\n";

/** Plenty of free disk space for every test unless it says otherwise. */
export const PLENTY = () => Promise.resolve({ bavail: 1e12, bsize: 4096 });

/**
 * @param {object} [options]
 * @param {string[]} [options.storageRoots] Extra storage folders, as paths relative to the temp root
 *   (they are created).
 * @param {number} [options.maxUploadGb]
 * @param {(channelId: string) => boolean} [options.hasActiveJobs]
 * @param {Record<string, unknown>} [options.uploadOptions]
 * @param {string} [options.platform]
 * @param {string[]} [options.defaultPromptPaths]
 */
export function createWorld({
  storageRoots = [],
  maxUploadGb,
  hasActiveJobs,
  uploadOptions = {},
  platform,
  defaultPromptPaths,
} = {}) {
  // realpath: the system temp directory is itself a link on macOS (/var -> /private/var).
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vidai-storage-")));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const promptFile = path.join(root, "default_prompt.md");
  fs.writeFileSync(promptFile, DEFAULT_PROMPT);
  const clock = createFakeClock();
  const db = openDatabase(":memory:", { clock });
  const users = createUsersRepo(db, { clock });
  const settings = createSettings({ repo: createSettingsRepo(db) });
  const extra = storageRoots.map((relative) => {
    const folder = path.join(root, relative);
    fs.mkdirSync(folder, { recursive: true });
    return folder;
  });
  settings.update({
    storageRoots: extra,
    ...(maxUploadGb === undefined ? {} : { maxUploadGb }),
  });
  /** @type {{ event: string, payload: unknown, userId: string | null, admins: boolean }[]} */
  const emitted = [];
  const events = { emit: (/** @type {(typeof emitted)[number]} */ e) => void emitted.push(e) };
  /** @type {string[]} */
  const warnings = [];
  const log = createLogger({
    file: null,
    console: { write: (line) => void warnings.push(line) },
  });
  const mod = createStorageModule({
    db,
    settings,
    events,
    dataDir,
    clock,
    log,
    ...(hasActiveJobs ? { hasActiveJobs } : {}),
    ...(platform ? { platform } : {}),
    defaultPromptPaths: defaultPromptPaths ?? [promptFile],
    uploadOptions: { statfs: PLENTY, ...uploadOptions },
  });

  /** @param {string} email */
  function makeUser(email) {
    return users.create({ email, passwordHash: "hash", role: "user", mayMarkUrgent: true });
  }

  /** @param {{ id: string, email?: string }} user */
  function ctxFor(user) {
    return {
      session: {
        id: `s-${user.id}`,
        user: { id: user.id, email: user.email ?? "user@example.com", role: "user" },
      },
      address: "127.0.0.1",
      userAgent: "test",
      setSessionCookie: () => {},
    };
  }

  /**
   * Calls a registered RPC function as a user.
   * @param {{ id: string, email?: string }} user
   * @param {string} name
   * @param {unknown} [input]
   * @returns {Promise<any>} What the function answers (the tests check its shape).
   */
  function callRpc(user, name, input) {
    const fn = mod.rpc.find((candidate) => candidate.name === name);
    assert.ok(fn, `no RPC function ${name}`);
    return Promise.resolve(fn.handler(input ?? {}, /** @type {never} */ (ctxFor(user))));
  }

  /**
   * Makes a channel with a new folder in the user's personal folder.
   * @param {{ id: string }} user
   * @param {string} name
   * @param {Partial<import("../../../src/lib/wire/channels.ts").ChannelCreate>} [extra]
   */
  function makeChannel(user, name, extra = {}) {
    return mod.api.channels.create(user, {
      name,
      videoType: "auto",
      location: { kind: "new", parent: null, folderName: null },
      ...extra,
    });
  }

  /**
   * Makes `root`/<relative> (a folder) and returns its full path.
   * @param {string} relative
   */
  function mkdir(relative) {
    const folder = path.join(root, relative);
    fs.mkdirSync(folder, { recursive: true });
    return folder;
  }

  return {
    root,
    dataDir,
    clock,
    db,
    users,
    settings,
    emitted,
    warnings,
    mod,
    makeUser,
    ctxFor,
    callRpc,
    makeChannel,
    mkdir,
    cleanup() {
      mod.stop();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** @typedef {ReturnType<typeof createWorld>} World */

/**
 * A readable body of the given chunks.
 * @param {...(Buffer | string)} chunks
 */
export function bodyOf(...chunks) {
  return Readable.from(
    chunks.map((chunk) => Buffer.from(chunk)),
    { objectMode: false },
  );
}

/**
 * Asserts a promise fails with an `AppError` of the given code.
 * @param {Promise<unknown> | (() => unknown)} subject
 * @param {string} code
 * @returns {Promise<Error & { code: string }>}
 */
export async function rejectsCode(subject, code) {
  /** @type {unknown} */
  let caught = null;
  try {
    await (typeof subject === "function" ? subject() : subject);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, `expected an error with code ${code}, nothing was thrown`);
  assert.equal(/** @type {{ code?: string }} */ (caught).code, code, String(caught));
  return /** @type {Error & { code: string }} */ (caught);
}

/**
 * Every file below `dir` as sorted relative paths, folders with a trailing slash. Links are
 * listed, never followed.
 * @param {string} dir
 * @returns {string[]}
 */
export function treeOf(dir) {
  /** @type {string[]} */
  const result = [];
  /** @param {string} current @param {string} prefix */
  function walk(current, prefix) {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = `${prefix}${item.name}`;
      if (item.isDirectory()) {
        result.push(`${relative}/`);
        walk(path.join(current, item.name), `${relative}/`);
      } else {
        result.push(relative);
      }
    }
  }
  walk(dir, "");
  return result.sort();
}

/**
 * Waits (by yielding to the event loop, never by a fixed sleep) until `check` is true.
 * @param {() => boolean} check
 * @param {number} [timeoutMs]
 */
export async function waitFor(check, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("waitFor: the condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

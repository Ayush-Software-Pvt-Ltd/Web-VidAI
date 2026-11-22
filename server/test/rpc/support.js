// Shared set-up for the RPC tests: an in-memory database, a fake clock, a recording event bus
// and helpers to make accounts and call contexts. Not a test file itself.

import { openDatabase } from "../../src/db/open.js";
import { createUsersRepo } from "../../src/db/users.js";
import { createSessionsRepo } from "../../src/db/sessions.js";
import { createSettingsRepo } from "../../src/db/settings.js";
import { createSessions } from "../../src/auth/sessions.js";
import { createThrottle } from "../../src/auth/throttle.js";
import { createSetup } from "../../src/auth/setup.js";
import { hashPassword } from "../../src/auth/passwords.js";
import { createSettings } from "../../src/settings.js";
import { createSecrets } from "../../src/secrets.js";
import { createRpc } from "../../src/rpc/index.js";

export const PASSWORD = "correct horse battery";
// One real scrypt hash shared by every test account: hashing costs tens of milliseconds each.
const SHARED_HASH = await hashPassword(PASSWORD);

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

/**
 * @param {{ hooks?: Partial<import("../../src/rpc/index.js").Hooks>, version?: string }} [options]
 */
export function createTestApp({ hooks, version = "1.2.3" } = {}) {
  const clock = createFakeClock();
  const db = openDatabase(":memory:", { clock });
  const users = createUsersRepo(db, { clock });
  const sessionsRepo = createSessionsRepo(db);
  const sessions = createSessions({ sessions: sessionsRepo, users, clock });
  const settings = createSettings({ repo: createSettingsRepo(db) });
  const secrets = createSecrets({ db, keyFile: "unused", memory: true });
  const throttle = createThrottle({ clock });
  /** @type {string[]} */
  const infoLog = [];
  const setup = createSetup({ users, log: { info: (m) => infoLog.push(m), warn: () => {} } });
  /** @type {{ event: string, payload: unknown, userId: string | null, admins: boolean }[]} */
  const emitted = [];
  /** @type {string[]} */
  const closed = [];
  const events = {
    emit: (/** @type {(typeof emitted)[number]} */ e) => void emitted.push(e),
    closeUser: (/** @type {string} */ id) => void closed.push(id),
  };
  const rpc = createRpc({
    db,
    users,
    sessions,
    settings,
    secrets,
    throttle,
    setup,
    events,
    clock,
    version,
    hooks,
  });

  /**
   * Makes an account directly (no RPC) with the shared password.
   * @param {string} email
   * @param {{ role?: "admin" | "user", disabled?: boolean, mayMarkUrgent?: boolean }} [options]
   */
  function makeUser(email, { role = "user", disabled = false, mayMarkUrgent = true } = {}) {
    const user = users.create({ email, passwordHash: SHARED_HASH, role, mayMarkUrgent });
    if (disabled) users.update(user.id, { disabled: true });
    return users.byId(user.id) ?? user;
  }

  /**
   * A context as the HTTP layer builds it: signed in as `user` (a fresh session) or signed out.
   * @param {{ id: string } | null} [user]
   * @param {string} [address]
   */
  function contextFor(user = null, address = "10.0.0.1") {
    /** @type {(string | null)[]} */
    const cookies = [];
    const meta = { address, userAgent: "test-agent" };
    let session = null;
    if (user) {
      const { token } = sessions.create(user.id, meta);
      session = sessions.authenticate(token, meta);
    }
    return {
      ...meta,
      session,
      cookies,
      setSessionCookie: (/** @type {string | null} */ token) => void cookies.push(token),
    };
  }

  return {
    clock,
    db,
    users,
    sessions,
    sessionsRepo,
    settings,
    secrets,
    throttle,
    setup,
    rpc,
    emitted,
    closed,
    infoLog,
    makeUser,
    contextFor,
    /** @param {string} name @param {unknown} input @param {ReturnType<typeof contextFor>} ctx */
    call: (name, input, ctx) => rpc.call(name, input, ctx),
  };
}

/**
 * Asserts a promise rejects with an AppError of this code.
 * @param {Promise<unknown>} promise
 * @param {string} code
 * @param {RegExp} [message]
 */
export async function rejectsWith(promise, code, message) {
  const { rejects } = await import("node:assert/strict");
  await rejects(promise, (error) => {
    const e = /** @type {{ code?: string, message?: string }} */ (error);
    if (e.code !== code) throw new Error(`Expected code ${code}, got ${e.code}: ${e.message}`);
    if (message && !message.test(e.message ?? "")) {
      throw new Error(`Message "${e.message}" does not match ${message}`);
    }
    return true;
  });
}

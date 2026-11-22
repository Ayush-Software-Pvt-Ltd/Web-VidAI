// The first admin (docs/SPEC.md section 2, "First admin") and the admin password reset.
//
// With no enabled admin the server either creates one from `VIDAI_ADMIN_EMAIL` and
// `VIDAI_ADMIN_PASSWORD`, or prints a one-time setup address whose token lives only in memory.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { forbidden, notFound } from "../errors.js";
import { hashPassword, validateEmail, validatePassword } from "./passwords.js";

/** @typedef {{ info(message: string): void, warn(message: string): void }} SetupLog */

const TOKEN_REFUSED = "This setup address is no longer valid.";

/** @param {string} value */
const digest = (value) => createHash("sha256").update(value).digest();

/**
 * @param {{
 *   users: ReturnType<typeof import("../db/users.js").createUsersRepo>,
 *   log?: SetupLog,
 * }} deps
 */
export function createSetup({ users, log }) {
  /** @type {string | null} */
  let token = null;
  // True while a setup request is hashing, so two requests with the token cannot both win.
  let busy = false;

  const needsSetup = () => users.countEnabledAdmins() === 0;

  return {
    needsSetup,

    /**
     * Run once on start. Creates the admin from the environment when one is given, otherwise
     * makes the one-time setup token (the caller prints the address). Nothing happens when an
     * enabled admin already exists.
     * @param {{ env: Record<string, string | undefined> }} input
     * @returns {Promise<{ created: boolean, setupToken: string | null }>}
     */
    async ensureFirstAdmin({ env }) {
      if (!needsSetup()) {
        token = null;
        return { created: false, setupToken: null };
      }
      const email = env.VIDAI_ADMIN_EMAIL?.trim();
      const password = env.VIDAI_ADMIN_PASSWORD;
      if (email && password) {
        const normalised = validateEmail(email);
        const hash = await hashPassword(validatePassword(password));
        users.create({ email: normalised, passwordHash: hash, role: "admin", mayMarkUrgent: true });
        // The password is deliberately not part of the message (SPEC section 2).
        log?.info(`Created the admin account ${normalised} from the environment.`);
        return { created: true, setupToken: null };
      }
      token = randomBytes(32).toString("base64url");
      return { created: false, setupToken: token };
    },

    /** The token to print, or null when none is open. */
    get setupToken() {
      return token;
    },

    /**
     * Creates the first admin; valid once and only while no enabled admin exists.
     * @param {unknown} givenToken
     * @param {unknown} email
     * @param {unknown} password
     * @returns {Promise<import("../db/users.js").UserRecord>}
     */
    async setupAdmin(givenToken, email, password) {
      const normalised = validateEmail(email);
      const valid = validatePassword(password);
      if (token === null || busy || !needsSetup()) throw forbidden(TOKEN_REFUSED);
      if (typeof givenToken !== "string" || !timingSafeEqual(digest(givenToken), digest(token))) {
        throw forbidden(TOKEN_REFUSED);
      }
      busy = true;
      try {
        const hash = await hashPassword(valid);
        // The check and the insert are one synchronous step, so no other admin can slip in.
        if (!needsSetup()) throw forbidden(TOKEN_REFUSED);
        const created = users.create({
          email: normalised,
          passwordHash: hash,
          role: "admin",
          mayMarkUrgent: true,
        });
        token = null;
        log?.info(`Created the admin account ${normalised} from the setup page.`);
        return created;
      } finally {
        busy = false;
      }
    },
  };
}

/**
 * `admin-reset` (SPEC section 2): sets a new password for an admin who is locked out and ends
 * all of that account's sessions. The terminal prompt that asks for the password is written by
 * whoever writes `main.js`.
 * @param {{
 *   users: ReturnType<typeof import("../db/users.js").createUsersRepo>,
 *   sessions: ReturnType<typeof import("./sessions.js").createSessions>,
 *   email: string,
 *   password: string,
 * }} input
 * @returns {Promise<import("../db/users.js").UserRecord>}
 */
export async function resetAdminPassword({ users, sessions, email, password }) {
  const normalised = validateEmail(email);
  const valid = validatePassword(password);
  const user = users.byEmail(normalised);
  if (!user || user.role !== "admin") throw notFound("There is no admin account with this email.");
  const hash = await hashPassword(valid);
  const updated = users.update(user.id, { passwordHash: hash });
  if (!updated) throw notFound("There is no admin account with this email.");
  sessions.endAllOfUser(user.id);
  return updated;
}

// Sessions (docs/SPEC.md section 4): 32 random bytes in the cookie, only their SHA-256 stored,
// ended after 30 days without use or at Sign out.

import { createHash, randomBytes } from "node:crypto";

export const IDLE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
// Writing on every request would make each page load a database write.
export const TOUCH_INTERVAL_MS = 60 * 1000;

/** @typedef {import("../rpc/context.js").Session} Session */

/** @param {string} token */
const hashToken = (token) => createHash("sha256").update(token).digest("hex");

/**
 * @param {{
 *   sessions: ReturnType<typeof import("../db/sessions.js").createSessionsRepo>,
 *   users: ReturnType<typeof import("../db/users.js").createUsersRepo>,
 *   clock: import("../db/open.js").Clock,
 * }} deps
 */
export function createSessions({ sessions, users, clock }) {
  return {
    /**
     * Starts a session for an account that has just proven who it is.
     * @param {string} userId
     * @param {{ address: string, userAgent: string }} meta
     * @returns {{ id: string, token: string }} The token goes into the cookie and nowhere else.
     */
    create(userId, meta) {
      const token = randomBytes(32).toString("base64url");
      const id = randomBytes(16).toString("hex");
      const now = clock.now();
      sessions.insert({
        id,
        tokenHash: hashToken(token),
        userId,
        now,
        address: meta.address,
        userAgent: meta.userAgent,
      });
      users.touchSeen(userId, now);
      return { id, token };
    },

    /**
     * The session a cookie token stands for, or null (unknown, idle for 30 days, account
     * disabled or deleted). Synchronous: the HTTP layer calls it on every request.
     * @param {string} token
     * @param {{ address: string, userAgent: string }} meta
     * @returns {Session | null}
     */
    authenticate(token, meta) {
      // The cookie is ours, so anything that is not a plausible token is not worth a query.
      if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
      const found = sessions.byTokenHash(hashToken(token));
      if (!found) return null;
      const now = clock.now();
      if (now - found.lastUsedAt > IDLE_EXPIRY_MS) {
        sessions.delete(found.id);
        return null;
      }
      if (found.user.disabled) return null;
      if (now - found.lastUsedAt >= TOUCH_INTERVAL_MS) {
        sessions.touch(found.id, now, meta.address, meta.userAgent);
        users.touchSeen(found.user.id, now);
      }
      return {
        id: found.id,
        user: { id: found.user.id, email: found.user.email, role: found.user.role },
      };
    },

    /** @param {string} id @returns {boolean} */
    end(id) {
      return sessions.delete(id);
    },

    /**
     * Ends every session of an account, optionally keeping one.
     * @param {string} userId
     * @param {string | null} [exceptId]
     * @returns {number} How many ended.
     */
    endAllOfUser(userId, exceptId = null) {
      return sessions.deleteByUser(userId, exceptId);
    },

    /** @param {string} userId */
    countOfUser(userId) {
      return sessions.countByUser(userId);
    },

    /** Deletes sessions idle for more than 30 days. @returns {number} */
    purgeExpired() {
      return sessions.deleteIdleBefore(clock.now() - IDLE_EXPIRY_MS);
    },
  };
}

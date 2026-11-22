// The `sessions` table (docs/SPEC.md sections 4 and 15). Only the SHA-256 of the cookie token is
// stored; `id` is a separate random id that is safe to hand around.

/**
 * @typedef {object} SessionRecord
 * @property {string} id
 * @property {string} userId
 * @property {number} createdAt
 * @property {number} lastUsedAt
 * @property {string} address
 * @property {string} userAgent
 */

/**
 * A session with the account it belongs to, as the authentication needs it.
 * @typedef {object} SessionWithUser
 * @property {string} id
 * @property {number} lastUsedAt
 * @property {{ id: string, email: string, role: "admin" | "user", disabled: boolean }} user
 */

/** @param {import("./open.js").Database} db */
export function createSessionsRepo(db) {
  return {
    /** @param {{ id: string, tokenHash: string, userId: string, now: number, address: string, userAgent: string }} input */
    insert({ id, tokenHash, userId, now, address, userAgent }) {
      db.run(
        `INSERT INTO sessions (id, token_hash, user_id, created_at, last_used_at, address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        tokenHash,
        userId,
        now,
        now,
        address,
        userAgent,
      );
    },

    /**
     * @param {string} tokenHash
     * @returns {SessionWithUser | null}
     */
    byTokenHash(tokenHash) {
      const row = db.get(
        `SELECT s.id, s.last_used_at, u.id AS user_id, u.email, u.role, u.disabled
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?`,
        tokenHash,
      );
      if (!row) return null;
      return {
        id: String(row.id),
        lastUsedAt: Number(row.last_used_at),
        user: {
          id: String(row.user_id),
          email: String(row.email),
          role: row.role === "admin" ? "admin" : "user",
          disabled: row.disabled === 1,
        },
      };
    },

    /** @param {string} userId @returns {SessionRecord[]} */
    listByUser(userId) {
      return db
        .all(
          `SELECT id, user_id, created_at, last_used_at, address, user_agent
             FROM sessions WHERE user_id = ? ORDER BY created_at`,
          userId,
        )
        .map((row) => ({
          id: String(row.id),
          userId: String(row.user_id),
          createdAt: Number(row.created_at),
          lastUsedAt: Number(row.last_used_at),
          address: String(row.address),
          userAgent: String(row.user_agent),
        }));
    },

    /** @param {string} id @param {number} at @param {string} address @param {string} userAgent */
    touch(id, at, address, userAgent) {
      db.run(
        "UPDATE sessions SET last_used_at = ?, address = ?, user_agent = ? WHERE id = ?",
        at,
        address,
        userAgent,
        id,
      );
    },

    /** @param {string} id @returns {boolean} */
    delete(id) {
      return db.run("DELETE FROM sessions WHERE id = ?", id).changes > 0;
    },

    /**
     * @param {string} userId
     * @param {string | null} exceptId A session that stays.
     * @returns {number} How many ended.
     */
    deleteByUser(userId, exceptId) {
      return exceptId === null
        ? db.run("DELETE FROM sessions WHERE user_id = ?", userId).changes
        : db.run("DELETE FROM sessions WHERE user_id = ? AND id <> ?", userId, exceptId).changes;
    },

    /** @param {string} userId */
    countByUser(userId) {
      const row = db.get("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", userId);
      return Number(row?.n ?? 0);
    },

    /**
     * @param {number} cutoff Sessions last used before this time end.
     * @returns {number}
     */
    deleteIdleBefore(cutoff) {
      return db.run("DELETE FROM sessions WHERE last_used_at < ?", cutoff).changes;
    },
  };
}

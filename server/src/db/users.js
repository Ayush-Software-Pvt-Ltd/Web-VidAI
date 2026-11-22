// The `users` table (docs/SPEC.md sections 4 and 15). Plain data in, plain camelCase objects out;
// the rules (last admin, sessions, hooks) live in `rpc/adminUsers.js`.

import { randomBytes } from "node:crypto";
import { conflict } from "../errors.js";
import { systemClock } from "./open.js";

/**
 * @typedef {object} UserRecord
 * @property {string} id
 * @property {string} email Already normalised (trimmed, lower-case).
 * @property {string} passwordHash
 * @property {"admin" | "user"} role
 * @property {boolean} disabled
 * @property {boolean} mayMarkUrgent
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number | null} lastSeenAt
 */

const COLUMNS =
  "id, email, password_hash, role, disabled, may_mark_urgent, created_at, updated_at, last_seen_at";

/**
 * @param {import("./open.js").Row} row
 * @returns {UserRecord}
 */
function toUser(row) {
  return {
    id: String(row.id),
    email: String(row.email),
    passwordHash: String(row.password_hash),
    role: row.role === "admin" ? "admin" : "user",
    disabled: row.disabled === 1,
    mayMarkUrgent: row.may_mark_urgent === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
  };
}

/** @param {unknown} error */
function isEmailTaken(error) {
  return error instanceof Error && /UNIQUE constraint failed: users\.email/.test(error.message);
}

const EMAIL_TAKEN = "An account with this email already exists.";

/**
 * @param {import("./open.js").Database} db
 * @param {{ clock?: import("./open.js").Clock }} [options]
 */
export function createUsersRepo(db, { clock = systemClock } = {}) {
  return {
    /**
     * @param {{ email: string, passwordHash: string, role: "admin" | "user", mayMarkUrgent: boolean }} input
     * @returns {UserRecord}
     */
    create({ email, passwordHash, role, mayMarkUrgent }) {
      const id = randomBytes(16).toString("hex");
      const now = clock.now();
      try {
        db.run(
          `INSERT INTO users (id, email, password_hash, role, disabled, may_mark_urgent, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
          id,
          email,
          passwordHash,
          role,
          mayMarkUrgent ? 1 : 0,
          now,
          now,
        );
      } catch (error) {
        if (isEmailTaken(error)) throw conflict(EMAIL_TAKEN, "email");
        throw error;
      }
      const created = this.byId(id);
      if (!created) throw new Error("The new account could not be read back.");
      return created;
    },

    /** @param {string} id @returns {UserRecord | null} */
    byId(id) {
      const row = db.get(`SELECT ${COLUMNS} FROM users WHERE id = ?`, id);
      return row ? toUser(row) : null;
    },

    /** @param {string} email Normalised. @returns {UserRecord | null} */
    byEmail(email) {
      const row = db.get(`SELECT ${COLUMNS} FROM users WHERE email = ?`, email);
      return row ? toUser(row) : null;
    },

    /** Every account, ordered by email. @returns {UserRecord[]} */
    list() {
      return db.all(`SELECT ${COLUMNS} FROM users ORDER BY email`).map(toUser);
    },

    /**
     * Changes the given fields only.
     * @param {string} id
     * @param {{ email?: string, passwordHash?: string, role?: "admin" | "user", disabled?: boolean, mayMarkUrgent?: boolean }} patch
     * @returns {UserRecord | null} The updated account, or null when it does not exist.
     */
    update(id, patch) {
      /** @type {string[]} */
      const sets = [];
      /** @type {import("./open.js").SqlValue[]} */
      const values = [];
      if (patch.email !== undefined) {
        sets.push("email = ?");
        values.push(patch.email);
      }
      if (patch.passwordHash !== undefined) {
        sets.push("password_hash = ?");
        values.push(patch.passwordHash);
      }
      if (patch.role !== undefined) {
        sets.push("role = ?");
        values.push(patch.role);
      }
      if (patch.disabled !== undefined) {
        sets.push("disabled = ?");
        values.push(patch.disabled ? 1 : 0);
      }
      if (patch.mayMarkUrgent !== undefined) {
        sets.push("may_mark_urgent = ?");
        values.push(patch.mayMarkUrgent ? 1 : 0);
      }
      sets.push("updated_at = ?");
      values.push(clock.now());
      try {
        const result = db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, ...values, id);
        if (result.changes === 0) return null;
      } catch (error) {
        if (isEmailTaken(error)) throw conflict(EMAIL_TAKEN, "email");
        throw error;
      }
      return this.byId(id);
    },

    /**
     * Deletes the account; sessions, channels, uploads, notes and jobs follow by cascade.
     * @param {string} id
     * @returns {boolean}
     */
    delete(id) {
      return db.run("DELETE FROM users WHERE id = ?", id).changes > 0;
    },

    /** Enabled admins; zero means the first-admin setup is offered (SPEC section 2). */
    countEnabledAdmins() {
      const row = db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0");
      return Number(row?.n ?? 0);
    },

    /**
     * @param {string} id
     * @param {number} at
     */
    touchSeen(id, at) {
      db.run("UPDATE users SET last_seen_at = ? WHERE id = ?", at, id);
    },
  };
}

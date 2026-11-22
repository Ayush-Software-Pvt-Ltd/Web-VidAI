// The `edit_log` table (docs/SPEC.md sections 15 and 16): what happened to each video. Plain data in,
// plain camelCase objects out; the rules (who may read what, event names, labels) are in
// `editLog.js` and `rpc/editLog.js`.
//
// The row keeps the user's email and a label of the video as text, so it stays readable after the
// user, the channel or the video is gone; the table empties `user_id` itself when the user is
// deleted (`ON DELETE SET NULL`).

/** @typedef {import("../../../src/lib/wire/editLog.ts").EditLogEntry} EditLogEntry */

const COLUMNS = "id, at, user_id, user_email, video_label, event, message";

/**
 * @param {import("./open.js").Row} row
 * @returns {EditLogEntry}
 */
function toEntry(row) {
  return {
    id: Number(row.id),
    at: Number(row.at),
    userId: row.user_id === null ? null : String(row.user_id),
    userEmail: String(row.user_email),
    videoLabel: String(row.video_label),
    event: String(row.event),
    message: String(row.message),
  };
}

/**
 * @param {import("./open.js").Database} db
 */
export function createEditLogRepo(db) {
  return {
    /**
     * Adds a row and deletes the older ones beyond the newest `keep`, in one transaction.
     * Ids only grow (AUTOINCREMENT) and only this function deletes rows, so the newest `keep`
     * rows are exactly those with an id above `newest - keep`.
     * @param {{
     *   at: number, userId: string | null, userEmail: string, videoLabel: string,
     *   event: string, message: string,
     * }} row
     * @param {number} keep At least 1.
     * @returns {number} The id of the new row.
     */
    insert({ at, userId, userEmail, videoLabel, event, message }, keep) {
      return db.transaction(() => {
        const { lastInsertRowid } = db.run(
          `INSERT INTO edit_log (at, user_id, user_email, video_label, event, message)
           VALUES (?, ?, ?, ?, ?, ?)`,
          at,
          userId,
          userEmail,
          videoLabel,
          event,
          message,
        );
        const id = Number(lastInsertRowid);
        db.run("DELETE FROM edit_log WHERE id <= ?", id - keep);
        return id;
      });
    },

    /**
     * One page, newest first: `limit` rows plus one more to tell whether there are older ones.
     * @param {{ userId: string | null, before: number | null, limit: number }} query `userId`
     *   null: every row, including those of deleted users.
     * @returns {{ entries: EditLogEntry[], more: boolean }}
     */
    page({ userId, before, limit }) {
      /** @type {string[]} */
      const where = [];
      /** @type {(string | number)[]} */
      const params = [];
      if (userId !== null) {
        where.push("user_id = ?");
        params.push(userId);
      }
      if (before !== null) {
        where.push("id < ?");
        params.push(before);
      }
      const rows = db.all(
        `SELECT ${COLUMNS} FROM edit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY id DESC LIMIT ?`,
        ...params,
        limit + 1,
      );
      return { entries: rows.slice(0, limit).map(toEntry), more: rows.length > limit };
    },

    /** The number of rows (tests and the System page). @returns {number} */
    count() {
      return Number(db.get("SELECT COUNT(*) AS n FROM edit_log")?.n ?? 0);
    },
  };
}

/** @typedef {ReturnType<typeof createEditLogRepo>} EditLogRepo */

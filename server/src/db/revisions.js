// The `revisions` table (docs/SPEC.md sections 11 and 15): one row per saved state of a video's
// project; the files themselves are in `<data dir>/projects/<videoKey>/revisions/<n>/`.
//
// Rules kept here:
// - `n` of a video grows by one per row and is never reused: a new row gets one more than the
//   highest `n` present, undone rows included, and only then are the undone rows dropped.
// - `undone` rows are always the highest numbers of a video (undo marks the newest not-undone
//   row, redo unmarks the lowest undone one); the "current" revision is the newest not-undone one.

import { systemClock } from "./open.js";

/**
 * @typedef {object} RevisionRecord
 * @property {string} videoKey
 * @property {number} n
 * @property {string} label
 * @property {string | null} userId `null` for a job, a change outside VidAI, or a removed user.
 * @property {string | null} jobId `null` for a hand edit.
 * @property {number} createdAt
 * @property {boolean} undone
 */

const COLUMNS = "video_id, n, label, user_id, job_id, created_at, undone";

/**
 * @param {import("./open.js").Row} row
 * @returns {RevisionRecord}
 */
function toRevision(row) {
  return {
    videoKey: String(row.video_id),
    n: Number(row.n),
    label: String(row.label),
    userId: row.user_id === null ? null : String(row.user_id),
    jobId: row.job_id === null ? null : String(row.job_id),
    createdAt: Number(row.created_at),
    undone: row.undone === 1,
  };
}

/**
 * @param {import("./open.js").Database} db
 * @param {{ clock?: import("./open.js").Clock }} [options]
 */
export function createRevisionsRepo(db, { clock = systemClock } = {}) {
  return {
    /**
     * Every revision of the video, oldest first.
     * @param {string} videoKey
     * @returns {RevisionRecord[]}
     */
    list(videoKey) {
      return db
        .all(`SELECT ${COLUMNS} FROM revisions WHERE video_id = ? ORDER BY n`, videoKey)
        .map(toRevision);
    },

    /**
     * @param {string} videoKey
     * @param {number} n
     * @returns {RevisionRecord | undefined}
     */
    get(videoKey, n) {
      const row = db.get(
        `SELECT ${COLUMNS} FROM revisions WHERE video_id = ? AND n = ?`,
        videoKey,
        n,
      );
      return row && toRevision(row);
    },

    /**
     * The revision the project is at: the highest `n` that is not undone.
     * @param {string} videoKey
     * @returns {RevisionRecord | undefined}
     */
    current(videoKey) {
      const row = db.get(
        `SELECT ${COLUMNS} FROM revisions WHERE video_id = ? AND undone = 0 ORDER BY n DESC LIMIT 1`,
        videoKey,
      );
      return row && toRevision(row);
    },

    /**
     * The row just before `n` (undone or not), the state an undo of `n` goes back to.
     * @param {string} videoKey
     * @param {number} n
     * @returns {RevisionRecord | undefined}
     */
    before(videoKey, n) {
      const row = db.get(
        `SELECT ${COLUMNS} FROM revisions WHERE video_id = ? AND n < ? ORDER BY n DESC LIMIT 1`,
        videoKey,
        n,
      );
      return row && toRevision(row);
    },

    /**
     * The undone row a redo brings back: the lowest `n` among the undone ones.
     * @param {string} videoKey
     * @returns {RevisionRecord | undefined}
     */
    nextUndone(videoKey) {
      const row = db.get(
        `SELECT ${COLUMNS} FROM revisions WHERE video_id = ? AND undone = 1 ORDER BY n LIMIT 1`,
        videoKey,
      );
      return row && toRevision(row);
    },

    /**
     * Adds the next revision and drops every undone row (their numbers are not reused: the new one
     * is above them). One transaction.
     * @param {{ videoKey: string, label: string, userId: string | null, jobId: string | null }} input
     * @returns {{ revision: RevisionRecord, dropped: number[] }} `dropped`: numbers whose folders must go.
     */
    insert({ videoKey, label, userId, jobId }) {
      return db.transaction(() => {
        const top = db.get("SELECT MAX(n) AS n FROM revisions WHERE video_id = ?", videoKey);
        const n = (top && top.n !== null ? Number(top.n) : 0) + 1;
        const dropped = db
          .all("SELECT n FROM revisions WHERE video_id = ? AND undone = 1 ORDER BY n", videoKey)
          .map((row) => Number(row.n));
        db.run("DELETE FROM revisions WHERE video_id = ? AND undone = 1", videoKey);
        const createdAt = clock.now();
        db.run(
          "INSERT INTO revisions (video_id, n, label, user_id, job_id, created_at, undone) VALUES (?, ?, ?, ?, ?, ?, 0)",
          videoKey,
          n,
          label,
          userId,
          jobId,
          createdAt,
        );
        return {
          revision: { videoKey, n, label, userId, jobId, createdAt, undone: false },
          dropped,
        };
      });
    },

    /**
     * @param {string} videoKey
     * @param {number} n
     * @param {boolean} undone
     */
    setUndone(videoKey, n, undone) {
      db.run(
        "UPDATE revisions SET undone = ? WHERE video_id = ? AND n = ?",
        undone ? 1 : 0,
        videoKey,
        n,
      );
    },

    /**
     * Removes one row (a revision whose files could not be written).
     * @param {string} videoKey
     * @param {number} n
     */
    remove(videoKey, n) {
      db.run("DELETE FROM revisions WHERE video_id = ? AND n = ?", videoKey, n);
    },

    /**
     * Keeps at most `keep` rows by removing the oldest ones, never a row at or above `protectFrom`
     * (the current revision and the undone ones above it).
     * @param {string} videoKey
     * @param {number} keep
     * @param {number} protectFrom
     * @returns {number[]} The removed numbers.
     */
    pruneOldest(videoKey, keep, protectFrom) {
      return db.transaction(() => {
        const total = Number(
          db.get("SELECT COUNT(*) AS c FROM revisions WHERE video_id = ?", videoKey)?.c ?? 0,
        );
        const surplus = total - keep;
        if (surplus <= 0) return [];
        const victims = db
          .all(
            "SELECT n FROM revisions WHERE video_id = ? AND n < ? ORDER BY n LIMIT ?",
            videoKey,
            protectFrom,
            surplus,
          )
          .map((row) => Number(row.n));
        for (const n of victims) {
          db.run("DELETE FROM revisions WHERE video_id = ? AND n = ?", videoKey, n);
        }
        return victims;
      });
    },

    /** @param {string} videoKey */
    removeAll(videoKey) {
      db.run("DELETE FROM revisions WHERE video_id = ?", videoKey);
    },
  };
}

/** @typedef {ReturnType<typeof createRevisionsRepo>} RevisionsRepo */

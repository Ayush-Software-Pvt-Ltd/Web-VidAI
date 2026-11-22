// The `progress_history` table (docs/SPEC.md section 15): how long completed jobs took, per kind
// and video type, so the progress estimate learns the typical time of this server. Only the newest
// rows the estimate looks at are kept (docs/SPEC-desktop.md section 6, "Progress": the last 10
// completed jobs of a kind and type, the median once at least 3 of them have a time).

import { HISTORY_RUNS } from "../jobs/progressPacing.js";

/**
 * @param {import("./open.js").Database} db
 * @param {{ keep?: number }} [options] How many of the newest rows of a kind and video type are
 *   kept (default `HISTORY_RUNS`, what the estimate looks at).
 * @returns {import("../jobs/progressPacing.js").ProgressHistory}
 */
export function createProgressHistory(db, { keep = HISTORY_RUNS } = {}) {
  return {
    /**
     * The newest rows of a kind and video type, newest first.
     * @param {string} kind
     * @param {string} videoType
     * @param {number} limit
     * @returns {import("../jobs/progressPacing.js").HistoryRow[]}
     */
    recent(kind, videoType, limit) {
      return db
        .all(
          `SELECT kind, video_type, seconds, finished_at FROM progress_history
           WHERE kind = ? AND video_type = ?
           ORDER BY finished_at DESC, rowid DESC LIMIT ?`,
          kind,
          videoType,
          Math.max(Math.floor(limit), 0),
        )
        .map((row) => ({
          kind: /** @type {import("../jobs/progressModels.js").JobKind} */ (String(row.kind)),
          videoType: /** @type {import("../jobs/progressModels.js").VideoType} */ (
            String(row.video_type)
          ),
          seconds: Number(row.seconds),
          finishedAt: Number(row.finished_at),
        }));
    },

    /**
     * Adds a completed job and drops the rows of its kind and type that are older than the newest
     * `keep`.
     * @param {import("../jobs/progressPacing.js").HistoryRow} row
     */
    add(row) {
      db.transaction(() => {
        db.run(
          "INSERT INTO progress_history (kind, video_type, seconds, finished_at) VALUES (?, ?, ?, ?)",
          row.kind,
          row.videoType,
          Math.max(row.seconds, 0),
          Math.round(row.finishedAt),
        );
        db.run(
          `DELETE FROM progress_history
           WHERE kind = ? AND video_type = ? AND rowid NOT IN (
             SELECT rowid FROM progress_history WHERE kind = ? AND video_type = ?
             ORDER BY finished_at DESC, rowid DESC LIMIT ?
           )`,
          row.kind,
          row.videoType,
          row.kind,
          row.videoType,
          keep,
        );
      });
    },
  };
}

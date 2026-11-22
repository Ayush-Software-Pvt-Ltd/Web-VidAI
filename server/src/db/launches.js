// The `launches` table (docs/SPEC.md sections 8 and 15): when new sessions were last launched in a
// queue, so the start delay holds across a restart. Only the newest rows are kept.

/** Rows kept per queue; only the newest one matters, a few more help when reading the table. */
export const KEEP_LAUNCHES = 100;

/** @param {import("./open.js").Database} db */
export function createLaunchesRepo(db) {
  return {
    /**
     * Notes a launch and drops all but the newest 100 of that queue.
     * @param {import("../../../src/lib/wire/jobs.ts").JobQueue} queue
     * @param {number} at Milliseconds since 1970.
     */
    record(queue, at) {
      db.transaction(() => {
        db.run("INSERT INTO launches (queue, at) VALUES (?, ?)", queue, at);
        db.run(
          `DELETE FROM launches WHERE queue = ? AND rowid NOT IN (
             SELECT rowid FROM launches WHERE queue = ? ORDER BY at DESC, rowid DESC LIMIT ?)`,
          queue,
          queue,
          KEEP_LAUNCHES,
        );
      });
    },

    /**
     * The time of the most recent launch.
     * @param {import("../../../src/lib/wire/jobs.ts").JobQueue} queue
     * @returns {number | null}
     */
    last(queue) {
      const row = db.get("SELECT MAX(at) AS at FROM launches WHERE queue = ?", queue);
      return row && row.at !== null ? Number(row.at) : null;
    },

    /** @param {import("../../../src/lib/wire/jobs.ts").JobQueue} queue @returns {number} */
    count(queue) {
      return Number(db.get("SELECT COUNT(*) AS n FROM launches WHERE queue = ?", queue)?.n ?? 0);
    },
  };
}

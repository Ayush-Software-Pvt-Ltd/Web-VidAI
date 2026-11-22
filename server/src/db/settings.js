// The `settings` table (docs/SPEC.md sections 5 and 15): one row per admin setting, the value
// stored as JSON. Validation and defaults are in `settings.js` one level up.

/** @param {import("./open.js").Database} db */
export function createSettingsRepo(db) {
  return {
    /** Every stored row. Values that are not valid JSON are skipped. @returns {Record<string, unknown>} */
    all() {
      /** @type {Record<string, unknown>} */
      const result = {};
      for (const row of db.all("SELECT key, value FROM settings")) {
        try {
          result[String(row.key)] = JSON.parse(String(row.value));
        } catch {
          // The CHECK constraint makes this unreachable; skipping keeps one bad row from hiding the rest.
        }
      }
      return result;
    },

    /** @param {string} key @returns {unknown} undefined when the key was never stored. */
    get(key) {
      const row = db.get("SELECT value FROM settings WHERE key = ?", key);
      return row ? JSON.parse(String(row.value)) : undefined;
    },

    /** @param {string} key @param {unknown} value */
    set(key, value) {
      db.run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        key,
        JSON.stringify(value),
      );
    },

    /** Writes several keys in one transaction. @param {Record<string, unknown>} values */
    setMany(values) {
      db.transaction(() => {
        for (const [key, value] of Object.entries(values)) this.set(key, value);
      });
    },

    /** @param {string} key */
    delete(key) {
      db.run("DELETE FROM settings WHERE key = ?", key);
    },
  };
}

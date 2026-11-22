// The `secrets` table (docs/SPEC.md sections 5 and 15): encrypted values plus their last 4
// characters. Encryption is in `secrets.js` one level up; this module only stores bytes.

/**
 * @typedef {object} SecretRow
 * @property {Uint8Array} nonce
 * @property {Uint8Array} cipher
 * @property {string} last4
 */

/** @param {import("./open.js").Database} db */
export function createSecretsRepo(db) {
  return {
    /** @param {string} name @returns {SecretRow | null} */
    get(name) {
      const row = db.get("SELECT nonce, cipher, last4 FROM secrets WHERE name = ?", name);
      if (!row) return null;
      return {
        nonce: /** @type {Uint8Array} */ (row.nonce),
        cipher: /** @type {Uint8Array} */ (row.cipher),
        last4: String(row.last4),
      };
    },

    /** @param {string} name @param {SecretRow} row */
    set(name, { nonce, cipher, last4 }) {
      db.run(
        `INSERT INTO secrets (name, nonce, cipher, last4) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET nonce = excluded.nonce, cipher = excluded.cipher, last4 = excluded.last4`,
        name,
        nonce,
        cipher,
        last4,
      );
    },

    /** @param {string} name */
    delete(name) {
      db.run("DELETE FROM secrets WHERE name = ?", name);
    },
  };
}

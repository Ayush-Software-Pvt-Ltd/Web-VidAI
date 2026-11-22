// Numbered schema migrations (docs/SPEC.md section 3): `migrations/NNN-name.sql`, applied in
// order, each inside its own transaction and recorded in `schema_migrations`.

import { readdirSync, readFileSync } from "node:fs";

const DEFAULT_DIR = new URL("./migrations/", import.meta.url);
const FILE_PATTERN = /^(\d{3,})-([a-z0-9-]+)\.sql$/;

/**
 * @typedef {object} Migration
 * @property {number} version
 * @property {string} name
 * @property {string} sql
 */

/**
 * The migrations in `dir`, in order. Versions must be 1, 2, 3 ... without gaps or repeats.
 * @param {URL} [dir]
 * @returns {Migration[]}
 */
export function loadMigrations(dir = DEFAULT_DIR) {
  /** @type {Migration[]} */
  const found = [];
  for (const file of readdirSync(dir)) {
    const match = FILE_PATTERN.exec(file);
    if (!match) continue;
    const sql = readFileSync(new URL(file, dir), "utf8");
    found.push({ version: Number(match[1]), name: match[2] ?? file, sql });
  }
  found.sort((a, b) => a.version - b.version);
  found.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migration numbers must be 1, 2, 3 ... without gaps; found ${migration.version} at position ${index + 1}.`,
      );
    }
  });
  return found;
}

/**
 * Applies every migration the database has not seen yet. A database made by a newer server
 * (a recorded version this code does not know) is refused rather than guessed at.
 * @param {import("./open.js").Database} db
 * @param {{ clock: import("./open.js").Clock, dir?: URL }} options
 * @returns {number} How many migrations were applied.
 */
export function migrate(db, { clock, dir }) {
  const migrations = loadMigrations(dir);
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at INTEGER NOT NULL
     )`,
  );
  const latestApplied = Number(db.get("SELECT MAX(version) AS v FROM schema_migrations")?.v ?? 0);
  const latestKnown = migrations.length;
  if (latestApplied > latestKnown) {
    throw new Error(
      `This database was made by a newer VidAI Server (schema ${latestApplied}, this server knows ${latestKnown}). Update the server instead of opening the data with an older one.`,
    );
  }
  let applied = 0;
  for (const migration of migrations) {
    if (migration.version <= latestApplied) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.run(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        migration.version,
        migration.name,
        clock.now(),
      );
    });
    applied += 1;
  }
  return applied;
}

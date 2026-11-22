// The SQLite database (docs/SPEC.md sections 2, 3 and 15): `node:sqlite` behind a small wrapper
// with statement caching and transactions that nest by joining the outer one.

import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations.js";

/** @typedef {{ now(): number }} Clock Milliseconds since 1970; injected so tests control time. */

/** @type {Clock} */
export const systemClock = { now: () => Date.now() };

/** @typedef {import("node:sqlite").SQLInputValue} SqlValue */
/** @typedef {Record<string, import("node:sqlite").SQLOutputValue>} Row */

/**
 * @typedef {object} Database
 * @property {(sql: string, ...params: SqlValue[]) => { changes: number, lastInsertRowid: number }} run
 *   One statement that changes rows.
 * @property {(sql: string, ...params: SqlValue[]) => Row | undefined} get First row or undefined.
 * @property {(sql: string, ...params: SqlValue[]) => Row[]} all Every row.
 * @property {(sql: string) => void} exec Several statements, no parameters (migrations).
 * @property {<T>(fn: () => T) => T} transaction BEGIN IMMEDIATE, COMMIT, ROLLBACK when `fn`
 *   throws. A call inside another transaction simply joins it. `fn` must be synchronous: the
 *   connection is shared, so waiting inside a transaction would let other code interleave.
 * @property {boolean} inTransaction
 * @property {() => void} close Idempotent.
 */

// Enough for every query the server has; the cache only avoids re-preparing hot statements.
const STATEMENT_CACHE_LIMIT = 500;
const BUSY_TIMEOUT_MS = 5000;

/**
 * Opens (creating when needed) and migrates the database.
 * @param {string} path A file path or ":memory:".
 * @param {{ clock?: Clock, migrationsDir?: URL }} [options]
 * @returns {Database}
 */
export function openDatabase(path, options = {}) {
  const raw = new DatabaseSync(path);
  /** @type {Map<string, import("node:sqlite").StatementSync>} */
  const statements = new Map();
  let depth = 0;
  let closed = false;

  /** @param {string} sql */
  function prepare(sql) {
    let statement = statements.get(sql);
    if (!statement) {
      if (statements.size >= STATEMENT_CACHE_LIMIT) statements.clear();
      statement = raw.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  }

  /** @type {Database} */
  const db = {
    run(sql, ...params) {
      const result = prepare(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    get: (sql, ...params) => prepare(sql).get(...params),
    all: (sql, ...params) => prepare(sql).all(...params),
    exec: (sql) => {
      raw.exec(sql);
    },
    transaction(fn) {
      if (depth > 0) return fn();
      raw.exec("BEGIN IMMEDIATE");
      depth = 1;
      try {
        const result = fn();
        if (isPromise(result)) {
          throw new Error("A database transaction function must not be asynchronous.");
        }
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      } finally {
        depth = 0;
      }
    },
    get inTransaction() {
      return depth > 0;
    },
    close() {
      if (closed) return;
      closed = true;
      statements.clear();
      raw.close();
    },
  };

  try {
    // WAL lets the HTTP side read while a job writes; NORMAL is safe with WAL.
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    raw.exec("PRAGMA synchronous = NORMAL");
    migrate(db, { clock: options.clock ?? systemClock, dir: options.migrationsDir });
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPromise(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (/** @type {{ then?: unknown }} */ (value).then) === "function"
  );
}

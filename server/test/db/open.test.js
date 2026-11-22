import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../../src/db/open.js";
import { loadMigrations } from "../../src/db/migrations.js";

/** @typedef {import("../../src/db/open.js").Database} Database */

/** @param {(dir: string) => void | Promise<void>} fn */
async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vidai-db-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const clock = { now: () => 1000 };

/**
 * The one row a query must return.
 * @param {Database} db
 * @param {string} sql
 * @param {...import("../../src/db/open.js").SqlValue} params
 */
function one(db, sql, ...params) {
  const row = db.get(sql, ...params);
  assert.ok(row, `no row for: ${sql}`);
  return row;
}

/**
 * Inserts the minimum rows to have a user, channel, video, job, note, upload, revision.
 * @param {Database} db
 */
function seed(db) {
  db.run(
    "INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES ('u1', 'a@example.com', 'h', 'user', 1, 1)",
  );
  db.run(
    "INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES ('u2', 'b@example.com', 'h', 'user', 1, 1)",
  );
  db.run(
    "INSERT INTO sessions (id, token_hash, user_id, created_at, last_used_at, address, user_agent) VALUES ('s1', 't1', 'u1', 1, 1, 'a', 'b')",
  );
  db.run(
    "INSERT INTO channels (id, user_id, name, dir, video_type, profiles, position, created_at) VALUES ('c1', 'u1', 'Main', '/m/c1', 'auto', '{}', 0, 1)",
  );
  db.run(
    "INSERT INTO videos (id, channel_id, folder_name, created_at) VALUES ('v1', 'c1', 'one', 1)",
  );
  db.run(
    "INSERT INTO jobs (id, video_id, user_id, kind, queue, state, joined_at, video_type) VALUES ('j1', 'v1', 'u1', 'edit', 'edits', 'queued', 1, 'long')",
  );
  db.run(
    "INSERT INTO notes (id, video_id, user_id, frame, prompt, state, job_id, created_at) VALUES ('n1', 'v1', 'u1', 3, 'p', 'pending', 'j1', 1)",
  );
  db.run(
    "INSERT INTO revisions (video_id, n, label, user_id, job_id, created_at) VALUES ('v1', 1, 'Edit', 'u1', 'j1', 1)",
  );
  db.run(
    "INSERT INTO uploads (id, user_id, channel_id, video_id, name, size, created_at, touched_at) VALUES ('up1', 'u1', 'c1', 'v1', 'a.mp4', 10, 1, 1)",
  );
  db.run(
    "INSERT INTO uploads (id, user_id, channel_id, video_id, name, size, created_at, touched_at) VALUES ('up2', 'u1', 'c1', NULL, 'logo.png', 10, 1, 1)",
  );
}

/** @param {Database} db @param {string} table */
const count = (db, table) => Number(one(db, `SELECT COUNT(*) AS n FROM ${table}`).n);

test("a fresh database gets every table of SPEC section 15", () => {
  const db = openDatabase(":memory:", { clock });
  const tables = db
    .all("SELECT name FROM sqlite_master WHERE type = 'table'")
    .map((row) => row.name);
  for (const name of [
    "users",
    "sessions",
    "settings",
    "secrets",
    "channels",
    "videos",
    "jobs",
    "notes",
    "revisions",
    "uploads",
    "edit_log",
    "progress_history",
    "launches",
    "schema_migrations",
  ]) {
    assert.ok(tables.includes(name), `missing table ${name}`);
  }
  assert.equal(one(db, "SELECT MAX(version) AS v FROM schema_migrations").v, 3);
  db.close();
});

test("pragmas are set: foreign keys on, WAL for a file database", () => {
  return withTempDir((dir) => {
    const db = openDatabase(join(dir, "vidai.db"), { clock });
    assert.equal(one(db, "PRAGMA foreign_keys").foreign_keys, 1);
    assert.equal(one(db, "PRAGMA journal_mode").journal_mode, "wal");
    assert.equal(one(db, "PRAGMA synchronous").synchronous, 1);
    assert.ok(Number(one(db, "PRAGMA busy_timeout").timeout) >= 1000);
    db.close();
  });
});

test("opening the same file again applies nothing and keeps the data", () => {
  return withTempDir((dir) => {
    const path = join(dir, "vidai.db");
    const first = openDatabase(path, { clock });
    first.run("INSERT INTO settings (key, value) VALUES ('k', '1')");
    first.close();
    const second = openDatabase(path, { clock });
    assert.equal(count(second, "schema_migrations"), loadMigrations().length);
    assert.equal(one(second, "SELECT value FROM settings WHERE key = 'k'").value, "1");
    second.close();
  });
});

test("a database with a newer schema than the code knows is refused", () => {
  return withTempDir((dir) => {
    const path = join(dir, "vidai.db");
    const db = openDatabase(path, { clock });
    db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, 'future', 1)");
    db.close();
    assert.throws(() => openDatabase(path, { clock }), /newer VidAI Server/);
  });
});

test("migrations apply in order, each in a transaction that rolls back on failure", () => {
  return withTempDir((dir) => {
    const migrations = join(dir, "m");
    mkdirSync(migrations);
    writeFileSync(join(migrations, "001-a.sql"), "CREATE TABLE a (x INTEGER);");
    writeFileSync(
      join(migrations, "002-b.sql"),
      "CREATE TABLE b (x INTEGER); SELECT nope FROM missing;",
    );
    const url = pathToFileURL(migrations + "/");
    assert.throws(() => openDatabase(join(dir, "x.db"), { clock, migrationsDir: url }));
    // The failing migration left nothing behind, the first one stayed.
    writeFileSync(join(migrations, "002-b.sql"), "CREATE TABLE b (x INTEGER);");
    const db = openDatabase(join(dir, "x.db"), { clock, migrationsDir: url });
    const names = db.all("SELECT name FROM schema_migrations ORDER BY version").map((r) => r.name);
    assert.deepEqual(names, ["a", "b"]);
    db.close();
  });
});

test("migration numbers must be 1, 2, 3 without gaps", () => {
  return withTempDir((dir) => {
    writeFileSync(join(dir, "001-a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "003-c.sql"), "SELECT 1;");
    assert.throws(() => loadMigrations(pathToFileURL(dir + "/")), /without gaps/);
  });
});

test("the real migrations load", () => {
  const found = loadMigrations();
  assert.equal(found[0].version, 1);
  assert.equal(found[0].name, "initial");
  assert.equal(found[1].version, 2);
  assert.equal(found[1].name, "note-error");
  assert.equal(found[2].version, 3);
  assert.equal(found[2].name, "upload-targets");
});

test("a database of schema 1 gets the failure sentence column of the change requests", () => {
  return withTempDir((dir) => {
    const only = join(dir, "only-initial");
    mkdirSync(only);
    copyFileSync(
      new URL("../../src/db/migrations/001-initial.sql", import.meta.url),
      join(only, "001-initial.sql"),
    );
    const path = join(dir, "vidai.db");
    const old = openDatabase(path, { clock, migrationsDir: pathToFileURL(only + "/") });
    old.close();
    const db = openDatabase(path, { clock });
    assert.equal(count(db, "schema_migrations"), 3);
    assert.deepEqual(
      db
        .all("PRAGMA table_info(notes)")
        .filter((c) => c.name === "error")
        .map((c) => c.type),
      ["TEXT"],
    );
    db.close();
  });
});

test("a database of schema 2 gets upload targets, loses its unfinished uploads and the storage folders", () => {
  return withTempDir((dir) => {
    const old = join(dir, "up-to-two");
    mkdirSync(old);
    for (const name of ["001-initial.sql", "002-note-error.sql"]) {
      copyFileSync(new URL(`../../src/db/migrations/${name}`, import.meta.url), join(old, name));
    }
    const path = join(dir, "vidai.db");
    const before = openDatabase(path, { clock, migrationsDir: pathToFileURL(old + "/") });
    before.run(
      "INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES ('u1', 'a@example.com', 'h', 'user', 1, 1)",
    );
    before.run(
      "INSERT INTO channels (id, user_id, name, dir, video_type, profiles, position, created_at) VALUES ('c1', 'u1', 'Main', '/m/c1', 'auto', '{}', 0, 1)",
    );
    before.run(
      "INSERT INTO videos (id, channel_id, folder_name, created_at) VALUES ('v1', 'c1', 'one', 1)",
    );
    before.run(
      "INSERT INTO uploads (id, user_id, video_id, folder, name, size, created_at, touched_at) VALUES ('up1', 'u1', 'v1', 'broll', 'a.mp4', 10, 1, 1)",
    );
    before.run("INSERT INTO settings (key, value) VALUES ('storageRoots', '[\"/x\"]')");
    before.run("INSERT INTO settings (key, value) VALUES ('maxUploadGb', '5')");
    before.close();
    const db = openDatabase(path, { clock });
    assert.equal(count(db, "schema_migrations"), 3);
    assert.equal(count(db, "uploads"), 0);
    assert.equal(count(db, "videos"), 1);
    assert.equal(one(db, "SELECT value FROM settings WHERE key = 'maxUploadGb'").value, "5");
    assert.equal(db.all("SELECT value FROM settings WHERE key = 'storageRoots'").length, 0);
    const columns = db.all("PRAGMA table_info(uploads)");
    assert.deepEqual(
      columns.map((c) => c.name),
      [
        "id",
        "user_id",
        "channel_id",
        "video_id",
        "name",
        "size",
        "received",
        "created_at",
        "touched_at",
      ],
    );
    assert.equal(columns.find((c) => c.name === "channel_id")?.notnull, 1);
    assert.equal(columns.find((c) => c.name === "video_id")?.notnull, 0);
    db.close();
  });
});

test("an upload names a channel; a channel upload has no video and goes with its channel", () => {
  const db = openDatabase(":memory:", { clock });
  seed(db);
  db.run("DELETE FROM videos WHERE id = 'v1'");
  assert.deepEqual(
    db.all("SELECT id FROM uploads").map((row) => row.id),
    ["up2"],
  );
  assert.throws(() =>
    db.run(
      "INSERT INTO uploads (id, user_id, channel_id, name, size, created_at, touched_at) VALUES ('x', 'u1', 'ghost', 'a', 1, 1, 1)",
    ),
  );
  db.close();
});

test("foreign keys are really enforced", () => {
  const db = openDatabase(":memory:", { clock });
  assert.throws(
    () =>
      db.run(
        "INSERT INTO sessions (id, token_hash, user_id, created_at, last_used_at, address, user_agent) VALUES ('s', 't', 'ghost', 1, 1, 'a', 'b')",
      ),
    /FOREIGN KEY/,
  );
  db.close();
});

test("CHECK constraints refuse values outside the enums", () => {
  const db = openDatabase(":memory:", { clock });
  assert.throws(
    () =>
      db.run(
        "INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES ('u', 'a@example.com', 'h', 'root', 1, 1)",
      ),
    /CHECK/,
  );
  seed(db);
  assert.throws(
    () =>
      db.run(
        "INSERT INTO jobs (id, video_id, user_id, kind, queue, state, joined_at, video_type) VALUES ('j2', 'v1', 'u1', 'edit', 'edits', 'dancing', 1, 'long')",
      ),
    /CHECK/,
  );
  db.close();
});

test("a video has at most one active job, but any number of finished ones", () => {
  const db = openDatabase(":memory:", { clock });
  seed(db);
  assert.throws(
    () =>
      db.run(
        "INSERT INTO jobs (id, video_id, user_id, kind, queue, state, joined_at, video_type) VALUES ('j2', 'v1', 'u1', 'edit', 'edits', 'running', 1, 'long')",
      ),
    /UNIQUE/,
  );
  db.run("UPDATE jobs SET state = 'completed' WHERE id = 'j1'");
  db.run(
    "INSERT INTO jobs (id, video_id, user_id, kind, queue, state, joined_at, video_type) VALUES ('j2', 'v1', 'u1', 'edit', 'edits', 'running', 1, 'long')",
  );
  db.close();
});

test("deleting a user removes sessions, channels, videos, jobs, notes and uploads", () => {
  const db = openDatabase(":memory:", { clock });
  seed(db);
  db.run("DELETE FROM users WHERE id = 'u1'");
  for (const table of ["sessions", "channels", "videos", "jobs", "notes", "uploads", "revisions"]) {
    assert.equal(count(db, table), 0, table);
  }
  assert.equal(count(db, "users"), 1);
  db.close();
});

test("deleting a channel removes its videos, and those their jobs, notes, revisions and uploads", () => {
  const db = openDatabase(":memory:", { clock });
  seed(db);
  db.run("DELETE FROM channels WHERE id = 'c1'");
  for (const table of ["videos", "jobs", "notes", "revisions", "uploads"]) {
    assert.equal(count(db, table), 0, table);
  }
  assert.equal(count(db, "users"), 2);
  db.close();
});

test("deleting a job keeps its notes and revisions, only unlinked", () => {
  const db = openDatabase(":memory:", { clock });
  seed(db);
  db.run("DELETE FROM jobs WHERE id = 'j1'");
  assert.equal(one(db, "SELECT job_id FROM notes WHERE id = 'n1'").job_id, null);
  assert.equal(one(db, "SELECT job_id FROM revisions WHERE video_id = 'v1'").job_id, null);
  db.close();
});

test("the edit log outlives a deleted user", () => {
  const db = openDatabase(":memory:", { clock });
  seed(db);
  db.run(
    "INSERT INTO edit_log (at, user_id, user_email, video_label, event, message) VALUES (1, 'u1', 'a@example.com', 'x', 'started', 'm')",
  );
  db.run("DELETE FROM users WHERE id = 'u1'");
  const row = one(db, "SELECT user_id, user_email FROM edit_log");
  assert.equal(row.user_id, null);
  assert.equal(row.user_email, "a@example.com");
  db.close();
});

test("email is unique regardless of case", () => {
  const db = openDatabase(":memory:", { clock });
  seed(db);
  assert.throws(
    () =>
      db.run(
        "INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES ('u9', 'A@Example.com', 'h', 'user', 1, 1)",
      ),
    /UNIQUE/,
  );
  db.close();
});

test("a transaction commits, and rolls back when the function throws", () => {
  const db = openDatabase(":memory:", { clock });
  const result = db.transaction(() => {
    db.run("INSERT INTO settings (key, value) VALUES ('a', '1')");
    return 42;
  });
  assert.equal(result, 42);
  assert.throws(
    () =>
      db.transaction(() => {
        db.run("INSERT INTO settings (key, value) VALUES ('b', '2')");
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(count(db, "settings"), 1);
  assert.equal(db.inTransaction, false);
  db.close();
});

test("nested transactions join the outer one", () => {
  const db = openDatabase(":memory:", { clock });
  assert.throws(() =>
    db.transaction(() => {
      db.run("INSERT INTO settings (key, value) VALUES ('a', '1')");
      db.transaction(() => {
        assert.equal(db.inTransaction, true);
        db.run("INSERT INTO settings (key, value) VALUES ('b', '2')");
      });
      assert.equal(count(db, "settings"), 2);
      throw new Error("outer fails");
    }),
  );
  // The inner call did not commit on its own: both inserts are gone.
  assert.equal(count(db, "settings"), 0);
  db.close();
});

test("an asynchronous transaction function is refused and rolled back", () => {
  const db = openDatabase(":memory:", { clock });
  assert.throws(
    () =>
      db.transaction(() => {
        db.run("INSERT INTO settings (key, value) VALUES ('a', '1')");
        return Promise.resolve(1);
      }),
    /must not be asynchronous/,
  );
  assert.equal(count(db, "settings"), 0);
  db.close();
});

test("prepared statements are cached and reused with different parameters", () => {
  const db = openDatabase(":memory:", { clock });
  for (let i = 0; i < 3; i += 1) {
    db.run("INSERT INTO settings (key, value) VALUES (?, ?)", `k${i}`, String(i));
  }
  assert.equal(one(db, "SELECT value FROM settings WHERE key = ?", "k2").value, "2");
  assert.equal(db.all("SELECT key FROM settings ORDER BY key").length, 3);
  assert.equal(db.get("SELECT value FROM settings WHERE key = ?", "missing"), undefined);
  db.close();
});

test("close is idempotent", () => {
  const db = openDatabase(":memory:", { clock });
  db.close();
  db.close();
});

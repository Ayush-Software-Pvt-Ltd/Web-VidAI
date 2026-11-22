import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { openDatabase } from "../../src/db/open.js";
import { createSecrets } from "../../src/secrets.js";

/** @param {(ctx: { db: ReturnType<typeof openDatabase>, keyFile: string, warnings: string[], make: (options?: { memory?: boolean }) => ReturnType<typeof createSecrets> }) => void | Promise<void>} fn */
async function withSecrets(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vidai-secrets-"));
  const db = openDatabase(":memory:");
  const keyFile = join(dir, "data", "secret.key");
  /** @type {string[]} */
  const warnings = [];
  const make = ({ memory = false } = {}) =>
    createSecrets({ db, keyFile, memory, log: { warn: (m) => warnings.push(m) } });
  try {
    await fn({ db, keyFile, warnings, make });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const KEY = "sk-test-0123456789abcdef";

test("a value round-trips and the database never holds it in the clear", async () => {
  await withSecrets(({ db, make }) => {
    const secrets = make();
    secrets.set("anthropicApiKey", KEY);
    assert.equal(secrets.get("anthropicApiKey"), KEY);
    const row = db.get("SELECT nonce, cipher, last4 FROM secrets WHERE name = 'anthropicApiKey'");
    assert.ok(row);
    assert.equal(row.last4, "cdef");
    assert.equal(
      Buffer.from(/** @type {Uint8Array} */ (row.cipher)).includes(Buffer.from(KEY)),
      false,
    );
    assert.equal(/** @type {Uint8Array} */ (row.nonce).length, 12);
  });
});

test("the key file is created with 32 random bytes and owner-only access", async () => {
  await withSecrets(({ keyFile, make }) => {
    make().set("a", KEY);
    assert.equal(readFileSync(keyFile).length, 32);
    if (process.platform !== "win32") assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  });
});

test("status shows saved and the last 4 characters only", async () => {
  await withSecrets(({ make }) => {
    const secrets = make();
    assert.deepEqual(secrets.status("a"), { saved: false, last4: null });
    secrets.set("a", KEY);
    assert.deepEqual(secrets.status("a"), { saved: true, last4: "cdef" });
    secrets.set("short", "abc");
    assert.deepEqual(secrets.status("short"), { saved: true, last4: null });
  });
});

test("setting again replaces, clear removes", async () => {
  await withSecrets(({ make }) => {
    const secrets = make();
    secrets.set("a", "first-value-0001");
    secrets.set("a", "second-value-0002");
    assert.equal(secrets.get("a"), "second-value-0002");
    secrets.clear("a");
    assert.equal(secrets.get("a"), null);
    assert.deepEqual(secrets.status("a"), { saved: false, last4: null });
    secrets.clear("a");
  });
});

test("an empty value is refused", async () => {
  await withSecrets(({ make }) => {
    assert.throws(
      () => make().set("a", ""),
      (e) => /** @type {{code: string}} */ (e).code === "invalidInput",
    );
  });
});

test("each save uses a fresh nonce", async () => {
  await withSecrets(({ db, make }) => {
    const secrets = make();
    secrets.set("a", KEY);
    const first = Buffer.from(
      /** @type {Uint8Array} */ (db.get("SELECT nonce FROM secrets")?.nonce),
    );
    secrets.set("a", KEY);
    const second = Buffer.from(
      /** @type {Uint8Array} */ (db.get("SELECT nonce FROM secrets")?.nonce),
    );
    assert.notDeepEqual(first, second);
  });
});

test("tampered cipher text gives null and one log line, never a crash", async () => {
  await withSecrets(({ db, make, warnings }) => {
    const secrets = make();
    secrets.set("a", KEY);
    const cipher = Buffer.from(
      /** @type {Uint8Array} */ (db.get("SELECT cipher FROM secrets")?.cipher),
    );
    cipher[0] = (cipher[0] ?? 0) ^ 0xff;
    db.run("UPDATE secrets SET cipher = ?", cipher);
    assert.equal(secrets.get("a"), null);
    assert.equal(secrets.get("a"), null);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0] ?? "", /sk-test/);
  });
});

test("a value moved to another name does not decrypt", async () => {
  await withSecrets(({ db, make }) => {
    const secrets = make();
    secrets.set("a", KEY);
    db.run("UPDATE secrets SET name = 'b'");
    assert.equal(secrets.get("b"), null);
  });
});

test("a changed key file makes get return null and log once", async () => {
  await withSecrets(({ keyFile, make, warnings }) => {
    make().set("a", KEY);
    writeFileSync(keyFile, randomBytes(32));
    const later = make();
    assert.equal(later.get("a"), null);
    assert.equal(later.get("a"), null);
    assert.equal(warnings.length, 1);
    // Saving again under the new key works.
    later.set("a", KEY);
    assert.equal(later.get("a"), KEY);
  });
});

test("a damaged key file (wrong length) cannot save and does not crash get", async () => {
  await withSecrets(({ keyFile, make, warnings }) => {
    const secrets = make();
    secrets.set("a", KEY);
    writeFileSync(keyFile, Buffer.from("short"));
    const later = make();
    assert.equal(later.get("a"), null);
    assert.equal(warnings.length, 1);
    assert.throws(
      () => later.set("a", KEY),
      (e) => /** @type {{code: string}} */ (e).code === "io",
    );
  });
});

test("memory mode keeps values in memory and writes no key file and no row", async () => {
  await withSecrets(({ db, keyFile, make }) => {
    const secrets = make({ memory: true });
    secrets.set("a", KEY);
    assert.equal(secrets.get("a"), KEY);
    assert.deepEqual(secrets.status("a"), { saved: true, last4: "cdef" });
    assert.equal(existsSync(keyFile), false);
    assert.equal(db.all("SELECT * FROM secrets").length, 0);
    secrets.clear("a");
    assert.equal(secrets.get("a"), null);
    // A new instance starts empty: nothing was persisted.
    assert.equal(make({ memory: true }).get("a"), null);
  });
});

test("an unknown name is null without creating a key file side effect on the data", async () => {
  await withSecrets(({ make }) => {
    assert.equal(make().get("nothing"), null);
  });
});

// The preview copies on disk (docs/SPEC.md section 2, `cache/proxy/`; section 11, Preview copies).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { proxyName } from "../../src/timeline/proxyName.js";
import { createCopyStore } from "../../src/timeline/proxyStore.js";

const log = { info() {}, warn() {}, error() {}, debug() {} };
const DAY = 24 * 60 * 60 * 1000;

/** @param {{ statTtlMs?: number, maxBytes?: () => number | null }} [options] */
function setup(options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vidai-store-")));
  const dir = path.join(root, "cache", "proxy");
  fs.mkdirSync(dir, { recursive: true });
  const clock = {
    t: Date.now(),
    now() {
      return this.t;
    },
  };
  const make = () => createCopyStore({ dir, clock, log, ...options });
  return {
    root,
    dir,
    clock,
    make,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    /** An original with a given size; returns its path and the name of its copy. */
    original(/** @type {string} */ file, /** @type {number} */ bytes) {
      const p = path.join(root, file);
      fs.writeFileSync(p, Buffer.alloc(bytes));
      const stat = fs.statSync(p);
      return {
        path: p,
        name: proxyName(p, stat.size, stat.mtimeMs),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    },
  };
}

/** @param {string} dir @param {string} name @param {number} bytes @param {number} mtimeMs */
function writeCopy(dir, name, bytes, mtimeMs) {
  const file = path.join(dir, `${name}.mp4`);
  fs.writeFileSync(file, Buffer.alloc(bytes, 2));
  const date = new Date(mtimeMs);
  fs.utimesSync(file, date, date);
}

/** @param {ReturnType<typeof setup>} w @param {ReturnType<ReturnType<typeof setup>["original"]>} o */
async function writeNote(w, o, store = w.make()) {
  await store.writeFacts(o.name, {
    realPath: o.path,
    size: o.size,
    mtimeMs: o.mtimeMs,
    facts: null,
    reasons: [],
  });
}

test("proxyFor: a finished copy is found by the original's path, size and time", () => {
  const w = setup();
  try {
    const o = w.original("clip.mov", 50);
    writeCopy(w.dir, o.name, 10, w.clock.t);
    fs.mkdirSync(w.dir, { recursive: true });
    const store = w.make();
    assert.equal(store.proxyFor(o.path), path.join(w.dir, `${o.name}.mp4`));
    assert.equal(store.proxyFor(path.join(w.root, "other.mov")), null, "no such file");
  } finally {
    w.cleanup();
  }
});

test("proxyFor: a miss before the copy exists, a hit once it is marked ready", () => {
  const w = setup();
  try {
    const o = w.original("clip.mov", 50);
    const store = w.make();
    assert.equal(store.proxyFor(o.path), null);
    fs.writeFileSync(path.join(w.dir, `${o.name}.mp4`), "x");
    store.markReady(o.name);
    assert.equal(store.proxyFor(o.path), path.join(w.dir, `${o.name}.mp4`));
  } finally {
    w.cleanup();
  }
});

test("proxyFor: a replaced original stops matching after the short stat cache", () => {
  const w = setup({ statTtlMs: 2000 });
  try {
    const o = w.original("clip.mov", 50);
    writeCopy(w.dir, o.name, 10, w.clock.t);
    const store = w.make();
    assert.ok(store.proxyFor(o.path));
    // The original is replaced by a longer file; within the cache time the old answer stands.
    fs.writeFileSync(o.path, Buffer.alloc(80));
    assert.ok(store.proxyFor(o.path), "cached for a moment, so a request costs no stat");
    w.clock.t += 2001;
    assert.equal(store.proxyFor(o.path), null, "the new file has another name");
  } finally {
    w.cleanup();
  }
});

test("proxyFor: a replaced original with the same size is told by its time", () => {
  const w = setup({ statTtlMs: 0 });
  try {
    const o = w.original("clip.mov", 50);
    writeCopy(w.dir, o.name, 10, w.clock.t);
    const store = w.make();
    assert.ok(store.proxyFor(o.path));
    const later = new Date(o.mtimeMs + 5000);
    fs.utimesSync(o.path, later, later);
    assert.equal(store.proxyFor(o.path), null);
  } finally {
    w.cleanup();
  }
});

test("proxyFor: a temporary file is ignored, and leftovers are deleted at the start", () => {
  const w = setup();
  try {
    const o = w.original("clip.mov", 50);
    fs.mkdirSync(w.dir, { recursive: true });
    fs.writeFileSync(path.join(w.dir, `${o.name}.part`), "half");
    fs.writeFileSync(path.join(w.dir, `${o.name}.json.part`), "{");
    const store = w.make();
    assert.equal(store.proxyFor(o.path), null);
    assert.deepEqual(fs.readdirSync(w.dir), []);
  } finally {
    w.cleanup();
  }
});

test("proxyFor: a vanished original or a folder is a miss, never an error", () => {
  const w = setup();
  try {
    const store = w.make();
    assert.equal(store.proxyFor(path.join(w.root, "gone.mov")), null);
    assert.equal(store.proxyFor(w.root), null);
  } finally {
    w.cleanup();
  }
});

test("a used copy gets a new time at most once an hour, so the sweep keeps it", async () => {
  const w = setup({ statTtlMs: 0 });
  try {
    const o = w.original("clip.mov", 50);
    const old = w.clock.t - 20 * DAY;
    writeCopy(w.dir, o.name, 10, old);
    const store = w.make();
    store.proxyFor(o.path);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const file = path.join(w.dir, `${o.name}.mp4`);
    assert.ok(Math.abs(fs.statSync(file).mtimeMs - w.clock.t) < 1000);
    const touched = fs.statSync(file).mtimeMs;
    w.clock.t += 60_000;
    store.proxyFor(o.path);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fs.statSync(file).mtimeMs, touched, "not renewed within the hour");
  } finally {
    w.cleanup();
  }
});

test("facts are written whole and read back; garbage reads as nothing", async () => {
  const w = setup();
  try {
    const o = w.original("clip.mov", 50);
    const store = w.make();
    assert.equal(await store.readFacts(o.name), null);
    await writeNote(w, o, store);
    assert.equal((await store.readFacts(o.name))?.realPath, o.path);
    assert.deepEqual(
      fs.readdirSync(w.dir).filter((f) => f.endsWith(".part")),
      [],
    );
    fs.writeFileSync(path.join(w.dir, `${o.name}.json`), "not json");
    assert.equal(await store.readFacts(o.name), null);
  } finally {
    w.cleanup();
  }
});

test("sweep: copies unused for 30 days go, newer ones stay", async () => {
  const w = setup();
  try {
    const fresh = w.original("fresh.mov", 50);
    const stale = w.original("stale.mov", 60);
    const store = w.make();
    await writeNote(w, fresh, store);
    await writeNote(w, stale, store);
    writeCopy(w.dir, fresh.name, 10, w.clock.t - 29 * DAY);
    writeCopy(w.dir, stale.name, 20, w.clock.t - 31 * DAY);
    const reopened = w.make();
    const result = await reopened.sweep();
    assert.deepEqual(result, { deleted: 1, freedBytes: 20 });
    assert.ok(fs.existsSync(path.join(w.dir, `${fresh.name}.mp4`)));
    assert.ok(!fs.existsSync(path.join(w.dir, `${stale.name}.mp4`)));
    assert.equal(reopened.has(stale.name), false);
    assert.equal(reopened.has(fresh.name), true);
  } finally {
    w.cleanup();
  }
});

test("sweep: a copy whose original is gone or was replaced is deleted with its notes", async () => {
  const w = setup();
  try {
    const gone = w.original("gone.mov", 50);
    const changed = w.original("changed.mov", 60);
    const store = w.make();
    await writeNote(w, gone, store);
    await writeNote(w, changed, store);
    writeCopy(w.dir, gone.name, 10, w.clock.t);
    writeCopy(w.dir, changed.name, 10, w.clock.t);
    fs.rmSync(gone.path);
    fs.writeFileSync(changed.path, Buffer.alloc(61));
    const result = await w.make().sweep();
    assert.equal(result.deleted, 2);
    assert.deepEqual(fs.readdirSync(w.dir), []);
  } finally {
    w.cleanup();
  }
});

test("sweep: a copy without notes (nothing says what it is for) is deleted", async () => {
  const w = setup();
  try {
    const o = w.original("clip.mov", 50);
    fs.mkdirSync(w.dir, { recursive: true });
    writeCopy(w.dir, o.name, 10, w.clock.t);
    const result = await w.make().sweep();
    assert.equal(result.deleted, 1);
  } finally {
    w.cleanup();
  }
});

test("sweep: old notes of light files go, recent ones stay; foreign files are never touched", async () => {
  const w = setup();
  try {
    const old = w.original("old.mov", 50);
    const recent = w.original("recent.mov", 50);
    const store = w.make();
    await writeNote(w, old, store);
    await writeNote(w, recent, store);
    const date = new Date(w.clock.t - 40 * DAY);
    fs.utimesSync(path.join(w.dir, `${old.name}.json`), date, date);
    fs.writeFileSync(path.join(w.dir, "README.txt"), "mine");
    await w.make().sweep();
    assert.ok(!fs.existsSync(path.join(w.dir, `${old.name}.json`)));
    assert.ok(fs.existsSync(path.join(w.dir, `${recent.name}.json`)));
    assert.ok(fs.existsSync(path.join(w.dir, "README.txt")));
  } finally {
    w.cleanup();
  }
});

test("sweep: beyond the size cap the oldest copies go first", async () => {
  const w = setup({ maxBytes: () => 250 });
  try {
    const names = [];
    for (const [i, bytes] of [100, 100, 100].entries()) {
      const o = w.original(`c${i}.mov`, 50 + i);
      names.push(o.name);
      await writeNote(w, o);
      writeCopy(w.dir, o.name, bytes, w.clock.t - (3 - i) * DAY);
    }
    const store = w.make();
    const result = await store.sweep();
    assert.deepEqual(result, { deleted: 1, freedBytes: 100 });
    assert.ok(!fs.existsSync(path.join(w.dir, `${names[0]}.mp4`)), "the oldest is the one");
    assert.ok(fs.existsSync(path.join(w.dir, `${names[1]}.mp4`)));
    assert.ok(fs.existsSync(path.join(w.dir, `${names[2]}.mp4`)));
  } finally {
    w.cleanup();
  }
});

test("usage: the number and total size of finished copies only", async () => {
  const w = setup();
  try {
    const a = w.original("a.mov", 50);
    const b = w.original("b.mov", 51);
    const store = w.make();
    assert.deepEqual(await store.usage(), { files: 0, bytes: 0 });
    await writeNote(w, a, store);
    writeCopy(w.dir, a.name, 30, w.clock.t);
    writeCopy(w.dir, b.name, 12, w.clock.t);
    fs.writeFileSync(path.join(w.dir, "x.part"), "zzz");
    assert.deepEqual(await store.usage(), { files: 2, bytes: 42 });
  } finally {
    w.cleanup();
  }
});

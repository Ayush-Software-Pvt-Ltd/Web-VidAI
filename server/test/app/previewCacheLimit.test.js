// The admin setting `proxyCacheGb` limits the preview copies (SPEC sections 11 and 14): the limit is
// the current setting at every sweep, and a lower one is applied at once, not at the daily sweep.
// One "gigabyte" is 100 bytes here (`bytesPerGb`), so the copies can be tiny.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createCopyStore } from "../../src/timeline/proxyStore.js";
import { proxyName } from "../../src/timeline/proxyName.js";
import { startWorld, until } from "./world.js";

const DAY = 24 * 60 * 60 * 1000;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Three copies of 100 bytes each, the first one the oldest, with the notes that keep a sweep from
 * deleting them for other reasons.
 * @param {Awaited<ReturnType<typeof startWorld>>} w
 */
async function seedCopies(w) {
  const dir = w.app.paths.proxyCacheDir;
  const store = createCopyStore({ dir, clock: { now: () => Date.now() }, log: quiet });
  /** @type {string[]} */
  const names = [];
  for (let i = 0; i < 3; i++) {
    const original = path.join(w.root, `heavy${i}.mov`);
    fs.writeFileSync(original, Buffer.alloc(50 + i));
    const stat = fs.statSync(original);
    const name = proxyName(original, stat.size, stat.mtimeMs);
    names.push(name);
    await store.writeFacts(name, {
      realPath: original,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      facts: null,
      reasons: [],
    });
    const copy = path.join(dir, `${name}.mp4`);
    fs.writeFileSync(copy, Buffer.alloc(100, 2));
    const date = new Date(Date.now() - (3 - i) * DAY);
    fs.utimesSync(copy, date, date);
  }
  const exists = (/** @type {string} */ name) => fs.existsSync(path.join(dir, `${name}.mp4`));
  return { names, exists };
}

test("a lower limit sweeps at once, a higher one deletes nothing, the limit is the setting", async () => {
  const w = await startWorld({ engine: { bytesPerGb: 100 }, settings: { proxyCacheGb: 3 } });
  try {
    const { names, exists } = await seedCopies(w);
    const [oldest, middle, newest] = /** @type {[string, string, string]} */ (names);

    // The limit in force is the one in the settings: 3 x 100 bytes keeps all three.
    assert.deepEqual(await w.api["copies"].sweep(), { deleted: 0, freedBytes: 0 });

    // Raising the limit deletes nothing.
    assert.equal((await w.admin.rpc("adminUpdateSettings", { proxyCacheGb: 5 })).status, 200);
    await new Promise((done) => setTimeout(done, 100));
    assert.ok(exists(oldest) && exists(middle) && exists(newest));

    // Lowering it to 2 x 100 bytes removes the oldest copy now, with no sweep called by the test.
    assert.equal((await w.admin.rpc("adminUpdateSettings", { proxyCacheGb: 2 })).status, 200);
    await until(() => !exists(oldest));
    assert.ok(exists(middle) && exists(newest));

    // And to 1: the next oldest goes.
    assert.equal((await w.admin.rpc("adminUpdateSettings", { proxyCacheGb: 1 })).status, 200);
    await until(() => !exists(middle));
    assert.ok(exists(newest));

    // A change that leaves the limit alone sweeps nothing more (the newest stays).
    assert.equal((await w.admin.rpc("adminUpdateSettings", { maxEditsPerUser: 4 })).status, 200);
    await new Promise((done) => setTimeout(done, 100));
    assert.ok(exists(newest));
  } finally {
    await w.close();
  }
});

test("the limit at start is the saved one: the sweep at start (here a later one) uses it", async () => {
  const w = await startWorld({ engine: { bytesPerGb: 100 }, settings: { proxyCacheGb: 1 } });
  try {
    const { names, exists } = await seedCopies(w);
    // The saved limit (1 x 100 bytes) is what `sweep` uses, without any settings change after it.
    const result = await w.api["copies"].sweep();
    assert.deepEqual(result, { deleted: 2, freedBytes: 200 });
    assert.ok(exists(/** @type {string} */ (names[2])));
  } finally {
    await w.close();
  }
});

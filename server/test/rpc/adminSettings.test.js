import { test } from "node:test";
import assert from "node:assert/strict";
import { conflict } from "../../src/errors.js";
import { createTestApp, rejectsWith } from "./support.js";

/** @typedef {import("../../../src/lib/wire.ts").AdminSettings} AdminSettings */

function withAdmin() {
  const app = createTestApp();
  const admin = app.makeUser("admin@example.com", { role: "admin" });
  return { app, ctx: app.contextFor(admin) };
}

test("a signed-out caller and a plain user cannot read or change settings", async () => {
  const { app } = withAdmin();
  const user = app.makeUser("u@example.com");
  for (const [name, input] of /** @type {[string, unknown][]} */ ([
    ["adminGetSettings", {}],
    ["adminUpdateSettings", { maxEdits: 3 }],
  ])) {
    await rejectsWith(app.call(name, input, app.contextFor()), "unauthenticated");
    await rejectsWith(app.call(name, input, app.contextFor(user)), "forbidden");
  }
  assert.equal(app.settings.getAll().maxEdits, 2);
  assert.deepEqual(app.emitted, []);
});

test("adminGetSettings returns every setting", async () => {
  const { app, ctx } = withAdmin();
  const all = /** @type {AdminSettings} */ (await app.call("adminGetSettings", {}, ctx));
  assert.equal(all.maxEdits, 2);
  assert.equal(all.setup, "claudeSubscription");
  assert.ok(!("storageRoots" in all));
  assert.equal(Object.keys(all).length, 13);
});

test("adminUpdateSettings validates, clamps, answers with everything and announces the public view", async () => {
  const { app, ctx } = withAdmin();
  const all = /** @type {AdminSettings} */ (
    await app.call(
      "adminUpdateSettings",
      { maxEdits: 50, cpuTotalPercent: 47, setup: "openaiApi", maxUploadGb: 10 },
      ctx,
    )
  );
  assert.equal(all.maxEdits, 8);
  assert.equal(all.cpuTotalPercent, 45);
  assert.equal(all.setup, "openaiApi");
  assert.deepEqual(app.emitted, [
    {
      event: "settings-changed",
      payload: { setup: "openaiApi", maxUploadGb: 10, maxEditsPerUser: 0, startDelayMinutes: 0 },
      userId: null,
      admins: false,
    },
  ]);
});

test("adminUpdateSettings refuses unknown keys and wrong types, announcing nothing", async () => {
  const { app, ctx } = withAdmin();
  await rejectsWith(app.call("adminUpdateSettings", { nope: 1 }, ctx), "invalidInput", /nope/);
  await rejectsWith(app.call("adminUpdateSettings", { maxEdits: "3" }, ctx), "invalidInput");
  await rejectsWith(app.call("adminUpdateSettings", { setup: "x" }, ctx), "invalidInput");
  assert.equal(app.settings.getAll().maxEdits, 2);
  assert.deepEqual(app.emitted, []);
});

test("a module can refuse a settings change: nothing is stored or announced", async () => {
  /** @type {unknown[]} */
  const seen = [];
  const app = createTestApp({
    hooks: {
      beforeSettingsChange: async (clean) => {
        seen.push(clean);
        if (clean.maxEdits === 8) throw conflict("A module can say no to a change.");
      },
    },
  });
  const admin = app.makeUser("admin@example.com", { role: "admin" });
  const ctx = app.contextFor(admin);
  await app.call("adminUpdateSettings", { maxEdits: 50 }, ctx).then(
    () => assert.fail("refused"),
    (error) => assert.equal(error.code, "conflict"),
  );
  assert.deepEqual(seen, [{ maxEdits: 8 }], "the hook sees the checked change");
  assert.equal(app.settings.getAll().maxEdits, 2);
  assert.deepEqual(app.emitted, []);
  // A change the hook accepts goes through.
  await app.call("adminUpdateSettings", { maxEdits: 3 }, ctx);
  assert.equal(app.settings.getAll().maxEdits, 3);
});

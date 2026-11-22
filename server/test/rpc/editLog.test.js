import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTestApp } from "./support.js";
import { createEditLog } from "../../src/editLog.js";
import { editLogFunctions } from "../../src/rpc/editLog.js";

function world() {
  const app = createTestApp();
  const editLog = createEditLog({
    db: app.db,
    users: app.users,
    clock: app.clock,
    log: { info() {}, warn() {}, error() {} },
    strict: true,
  });
  app.rpc.register(editLogFunctions({ editLog }));
  return { app, editLog };
}

describe("rpc getEditLog", () => {
  it("answers the signed-in user's page", async () => {
    const { app, editLog } = world();
    const alice = app.makeUser("alice@example.com");
    const bob = app.makeUser("bob@example.com");
    editLog.record({ userId: alice.id, videoLabel: "C / v", event: "started", message: "a" });
    editLog.record({ userId: bob.id, videoLabel: "C / v", event: "started", message: "b" });
    const page = /** @type {any} */ (await app.rpc.call("getEditLog", {}, app.contextFor(alice)));
    assert.equal(page.more, false);
    assert.deepEqual(
      page.entries.map((/** @type {any} */ e) => e.message),
      ["a"],
    );
    assert.deepEqual(Object.keys(page.entries[0]).sort(), [
      "at",
      "event",
      "id",
      "message",
      "userEmail",
      "userId",
      "videoLabel",
    ]);
  });

  it("needs a session", async () => {
    const { app } = world();
    await assert.rejects(app.rpc.call("getEditLog", {}, app.contextFor(null)), {
      code: "unauthenticated",
    });
  });

  it("pages with before and limit", async () => {
    const { app, editLog } = world();
    const alice = app.makeUser("alice@example.com");
    for (let n = 0; n < 5; n++)
      editLog.record({ userId: alice.id, event: "started", message: `m${n}` });
    const first = /** @type {any} */ (
      await app.rpc.call("getEditLog", { limit: 2 }, app.contextFor(alice))
    );
    assert.equal(first.entries.length, 2);
    assert.equal(first.more, true);
    const next = /** @type {any} */ (
      await app.rpc.call(
        "getEditLog",
        { limit: 2, before: first.entries[1].id },
        app.contextFor(alice),
      )
    );
    assert.deepEqual(
      next.entries.map((/** @type {any} */ e) => e.message),
      ["m2", "m1"],
    );
  });

  it("refuses odd input", async () => {
    const { app } = world();
    const alice = app.makeUser("alice@example.com");
    for (const input of [
      { limit: 0 },
      { before: -1 },
      { limit: "5" },
      { all: "yes" },
      { nope: 1 },
    ]) {
      await assert.rejects(app.rpc.call("getEditLog", input, app.contextFor(alice)), {
        code: "invalidInput",
      });
    }
  });

  it("clamps a limit above 500", async () => {
    const { app } = world();
    const alice = app.makeUser("alice@example.com");
    const page = /** @type {any} */ (
      await app.rpc.call("getEditLog", { limit: 5000 }, app.contextFor(alice))
    );
    assert.deepEqual(page, { entries: [], more: false });
  });

  it("lets only an admin ask for another user or for all", async () => {
    const { app, editLog } = world();
    const admin = app.makeUser("admin@example.com", { role: "admin" });
    const alice = app.makeUser("alice@example.com");
    editLog.record({ userId: alice.id, event: "started", message: "a" });
    await assert.rejects(app.rpc.call("getEditLog", { all: true }, app.contextFor(alice)), {
      code: "forbidden",
    });
    await assert.rejects(app.rpc.call("getEditLog", { userId: admin.id }, app.contextFor(alice)), {
      code: "forbidden",
    });
    const all = /** @type {any} */ (
      await app.rpc.call("getEditLog", { all: true }, app.contextFor(admin))
    );
    assert.equal(all.entries.length, 1);
    const one = /** @type {any} */ (
      await app.rpc.call("getEditLog", { userId: alice.id }, app.contextFor(admin))
    );
    assert.equal(one.entries.length, 1);
    const own = /** @type {any} */ (await app.rpc.call("getEditLog", {}, app.contextFor(admin)));
    assert.equal(own.entries.length, 0);
  });
});

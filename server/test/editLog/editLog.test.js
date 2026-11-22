import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDatabase } from "../../src/db/open.js";
import { createUsersRepo } from "../../src/db/users.js";
import { createEditLogRepo } from "../../src/db/editLog.js";
import { createEditLog, EDIT_EVENTS } from "../../src/editLog.js";
import { AppError } from "../../src/errors.js";

/** @param {{ keep?: number, strict?: boolean }} [options] */
function setup({ keep, strict = false } = {}) {
  let now = 1_700_000_000_000;
  const clock = { now: () => (now += 1000) };
  const db = openDatabase(":memory:", { clock });
  const users = createUsersRepo(db, { clock });
  /** @type {string[]} */
  const warnings = [];
  /** @type {unknown[]} */
  const errors = [];
  /** @type {Map<string, { channelName: string, folderName: string }>} */
  const videos = new Map();
  const editLog = createEditLog({
    db,
    users,
    clock,
    log: {
      info() {},
      warn: (m) => void warnings.push(m),
      error: (m, e) => void errors.push(e ?? m),
    },
    describeVideo: (key) => videos.get(key),
    ...(keep ? { keep } : {}),
    strict,
  });
  const make = (/** @type {string} */ email, /** @type {"admin" | "user"} */ role = "user") =>
    users.create({ email, passwordHash: "h", role, mayMarkUrgent: false });
  return { db, users, editLog, warnings, errors, videos, make };
}

describe("edit log: record and read back", () => {
  it("keeps the email and the video label as they were", () => {
    const { editLog, make, videos } = setup();
    const alice = make("alice@example.com");
    videos.set("k1", { channelName: "Daily", folderName: "ep 12" });
    const id = editLog.record({
      userId: alice.id,
      videoKey: "k1",
      event: "started",
      message: "Edit started",
    });
    assert.equal(typeof id, "number");
    const page = editLog.read(alice);
    assert.equal(page.more, false);
    assert.deepEqual(page.entries, [
      {
        id,
        at: page.entries[0]?.at,
        userId: alice.id,
        userEmail: "alice@example.com",
        videoLabel: "Daily / ep 12",
        event: "started",
        message: "Edit started",
      },
    ]);
    assert.ok((page.entries[0]?.at ?? 0) > 0);
  });

  it("uses an explicit label first, then the library, then a fallback", () => {
    const { editLog, make, videos } = setup();
    const alice = make("alice@example.com");
    videos.set("k1", { channelName: "Daily", folderName: "ep 12" });
    editLog.record({
      userId: alice.id,
      videoKey: "k1",
      videoLabel: "Old / name",
      event: "stopped",
      message: "m",
    });
    editLog.record({ userId: alice.id, videoKey: "gone", event: "stopped", message: "m" });
    editLog.record({ userId: alice.id, event: "stopped", message: "m" });
    const labels = editLog.read(alice).entries.map((entry) => entry.videoLabel);
    assert.deepEqual(labels, ["", "A video that no longer exists", "Old / name"]);
  });

  it("returns the newest entry first", () => {
    const { editLog, make } = setup();
    const alice = make("alice@example.com");
    for (const event of ["started", "paused", "completed"]) {
      editLog.record({ userId: alice.id, videoKey: null, event, message: event });
    }
    assert.deepEqual(
      editLog.read(alice).entries.map((entry) => entry.event),
      ["completed", "paused", "started"],
    );
  });

  it("clips very long text", () => {
    const { editLog, make } = setup();
    const alice = make("alice@example.com");
    editLog.record({ userId: alice.id, event: "failed", message: "x".repeat(5000) });
    const [entry] = editLog.read(alice).entries;
    assert.equal([...(entry?.message ?? "")].length, 1000);
    assert.ok(entry?.message.endsWith("…"));
  });

  it("knows the event names of the wire type", () => {
    assert.deepEqual(
      [...EDIT_EVENTS].sort(),
      [
        "archived",
        "changeRequest",
        "completed",
        "continued",
        "diskCleanup",
        "failed",
        "paused",
        "reEdit",
        "render",
        "started",
        "stopped",
        "unarchived",
      ].sort(),
    );
  });
});

describe("edit log: unknown events", () => {
  it("are stored as given in production, with a warning", () => {
    const { editLog, make, warnings } = setup();
    const alice = make("alice@example.com");
    editLog.record({ userId: alice.id, event: "somethingNew", message: "m" });
    assert.equal(editLog.read(alice).entries[0]?.event, "somethingNew");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /somethingNew/);
  });

  it("are refused in strict mode, which tests use", () => {
    const { editLog, make } = setup({ strict: true });
    const alice = make("alice@example.com");
    assert.throws(
      () => editLog.record({ userId: alice.id, event: "nope", message: "m" }),
      /Unknown/,
    );
    assert.equal(editLog.count(), 0);
  });
});

describe("edit log: paging", () => {
  it("pages by the id of the last entry", () => {
    const { editLog, make } = setup();
    const alice = make("alice@example.com");
    for (let n = 1; n <= 7; n++) {
      editLog.record({ userId: alice.id, event: "started", message: `m${n}` });
    }
    const first = editLog.read(alice, { limit: 3 });
    assert.deepEqual(
      first.entries.map((e) => e.message),
      ["m7", "m6", "m5"],
    );
    assert.equal(first.more, true);
    const second = editLog.read(alice, { limit: 3, before: first.entries[2]?.id ?? 0 });
    assert.deepEqual(
      second.entries.map((e) => e.message),
      ["m4", "m3", "m2"],
    );
    assert.equal(second.more, true);
    const third = editLog.read(alice, { limit: 3, before: second.entries[2]?.id ?? 0 });
    assert.deepEqual(
      third.entries.map((e) => e.message),
      ["m1"],
    );
    assert.equal(third.more, false);
  });

  it("says no more when the last page is exactly full", () => {
    const { editLog, make } = setup();
    const alice = make("alice@example.com");
    for (let n = 0; n < 3; n++)
      editLog.record({ userId: alice.id, event: "started", message: "m" });
    assert.equal(editLog.read(alice, { limit: 3 }).more, false);
  });

  it("defaults to 100 and never gives more than 500", () => {
    const { editLog, make, db } = setup();
    const alice = make("alice@example.com");
    db.transaction(() => {
      for (let n = 0; n < 520; n++)
        editLog.record({ userId: alice.id, event: "started", message: "m" });
    });
    assert.equal(editLog.read(alice).entries.length, 100);
    assert.equal(editLog.read(alice, { limit: 9999 }).entries.length, 500);
    assert.equal(editLog.read(alice, { limit: 9999 }).more, true);
  });
});

describe("edit log: the cap", () => {
  it("keeps the newest rows and deletes older ones in the same transaction", () => {
    const { editLog, make, db } = setup({ keep: 5 });
    const alice = make("alice@example.com");
    for (let n = 1; n <= 12; n++)
      editLog.record({ userId: alice.id, event: "started", message: `m${n}` });
    assert.equal(editLog.count(), 5);
    assert.deepEqual(
      editLog.read(alice).entries.map((e) => e.message),
      ["m12", "m11", "m10", "m9", "m8"],
    );
    assert.equal(db.inTransaction, false);
  });

  it("is shared by every user: the newest rows of the whole log stay", () => {
    const { editLog, make } = setup({ keep: 3 });
    const alice = make("alice@example.com");
    const bob = make("bob@example.com");
    editLog.record({ userId: alice.id, event: "started", message: "a1" });
    editLog.record({ userId: bob.id, event: "started", message: "b1" });
    editLog.record({ userId: bob.id, event: "started", message: "b2" });
    editLog.record({ userId: bob.id, event: "started", message: "b3" });
    assert.equal(editLog.read(alice).entries.length, 0);
    assert.equal(editLog.read(bob).entries.length, 3);
  });

  it("refuses a cap below 1", () => {
    assert.throws(() => setup({ keep: -1 }), /at least 1/);
  });

  it("rolls back the new row together with the delete when the outer transaction fails", () => {
    const { editLog, make, db } = setup({ keep: 2 });
    const alice = make("alice@example.com");
    editLog.record({ userId: alice.id, event: "started", message: "a" });
    assert.throws(() =>
      db.transaction(() => {
        editLog.record({ userId: alice.id, event: "started", message: "b" });
        editLog.record({ userId: alice.id, event: "started", message: "c" });
        throw new Error("boom");
      }),
    );
    assert.deepEqual(
      editLog.read(alice).entries.map((e) => e.message),
      ["a"],
    );
  });
});

describe("edit log: who sees what", () => {
  it("never returns another user's entries to a user", () => {
    const { editLog, make } = setup();
    const alice = make("alice@example.com");
    const bob = make("bob@example.com");
    editLog.record({ userId: alice.id, event: "started", message: "alice" });
    editLog.record({ userId: bob.id, event: "started", message: "bob" });
    assert.deepEqual(
      editLog.read(alice).entries.map((e) => e.message),
      ["alice"],
    );
    assert.deepEqual(
      editLog.read(bob).entries.map((e) => e.message),
      ["bob"],
    );
  });

  it("refuses a user asking for another user or for all", () => {
    const { editLog, make } = setup();
    const alice = make("alice@example.com");
    const bob = make("bob@example.com");
    for (const query of [{ userId: bob.id }, { all: true }, { userId: alice.id }]) {
      assert.throws(
        () => editLog.read(alice, query),
        (error) => error instanceof AppError && error.code === "forbidden",
      );
    }
  });

  it("lets an admin read one user or everybody", () => {
    const { editLog, make } = setup();
    const admin = make("admin@example.com", "admin");
    const alice = make("alice@example.com");
    const bob = make("bob@example.com");
    editLog.record({ userId: alice.id, event: "started", message: "alice" });
    editLog.record({ userId: bob.id, event: "started", message: "bob" });
    editLog.record({ userId: admin.id, event: "started", message: "admin" });
    assert.deepEqual(
      editLog.read(admin).entries.map((e) => e.message),
      ["admin"],
    );
    assert.deepEqual(
      editLog.read(admin, { userId: bob.id }).entries.map((e) => e.message),
      ["bob"],
    );
    assert.deepEqual(
      editLog.read(admin, { all: true }).entries.map((e) => e.message),
      ["admin", "bob", "alice"],
    );
  });

  it("refuses userId together with all", () => {
    const { editLog, make } = setup();
    const admin = make("admin@example.com", "admin");
    assert.throws(() => editLog.read(admin, { all: true, userId: admin.id }), /not both/);
  });
});

describe("edit log: deleted users", () => {
  it("keeps the rows, empties the user id and keeps the email", () => {
    const { editLog, make, users } = setup();
    const admin = make("admin@example.com", "admin");
    const alice = make("alice@example.com");
    editLog.record({
      userId: alice.id,
      videoLabel: "Daily / ep 1",
      event: "completed",
      message: "done",
    });
    users.delete(alice.id);
    assert.equal(editLog.count(), 1);
    const [entry] = editLog.read(admin, { all: true }).entries;
    assert.equal(entry?.userId, null);
    assert.equal(entry?.userEmail, "alice@example.com");
    assert.equal(entry?.videoLabel, "Daily / ep 1");
    assert.equal(editLog.read(admin).entries.length, 0);
  });

  it("records for a user that is already gone with an empty email and no user id", () => {
    const { editLog, make, users } = setup();
    const admin = make("admin@example.com", "admin");
    const alice = make("alice@example.com");
    users.delete(alice.id);
    const id = editLog.record({ userId: alice.id, event: "stopped", message: "late" });
    assert.notEqual(id, null);
    const [entry] = editLog.read(admin, { all: true }).entries;
    assert.equal(entry?.userId, null);
    assert.equal(entry?.userEmail, "");
  });
});

describe("edit log: failures", () => {
  it("record with a broken database does not throw and logs the error", () => {
    const { editLog, make, db, errors } = setup();
    const alice = make("alice@example.com");
    db.close();
    assert.doesNotThrow(() =>
      assert.equal(editLog.record({ userId: alice.id, event: "started", message: "m" }), null),
    );
    assert.ok(errors.length >= 1);
  });

  it("repository: the page query on a closed database throws (read is not hidden)", () => {
    const { db } = setup();
    const repo = createEditLogRepo(db);
    db.close();
    assert.throws(() => repo.page({ userId: null, before: null, limit: 1 }));
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, rejectsWith, PASSWORD } from "./support.js";
import { verifyPassword } from "../../src/auth/passwords.js";

/** An app with an admin and a signed-in admin context. @param {Parameters<typeof createTestApp>[0]} [options] */
function withAdmin(options) {
  const app = createTestApp(options);
  const admin = app.makeUser("admin@example.com", { role: "admin" });
  return { app, admin, ctx: app.contextFor(admin) };
}

/** @typedef {import("../../../src/lib/wire.ts").UserAccount} UserAccount */

test("a signed-out caller and a plain user cannot call any admin user function", async () => {
  const { app } = withAdmin();
  const user = app.makeUser("u@example.com");
  const calls = [
    ["adminListUsers", {}],
    ["adminCreateUser", { email: "n@example.com", password: "a long enough pw" }],
    ["adminUpdateUser", { id: user.id, role: "admin" }],
    ["adminDeleteUser", { id: user.id }],
  ];
  for (const [name, input] of /** @type {[string, unknown][]} */ (calls)) {
    await rejectsWith(app.call(name, input, app.contextFor()), "unauthenticated");
    await rejectsWith(app.call(name, input, app.contextFor(user)), "forbidden");
  }
  assert.equal(app.users.byId(user.id)?.role, "user");
});

test("adminListUsers lists every account with the fields of UserAccount", async () => {
  const { app, admin, ctx } = withAdmin({
    hooks: { activeJobCount: (id) => (id === "x" ? 1 : 3) },
  });
  const user = app.makeUser("b@example.com", { mayMarkUrgent: false, disabled: true });
  app.clock.advance(1000);
  const list = /** @type {UserAccount[]} */ (await app.call("adminListUsers", {}, ctx));
  assert.deepEqual(
    list.map((u) => u.email),
    ["admin@example.com", "b@example.com"],
  );
  const row = list.find((u) => u.id === user.id);
  assert.deepEqual(row, {
    id: user.id,
    email: "b@example.com",
    role: "user",
    disabled: true,
    mayMarkUrgent: false,
    createdAt: user.createdAt,
    lastSeenAt: null,
    activeJobs: 3,
  });
  const me = list.find((u) => u.id === admin.id);
  assert.equal(me?.lastSeenAt, admin.createdAt, "the admin signed in once");
  assert.equal(Object.hasOwn(row ?? {}, "passwordHash"), false);
});

test("adminListUsers shows no active jobs until the job engine says otherwise", async () => {
  const { app, ctx } = withAdmin();
  const list = /** @type {UserAccount[]} */ (await app.call("adminListUsers", {}, ctx));
  assert.equal(list[0]?.activeJobs, 0);
});

test("adminCreateUser makes an account: email normalised, password hashed, defaults applied", async () => {
  const { app, ctx } = withAdmin();
  const created = /** @type {UserAccount} */ (
    await app.call(
      "adminCreateUser",
      { email: "  New@Example.COM ", password: "a long enough pw" },
      ctx,
    )
  );
  assert.equal(created.email, "new@example.com");
  assert.equal(created.role, "user");
  assert.equal(created.mayMarkUrgent, true);
  assert.equal(created.disabled, false);
  assert.equal(created.activeJobs, 0);
  const stored = app.users.byId(created.id);
  assert.match(stored?.passwordHash ?? "", /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword("a long enough pw", stored?.passwordHash ?? ""), true);

  const second = /** @type {UserAccount} */ (
    await app.call(
      "adminCreateUser",
      {
        email: "boss@example.com",
        password: "a long enough pw",
        role: "admin",
        mayMarkUrgent: false,
      },
      ctx,
    )
  );
  assert.equal(second.role, "admin");
  assert.equal(second.mayMarkUrgent, false);
});

test("adminCreateUser refuses a taken email in any case, bad emails and weak passwords", async () => {
  const { app, ctx } = withAdmin();
  await rejectsWith(
    app.call("adminCreateUser", { email: "ADMIN@example.com", password: "a long enough pw" }, ctx),
    "conflict",
    /^An account with this email already exists\.$/,
  );
  await rejectsWith(
    app.call("adminCreateUser", { email: "nope", password: "a long enough pw" }, ctx),
    "invalidInput",
  );
  await rejectsWith(
    app.call("adminCreateUser", { email: "n@example.com", password: "short" }, ctx),
    "invalidInput",
  );
  await rejectsWith(
    app.call(
      "adminCreateUser",
      { email: "n@example.com", password: "a long enough pw", role: "root" },
      ctx,
    ),
    "invalidInput",
    /"role"/,
  );
  await rejectsWith(
    app.call(
      "adminCreateUser",
      { email: "n@example.com", password: "a long enough pw", extra: 1 },
      ctx,
    ),
    "invalidInput",
    /"extra"/,
  );
  assert.equal(app.users.list().length, 1);
});

test("adminUpdateUser changes email, role, mayMarkUrgent and disabled", async () => {
  const { app, ctx } = withAdmin();
  const user = app.makeUser("u@example.com");
  const updated = /** @type {UserAccount} */ (
    await app.call(
      "adminUpdateUser",
      { id: user.id, email: " NewName@Example.com", role: "admin", mayMarkUrgent: false },
      ctx,
    )
  );
  assert.equal(updated.email, "newname@example.com");
  assert.equal(updated.role, "admin");
  assert.equal(updated.mayMarkUrgent, false);
  const off = /** @type {UserAccount} */ (
    await app.call("adminUpdateUser", { id: user.id, disabled: true }, ctx)
  );
  assert.equal(off.disabled, true);
  const on = /** @type {UserAccount} */ (
    await app.call("adminUpdateUser", { id: user.id, disabled: false }, ctx)
  );
  assert.equal(on.disabled, false);
  assert.ok((app.users.byId(user.id)?.updatedAt ?? 0) >= user.updatedAt);
});

test("adminUpdateUser refuses a taken email, unknown ids and bad input", async () => {
  const { app, ctx } = withAdmin();
  const user = app.makeUser("u@example.com");
  await rejectsWith(
    app.call("adminUpdateUser", { id: user.id, email: "admin@example.com" }, ctx),
    "conflict",
    /already exists/,
  );
  await rejectsWith(app.call("adminUpdateUser", { id: "ghost", role: "admin" }, ctx), "notFound");
  await rejectsWith(
    app.call("adminUpdateUser", { id: user.id, email: "bad" }, ctx),
    "invalidInput",
  );
  await rejectsWith(
    app.call("adminUpdateUser", { id: user.id, password: "short" }, ctx),
    "invalidInput",
  );
  await rejectsWith(
    app.call("adminUpdateUser", { id: user.id, role: "owner" }, ctx),
    "invalidInput",
  );
  await rejectsWith(app.call("adminUpdateUser", { email: "x@example.com" }, ctx), "invalidInput");
  assert.equal(app.users.byId(user.id)?.email, "u@example.com");
});

test("the last enabled admin cannot be made a user, also by themself", async () => {
  const { app, admin, ctx } = withAdmin();
  await rejectsWith(
    app.call("adminUpdateUser", { id: admin.id, role: "user" }, ctx),
    "conflict",
    /last admin cannot be made a user/,
  );
  await assert.rejects(app.call("adminUpdateUser", { id: admin.id, role: "user" }, ctx), {
    field: "role",
  });
  assert.equal(app.users.byId(admin.id)?.role, "admin");
});

test("the last enabled admin cannot be disabled, also by themself", async () => {
  const { app, admin, ctx } = withAdmin();
  await rejectsWith(
    app.call("adminUpdateUser", { id: admin.id, disabled: true }, ctx),
    "conflict",
    /last admin cannot be disabled/,
  );
  await assert.rejects(app.call("adminUpdateUser", { id: admin.id, disabled: true }, ctx), {
    field: "disabled",
  });
  assert.equal(app.users.byId(admin.id)?.disabled, false);
  assert.equal(app.sessions.countOfUser(admin.id), 1);
});

test("a disabled second admin does not count as an admin", async () => {
  const { app, admin, ctx } = withAdmin();
  app.makeUser("old@example.com", { role: "admin", disabled: true });
  await rejectsWith(app.call("adminUpdateUser", { id: admin.id, role: "user" }, ctx), "conflict");
});

test("with two enabled admins one can be demoted, disabled or edit themself", async () => {
  const { app, admin, ctx } = withAdmin();
  const second = app.makeUser("second@example.com", { role: "admin" });
  await app.call("adminUpdateUser", { id: second.id, role: "user" }, ctx);
  assert.equal(app.users.byId(second.id)?.role, "user");
  await app.call("adminUpdateUser", { id: second.id, role: "admin" }, ctx);
  await app.call("adminUpdateUser", { id: second.id, disabled: true }, ctx);
  // Now admin is the last one again.
  await rejectsWith(app.call("adminUpdateUser", { id: admin.id, role: "user" }, ctx), "conflict");
  // Keeping the role (and changing something else) is fine.
  await app.call("adminUpdateUser", { id: admin.id, role: "admin", mayMarkUrgent: false }, ctx);
});

test("an admin can demote themself when another enabled admin exists", async () => {
  const { app, admin, ctx } = withAdmin();
  app.makeUser("second@example.com", { role: "admin" });
  await app.call("adminUpdateUser", { id: admin.id, role: "user" }, ctx);
  assert.equal(app.users.byId(admin.id)?.role, "user");
  // The role is read on every request, so the demotion applies at once.
  await rejectsWith(app.call("adminListUsers", {}, app.contextFor(admin)), "forbidden");
});

test("an admin setting someone's password ends all their sessions and closes their streams", async () => {
  const { app, ctx } = withAdmin();
  const user = app.makeUser("u@example.com");
  app.contextFor(user);
  app.contextFor(user);
  await app.call("adminUpdateUser", { id: user.id, password: "set by the admin" }, ctx);
  assert.equal(
    await verifyPassword("set by the admin", app.users.byId(user.id)?.passwordHash ?? ""),
    true,
  );
  assert.equal(app.sessions.countOfUser(user.id), 0);
  assert.deepEqual(app.closed, [user.id]);
  assert.deepEqual(app.emitted, [
    {
      event: "session-ended",
      payload: { reason: "passwordChanged" },
      userId: user.id,
      admins: false,
    },
  ]);
});

test("an admin changing their own password keeps this session and ends the others", async () => {
  const { app, admin, ctx } = withAdmin();
  app.contextFor(admin);
  await app.call("adminUpdateUser", { id: admin.id, password: "my new password" }, ctx);
  assert.equal(app.sessions.countOfUser(admin.id), 1);
  assert.deepEqual(app.closed, []);
  assert.equal(await verifyPassword(PASSWORD, app.users.byId(admin.id)?.passwordHash ?? ""), false);
});

test("disabling ends the sessions, runs the hook before the call completes and closes streams", async () => {
  /** @type {string[]} */
  const order = [];
  /** @type {{ app: ReturnType<typeof createTestApp> | null }} */
  const holder = { app: null };
  /** @type {string} */
  let userId = "";
  const hooks = {
    onUserDisabled: async (/** @type {string} */ id) => {
      assert.equal(id, userId);
      // The sessions are already gone when the job engine is told.
      assert.equal(holder.app?.sessions.countOfUser(id), 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("hook");
    },
  };
  const app = createTestApp({ hooks });
  holder.app = app;
  const admin = app.makeUser("admin@example.com", { role: "admin" });
  const user = app.makeUser("u@example.com");
  userId = user.id;
  app.contextFor(user);
  const ctx = app.contextFor(admin);
  await app.call("adminUpdateUser", { id: user.id, disabled: true }, ctx);
  order.push("done");
  assert.deepEqual(order, ["hook", "done"]);
  assert.deepEqual(app.closed, [user.id]);
  assert.equal(app.emitted[0]?.event, "session-ended");
  assert.deepEqual(app.emitted[0]?.payload, { reason: "disabled" });
  // Disabling again, or changing something else, does not run the hook again.
  await app.call("adminUpdateUser", { id: user.id, disabled: true }, ctx);
  assert.equal(order.length, 2);
});

test("an admin who disables themself (another admin exists) loses their cookie", async () => {
  const { app, admin, ctx } = withAdmin();
  app.makeUser("second@example.com", { role: "admin" });
  await app.call("adminUpdateUser", { id: admin.id, disabled: true }, ctx);
  assert.deepEqual(ctx.cookies, [null]);
  assert.equal(app.sessions.countOfUser(admin.id), 0);
});

test("a failing disable hook surfaces as an error but the account stays disabled", async () => {
  const hooks = {
    onUserDisabled: async () => {
      throw new Error("could not stop jobs");
    },
  };
  const { app, ctx } = withAdmin({ hooks });
  const user = app.makeUser("u@example.com");
  await rejectsWith(
    app.call("adminUpdateUser", { id: user.id, disabled: true }, ctx),
    "internal",
    /could not stop/,
  );
  assert.equal(app.users.byId(user.id)?.disabled, true);
});

test("adminDeleteUser removes the account, its sessions and its rows, after the hook", async () => {
  /** @type {string[]} */
  const seen = [];
  /** @type {{ app: ReturnType<typeof createTestApp> | null }} */
  const holder = { app: null };
  const hooks = {
    onUserRemoved: async (/** @type {string} */ id) => {
      // The account and its channels still exist while the job engine cleans up.
      seen.push(`user:${holder.app?.users.byId(id) ? "present" : "gone"}`);
      seen.push(
        `channels:${holder.app?.db.all("SELECT id FROM channels WHERE user_id = ?", id).length}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
  const app = createTestApp({ hooks });
  holder.app = app;
  const admin = app.makeUser("admin@example.com", { role: "admin" });
  const user = app.makeUser("u@example.com");
  app.db.run(
    "INSERT INTO channels (id, user_id, name, dir, video_type, profiles, position, created_at) VALUES ('c1', ?, 'Main', '/m/c1', 'auto', '{}', 0, 1)",
    user.id,
  );
  app.contextFor(user);
  const result = await app.call("adminDeleteUser", { id: user.id }, app.contextFor(admin));
  assert.equal(result, null);
  assert.deepEqual(seen, ["user:present", "channels:1"]);
  assert.equal(app.users.byId(user.id), null);
  assert.equal(app.db.all("SELECT id FROM channels").length, 0);
  assert.deepEqual(app.closed, [user.id]);
  assert.deepEqual(app.emitted[0]?.payload, { reason: "removed" });
});

test("the last enabled admin cannot be deleted, not even by themself", async () => {
  const { app, admin, ctx } = withAdmin();
  await rejectsWith(
    app.call("adminDeleteUser", { id: admin.id }, ctx),
    "conflict",
    /last admin cannot be deleted/,
  );
  assert.ok(app.users.byId(admin.id));
  assert.equal(app.sessions.countOfUser(admin.id), 1);
  assert.deepEqual(app.closed, []);
});

test("an admin can delete another admin, or themself when another admin exists", async () => {
  const { app, admin, ctx } = withAdmin();
  const second = app.makeUser("second@example.com", { role: "admin" });
  await app.call("adminDeleteUser", { id: second.id }, ctx);
  assert.equal(app.users.byId(second.id), null);
  const third = app.makeUser("third@example.com", { role: "admin" });
  await app.call("adminDeleteUser", { id: admin.id }, ctx);
  assert.equal(app.users.byId(admin.id), null);
  assert.deepEqual(ctx.cookies, [null]);
  assert.ok(app.users.byId(third.id));
});

test("a disabled admin can be deleted even when only one admin is enabled", async () => {
  const { app, ctx } = withAdmin();
  const old = app.makeUser("old@example.com", { role: "admin", disabled: true });
  await app.call("adminDeleteUser", { id: old.id }, ctx);
  assert.equal(app.users.byId(old.id), null);
});

test("adminDeleteUser refuses unknown ids and bad input", async () => {
  const { app, ctx } = withAdmin();
  await rejectsWith(app.call("adminDeleteUser", { id: "ghost" }, ctx), "notFound");
  await rejectsWith(app.call("adminDeleteUser", {}, ctx), "invalidInput");
});

test("two admins demoting each other at the same moment cannot both succeed", async () => {
  const { app, admin, ctx } = withAdmin();
  const second = app.makeUser("second@example.com", { role: "admin" });
  const secondCtx = app.contextFor(second);
  const results = await Promise.allSettled([
    app.call("adminUpdateUser", { id: second.id, role: "user" }, ctx),
    app.call("adminUpdateUser", { id: admin.id, role: "user" }, secondCtx),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(app.users.countEnabledAdmins(), 1);
});

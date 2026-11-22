import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, rejectsWith, PASSWORD } from "../rpc/support.js";
import { resetAdminPassword } from "../../src/auth/setup.js";
import { verifyPassword } from "../../src/auth/passwords.js";

test("with VIDAI_ADMIN_EMAIL and VIDAI_ADMIN_PASSWORD an admin is created and the log hides the password", async () => {
  const app = createTestApp();
  const result = await app.setup.ensureFirstAdmin({
    env: { VIDAI_ADMIN_EMAIL: " Boss@Example.com ", VIDAI_ADMIN_PASSWORD: "a-long-secret-pw" },
  });
  assert.deepEqual(result, { created: true, setupToken: null });
  const admin = app.users.byEmail("boss@example.com");
  assert.equal(admin?.role, "admin");
  assert.match(admin?.passwordHash ?? "", /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword("a-long-secret-pw", admin?.passwordHash ?? ""), true);
  assert.equal(app.infoLog.length, 1);
  assert.match(app.infoLog[0] ?? "", /boss@example\.com/);
  assert.doesNotMatch(app.infoLog[0] ?? "", /a-long-secret-pw/);
  assert.equal(app.setup.needsSetup(), false);
  assert.equal(app.setup.setupToken, null);
});

test("without the environment a one-time token of 32 random bytes is made", async () => {
  const app = createTestApp();
  const result = await app.setup.ensureFirstAdmin({ env: {} });
  assert.equal(result.created, false);
  assert.equal(Buffer.from(result.setupToken ?? "", "base64url").length, 32);
  assert.equal(app.setup.setupToken, result.setupToken);
  assert.equal(app.users.list().length, 0);
  assert.equal(app.setup.needsSetup(), true);
  // Only one of the two variables is not enough.
  const half = await app.setup.ensureFirstAdmin({ env: { VIDAI_ADMIN_EMAIL: "a@example.com" } });
  assert.equal(half.created, false);
  assert.notEqual(half.setupToken, result.setupToken, "each start makes its own token");
});

test("when an admin exists nothing is created and there is no token", async () => {
  const app = createTestApp();
  app.makeUser("admin@example.com", { role: "admin" });
  const result = await app.setup.ensureFirstAdmin({
    env: { VIDAI_ADMIN_EMAIL: "other@example.com", VIDAI_ADMIN_PASSWORD: "a-long-secret-pw" },
  });
  assert.deepEqual(result, { created: false, setupToken: null });
  assert.equal(app.users.list().length, 1);
});

test("a disabled-only admin does not count: setup is offered again", async () => {
  const app = createTestApp();
  app.makeUser("admin@example.com", { role: "admin", disabled: true });
  assert.equal(app.setup.needsSetup(), true);
});

test("setupAdmin creates the first admin once and the token ends", async () => {
  const app = createTestApp();
  const { setupToken } = await app.setup.ensureFirstAdmin({ env: {} });
  const admin = await app.setup.setupAdmin(setupToken, " First@Example.com", "another-long-pw");
  assert.equal(admin.email, "first@example.com");
  assert.equal(admin.role, "admin");
  assert.equal(app.setup.setupToken, null);
  await rejectsWith(
    app.setup.setupAdmin(setupToken, "second@example.com", "another-long-pw"),
    "forbidden",
  );
  assert.equal(app.users.list().length, 1);
});

test("a wrong token is refused and does not use the real one up", async () => {
  const app = createTestApp();
  const { setupToken } = await app.setup.ensureFirstAdmin({ env: {} });
  await rejectsWith(app.setup.setupAdmin("wrong", "a@example.com", "another-long-pw"), "forbidden");
  await rejectsWith(app.setup.setupAdmin("", "a@example.com", "another-long-pw"), "forbidden");
  await rejectsWith(
    app.setup.setupAdmin(undefined, "a@example.com", "another-long-pw"),
    "forbidden",
  );
  assert.ok(await app.setup.setupAdmin(setupToken, "a@example.com", "another-long-pw"));
});

test("bad email or password input does not use the token up", async () => {
  const app = createTestApp();
  const { setupToken } = await app.setup.ensureFirstAdmin({ env: {} });
  await rejectsWith(
    app.setup.setupAdmin(setupToken, "not-an-email", "another-long-pw"),
    "invalidInput",
  );
  await rejectsWith(app.setup.setupAdmin(setupToken, "a@example.com", "short"), "invalidInput");
  assert.ok(await app.setup.setupAdmin(setupToken, "a@example.com", "another-long-pw"));
});

test("without a token (never made) setupAdmin is refused", async () => {
  const app = createTestApp();
  await rejectsWith(
    app.setup.setupAdmin("anything", "a@example.com", "another-long-pw"),
    "forbidden",
  );
});

test("the token only works while no admin exists", async () => {
  const app = createTestApp();
  const { setupToken } = await app.setup.ensureFirstAdmin({ env: {} });
  app.makeUser("admin@example.com", { role: "admin" });
  await rejectsWith(
    app.setup.setupAdmin(setupToken, "a@example.com", "another-long-pw"),
    "forbidden",
  );
  assert.equal(app.users.list().length, 1);
});

test("two simultaneous requests with the token make one admin", async () => {
  const app = createTestApp();
  const { setupToken } = await app.setup.ensureFirstAdmin({ env: {} });
  const results = await Promise.allSettled([
    app.setup.setupAdmin(setupToken, "a@example.com", "another-long-pw"),
    app.setup.setupAdmin(setupToken, "b@example.com", "another-long-pw"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(app.users.list().length, 1);
});

test("resetAdminPassword sets the password and ends the admin's sessions", async () => {
  const app = createTestApp();
  const admin = app.makeUser("admin@example.com", { role: "admin" });
  const other = app.makeUser("user@example.com");
  const meta = { address: "a", userAgent: "b" };
  app.sessions.create(admin.id, meta);
  app.sessions.create(other.id, meta);
  const updated = await resetAdminPassword({
    users: app.users,
    sessions: app.sessions,
    email: " ADMIN@example.com",
    password: "brand-new-password",
  });
  assert.equal(await verifyPassword("brand-new-password", updated.passwordHash), true);
  assert.equal(await verifyPassword(PASSWORD, updated.passwordHash), false);
  assert.equal(app.sessions.countOfUser(admin.id), 0);
  assert.equal(app.sessions.countOfUser(other.id), 1);
});

test("resetAdminPassword refuses unknown emails, non-admins and weak passwords", async () => {
  const app = createTestApp();
  app.makeUser("admin@example.com", { role: "admin" });
  app.makeUser("user@example.com");
  const base = { users: app.users, sessions: app.sessions, password: "brand-new-password" };
  await rejectsWith(resetAdminPassword({ ...base, email: "nobody@example.com" }), "notFound");
  await rejectsWith(resetAdminPassword({ ...base, email: "user@example.com" }), "notFound");
  await rejectsWith(
    resetAdminPassword({ ...base, email: "admin@example.com", password: "short" }),
    "invalidInput",
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, rejectsWith, PASSWORD } from "./support.js";
import { verifyPassword } from "../../src/auth/passwords.js";

const REFUSED = /^Email or password is wrong\.$/;

/** Collects the message of the error a promise rejects with. @param {Promise<unknown>} promise */
async function errorOf(promise) {
  try {
    await promise;
  } catch (error) {
    return /** @type {{ code: string, message: string }} */ (error);
  }
  throw new Error("Expected a rejection.");
}

test("getSession for a signed-out visitor never throws and says whether setup is needed", async () => {
  const app = createTestApp({ version: "9.9.9" });
  assert.deepEqual(await app.call("getSession", {}, app.contextFor()), {
    user: null,
    needsSetup: true,
    serverVersion: "9.9.9",
  });
  app.makeUser("admin@example.com", { role: "admin" });
  const info = /** @type {{ needsSetup: boolean }} */ (
    await app.call("getSession", null, app.contextFor())
  );
  assert.equal(info.needsSetup, false);
});

test("getSession for a signed-in user has the account with mayMarkUrgent", async () => {
  const app = createTestApp();
  const user = app.makeUser("u@example.com", { mayMarkUrgent: false });
  assert.deepEqual(await app.call("getSession", {}, app.contextFor(user)), {
    user: { id: user.id, email: "u@example.com", role: "user", mayMarkUrgent: false },
    needsSetup: true,
    serverVersion: "1.2.3",
  });
});

test("login signs in, sets the cookie and answers like getSession", async () => {
  const app = createTestApp();
  const user = app.makeUser("u@example.com");
  const ctx = app.contextFor();
  const info = /** @type {{ user: { email: string } }} */ (
    await app.call("login", { email: "  U@Example.com ", password: PASSWORD }, ctx)
  );
  assert.equal(info.user.email, "u@example.com");
  assert.equal(ctx.cookies.length, 1);
  const token = ctx.cookies[0];
  assert.equal(typeof token, "string");
  const session = app.sessions.authenticate(/** @type {string} */ (token), ctx);
  assert.equal(session?.user.id, user.id);
});

test("a wrong email, a wrong password and a disabled account all get the same answer", async () => {
  const app = createTestApp();
  app.makeUser("u@example.com");
  app.makeUser("off@example.com", { disabled: true });
  const attempts = [
    { email: "ghost@example.com", password: PASSWORD },
    { email: "u@example.com", password: "wrong password" },
    { email: "off@example.com", password: PASSWORD },
    { email: "not an email", password: PASSWORD },
    { email: "u@example.com", password: "x".repeat(500) },
  ];
  for (const attempt of attempts) {
    const ctx = app.contextFor();
    const error = await errorOf(app.call("login", attempt, ctx));
    assert.equal(error.code, "invalidInput", attempt.email);
    assert.match(error.message, REFUSED);
    assert.equal(ctx.cookies.length, 0);
  }
});

test("login does the same hashing work for an unknown email as for a wrong password", async () => {
  const app = createTestApp();
  app.makeUser("u@example.com");
  // Both take one scrypt run (tens of milliseconds); an unknown email must not return at once.
  const time = async (/** @type {string} */ email) => {
    const started = performance.now();
    await errorOf(app.call("login", { email, password: "wrong password" }, app.contextFor()));
    return performance.now() - started;
  };
  const known = await time("u@example.com");
  app.throttle.success({ email: "ghost@example.com" });
  const unknown = await time("ghost@example.com");
  assert.ok(unknown > known / 4, `unknown ${unknown}ms vs known ${known}ms`);
  assert.ok(unknown > 5, `an unknown email took only ${unknown}ms`);
});

test("login input must be text", async () => {
  const app = createTestApp();
  await rejectsWith(app.call("login", {}, app.contextFor()), "invalidInput", /"email" is missing/);
  await rejectsWith(
    app.call("login", { email: 1, password: "x" }, app.contextFor()),
    "invalidInput",
  );
});

test("five failures block the email for 15 minutes with the rateLimited sentence", async () => {
  const app = createTestApp();
  app.makeUser("u@example.com");
  for (let i = 0; i < 5; i += 1) {
    await rejectsWith(
      app.call("login", { email: "u@example.com", password: "wrong password" }, app.contextFor()),
      "invalidInput",
    );
  }
  // Even the right password is refused while blocked.
  await rejectsWith(
    app.call("login", { email: "u@example.com", password: PASSWORD }, app.contextFor()),
    "rateLimited",
    /^Too many attempts\. Try again in 15 minutes\.$/,
  );
  app.clock.advance(14 * 60_000 + 30_000);
  await rejectsWith(
    app.call("login", { email: "u@example.com", password: PASSWORD }, app.contextFor()),
    "rateLimited",
    /in 1 minute\.$/,
  );
  app.clock.advance(30_000);
  await app.call("login", { email: "u@example.com", password: PASSWORD }, app.contextFor());
});

test("failures from one address block it for every email", async () => {
  const app = createTestApp();
  app.makeUser("u@example.com");
  for (let i = 0; i < 5; i += 1) {
    await rejectsWith(
      app.call("login", { email: `ghost${i}@example.com`, password: "x" }, app.contextFor()),
      "invalidInput",
    );
  }
  await rejectsWith(
    app.call("login", { email: "u@example.com", password: PASSWORD }, app.contextFor()),
    "rateLimited",
  );
});

test("a success clears the email's failures", async () => {
  const app = createTestApp();
  app.makeUser("u@example.com");
  const attempt = (/** @type {string} */ password, /** @type {string} */ address) =>
    app.call("login", { email: "u@example.com", password }, app.contextFor(null, address));
  for (let i = 0; i < 4; i += 1)
    await rejectsWith(attempt("wrong password", "10.0.1.1"), "invalidInput");
  await attempt(PASSWORD, "10.0.1.1");
  // Four more from another address: without the reset the email would have 8 failures and be blocked.
  for (let i = 0; i < 4; i += 1)
    await rejectsWith(attempt("wrong password", "10.0.2.2"), "invalidInput");
  await attempt(PASSWORD, "10.0.3.3");
});

test("logging in again replaces the browser's old session", async () => {
  const app = createTestApp();
  const user = app.makeUser("u@example.com");
  const ctx = app.contextFor(user);
  assert.equal(app.sessions.countOfUser(user.id), 1);
  await app.call("login", { email: "u@example.com", password: PASSWORD }, ctx);
  assert.equal(app.sessions.countOfUser(user.id), 1);
});

test("logout ends the session and clears the cookie; a signed-out caller is refused", async () => {
  const app = createTestApp();
  const user = app.makeUser("u@example.com");
  const ctx = app.contextFor(user);
  const other = app.contextFor(user);
  assert.equal(await app.call("logout", {}, ctx), null);
  assert.deepEqual(ctx.cookies, [null]);
  assert.equal(app.sessions.countOfUser(user.id), 1);
  assert.deepEqual(app.closed, [], "the other session keeps its stream");
  await app.call("logout", {}, other);
  assert.deepEqual(app.closed, [user.id], "the last session closes the streams");
  await rejectsWith(app.call("logout", {}, app.contextFor()), "unauthenticated");
});

test("changePassword needs the current password, ends the other sessions and keeps this one", async () => {
  const app = createTestApp();
  const user = app.makeUser("u@example.com");
  const ctx = app.contextFor(user);
  const other = app.contextFor(user);
  const third = app.contextFor(user);
  await app.call(
    "changePassword",
    { currentPassword: PASSWORD, newPassword: "a brand new one" },
    ctx,
  );

  const stored = app.users.byId(user.id)?.passwordHash ?? "";
  assert.equal(await verifyPassword("a brand new one", stored), true);
  assert.equal(await verifyPassword(PASSWORD, stored), false);
  assert.equal(app.sessions.countOfUser(user.id), 1);
  assert.ok(ctx.session && app.sessionsRepo.listByUser(user.id)[0]?.id === ctx.session.id);
  assert.ok(other.session && third.session);
  assert.deepEqual(app.closed, [], "still signed in here, so the streams stay open");
  assert.deepEqual(app.emitted, []);
});

test("changePassword with a wrong current password or a weak new one changes nothing", async () => {
  const app = createTestApp();
  const user = app.makeUser("u@example.com");
  const ctx = app.contextFor(user);
  const before = app.users.byId(user.id)?.passwordHash;
  await rejectsWith(
    app.call(
      "changePassword",
      { currentPassword: "nope nope nope", newPassword: "a brand new one" },
      ctx,
    ),
    "invalidInput",
    /current password is wrong/,
  );
  await rejectsWith(
    app.call("changePassword", { currentPassword: PASSWORD, newPassword: "short" }, ctx),
    "invalidInput",
    /8 to 200/,
  );
  assert.equal(app.users.byId(user.id)?.passwordHash, before);
  await rejectsWith(app.call("changePassword", { currentPassword: PASSWORD }, ctx), "invalidInput");
  await rejectsWith(
    app.call(
      "changePassword",
      { currentPassword: PASSWORD, newPassword: "a brand new one" },
      app.contextFor(),
    ),
    "unauthenticated",
  );
});

test("guessing the current password is throttled", async () => {
  const app = createTestApp();
  const user = app.makeUser("u@example.com");
  const ctx = app.contextFor(user);
  for (let i = 0; i < 5; i += 1) {
    await rejectsWith(
      app.call(
        "changePassword",
        { currentPassword: "wrong wrong", newPassword: "a brand new one" },
        ctx,
      ),
      "invalidInput",
    );
  }
  await rejectsWith(
    app.call("changePassword", { currentPassword: PASSWORD, newPassword: "a brand new one" }, ctx),
    "rateLimited",
  );
});

test("setupAdmin makes the first admin, signs them in, and works only once", async () => {
  const app = createTestApp();
  const { setupToken } = await app.setup.ensureFirstAdmin({ env: {} });
  const ctx = app.contextFor();
  const info = /** @type {{ user: { role: string, email: string }, needsSetup: boolean }} */ (
    await app.call(
      "setupAdmin",
      { token: setupToken, email: "Root@Example.com", password: "a long enough pw" },
      ctx,
    )
  );
  assert.equal(info.user.role, "admin");
  assert.equal(info.user.email, "root@example.com");
  assert.equal(info.needsSetup, false);
  assert.equal(ctx.cookies.length, 1);
  await rejectsWith(
    app.call(
      "setupAdmin",
      { token: setupToken, email: "x@example.com", password: "a long enough pw" },
      app.contextFor(),
    ),
    "forbidden",
  );
});

test("setupAdmin refuses a wrong token and bad input", async () => {
  const app = createTestApp();
  const { setupToken } = await app.setup.ensureFirstAdmin({ env: {} });
  await rejectsWith(
    app.call(
      "setupAdmin",
      { token: "wrong", email: "x@example.com", password: "a long enough pw" },
      app.contextFor(),
    ),
    "forbidden",
  );
  await rejectsWith(
    app.call(
      "setupAdmin",
      { token: setupToken, email: "bad", password: "a long enough pw" },
      app.contextFor(),
    ),
    "invalidInput",
  );
  await rejectsWith(
    app.call("setupAdmin", { email: "x@example.com" }, app.contextFor()),
    "invalidInput",
  );
  assert.equal(app.users.list().length, 0);
});

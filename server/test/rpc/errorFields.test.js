// A refusal about one input says which one (`field` of the wire error, docs/SPEC.md section 3), so
// the page can put the sentence under that input. A wrong email or password at sign-in is one
// sentence without a field: it never says which of the two was wrong.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError, conflict, forbidden, invalidInput } from "../../src/errors.js";
import { createTestApp, PASSWORD } from "./support.js";

/**
 * What a failed call puts on the wire.
 * @param {Promise<unknown>} promise
 */
async function wireOf(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError);
    return error.toJSON();
  }
  throw new Error("Expected a rejection.");
}

function withAdmin() {
  const app = createTestApp();
  const admin = app.makeUser("admin@example.com", { role: "admin" });
  return { app, admin, ctx: app.contextFor(admin) };
}

test("the wire error has a field only when it was given one", () => {
  assert.deepEqual(forbidden("No.").toJSON(), { code: "forbidden", message: "No." });
  assert.deepEqual(invalidInput("Bad.").toJSON(), { code: "invalidInput", message: "Bad." });
  assert.deepEqual(invalidInput("Bad.", "email").toJSON(), {
    code: "invalidInput",
    message: "Bad.",
    field: "email",
  });
  assert.deepEqual(conflict("Taken.", "email").toJSON(), {
    code: "conflict",
    message: "Taken.",
    field: "email",
  });
});

test("adminCreateUser names email or password", async () => {
  const { app, ctx } = withAdmin();
  const create = (/** @type {Record<string, unknown>} */ input) =>
    wireOf(app.call("adminCreateUser", input, ctx));
  const good = { email: "n@example.com", password: "a long enough pw" };
  assert.equal((await create({ ...good, email: "not an email" })).field, "email");
  assert.equal((await create({ ...good, email: `${"a".repeat(260)}@example.com` })).field, "email");
  assert.equal((await create({ ...good, password: "short" })).field, "password");
  // The same email twice (in any case) is about the email.
  await app.call("adminCreateUser", good, ctx);
  assert.deepEqual(await create({ ...good, email: "N@Example.com" }), {
    code: "conflict",
    message: "An account with this email already exists.",
    field: "email",
  });
  // A missing field is named by the generic validators too.
  assert.equal((await create({ password: "a long enough pw" })).field, "email");
});

test("adminUpdateUser names email or password", async () => {
  const { app, ctx } = withAdmin();
  const user = app.makeUser("u@example.com");
  const update = (/** @type {Record<string, unknown>} */ input) =>
    wireOf(app.call("adminUpdateUser", { id: user.id, ...input }, ctx));
  assert.equal((await update({ email: "nope" })).field, "email");
  assert.equal((await update({ password: "short" })).field, "password");
  assert.equal((await update({ email: "admin@example.com" })).field, "email");
});

test("changePassword names currentPassword or newPassword", async () => {
  const app = createTestApp();
  const user = app.makeUser("u@example.com");
  const ctx = app.contextFor(user);
  const wrong = await wireOf(
    app.call(
      "changePassword",
      { currentPassword: "nope nope nope", newPassword: "a new one 1" },
      ctx,
    ),
  );
  assert.deepEqual(wrong, {
    code: "invalidInput",
    message: "The current password is wrong.",
    field: "currentPassword",
  });
  const weak = await wireOf(
    app.call("changePassword", { currentPassword: PASSWORD, newPassword: "short" }, ctx),
  );
  assert.equal(weak.field, "newPassword");
});

test("setupAdmin names email or password", async () => {
  const app = createTestApp();
  const { setupToken } = await app.setup.ensureFirstAdmin({ env: {} });
  const setup = (/** @type {Record<string, unknown>} */ input) =>
    wireOf(app.call("setupAdmin", { token: setupToken, ...input }, app.contextFor()));
  assert.equal((await setup({ email: "bad", password: "a long enough pw" })).field, "email");
  assert.equal((await setup({ email: "x@example.com", password: "short" })).field, "password");
  // A wrong token is not about an input the person can fix next to a field.
  const refused = await wireOf(
    app.call(
      "setupAdmin",
      { token: "wrong", email: "x@example.com", password: "a long enough pw" },
      app.contextFor(),
    ),
  );
  assert.equal(refused.field, undefined);
});

test("login: a wrong email or password is one sentence without a field", async () => {
  const app = createTestApp();
  app.makeUser("u@example.com");
  for (const attempt of [
    { email: "ghost@example.com", password: PASSWORD },
    { email: "u@example.com", password: "wrong password" },
    { email: "not an email", password: PASSWORD },
    { email: "", password: "" },
  ]) {
    assert.deepEqual(await wireOf(app.call("login", attempt, app.contextFor())), {
      code: "invalidInput",
      message: "Email or password is wrong.",
    });
  }
});

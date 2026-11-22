import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, rejectsWith } from "./support.js";
import { AppError } from "../../src/errors.js";
import {
  array,
  boolean,
  integer,
  object,
  oneOf,
  optional,
  string,
  withDefault,
} from "../../src/rpc/validate.js";

test("an unknown function is notFound", async () => {
  const app = createTestApp();
  await rejectsWith(app.call("noSuchThing", {}, app.contextFor()), "notFound", /noSuchThing/);
});

test("the SPEC functions of this area are registered", () => {
  const names = createTestApp().rpc.names();
  for (const name of [
    "getSession",
    "login",
    "logout",
    "changePassword",
    "setupAdmin",
    "adminListUsers",
    "adminCreateUser",
    "adminUpdateUser",
    "adminDeleteUser",
    "adminGetSettings",
    "adminUpdateSettings",
  ]) {
    assert.ok(names.includes(name), name);
  }
});

test("register adds functions, and each access level is checked", async () => {
  const app = createTestApp();
  app.rpc.register([
    { name: "pub", access: "public", handler: () => "p" },
    { name: "usr", access: "user", handler: () => "u" },
    { name: "adm", access: "admin", handler: () => "a" },
  ]);
  const out = app.contextFor();
  const user = app.contextFor(app.makeUser("u@example.com"));
  const admin = app.contextFor(app.makeUser("a@example.com", { role: "admin" }));

  assert.equal(await app.call("pub", null, out), "p");

  await rejectsWith(app.call("usr", null, out), "unauthenticated");
  assert.equal(await app.call("usr", null, user), "u");
  assert.equal(await app.call("usr", null, admin), "u");

  await rejectsWith(app.call("adm", null, out), "unauthenticated");
  await rejectsWith(app.call("adm", null, user), "forbidden");
  assert.equal(await app.call("adm", null, admin), "a");
});

test("the handler gets the input and the context; missing input is an empty object", async () => {
  const app = createTestApp();
  app.rpc.register([
    { name: "echo", access: "public", handler: (input, ctx) => ({ input, ua: ctx.userAgent }) },
  ]);
  const ctx = app.contextFor();
  assert.deepEqual(await app.call("echo", { a: 1 }, ctx), { input: { a: 1 }, ua: "test-agent" });
  assert.deepEqual(await app.call("echo", undefined, ctx), { input: {}, ua: "test-agent" });
});

test("registering a name twice, or with a bad access level, throws", () => {
  const app = createTestApp();
  assert.throws(
    () => app.rpc.register([{ name: "login", access: "public", handler: () => null }]),
    /registered twice/,
  );
  assert.throws(
    () =>
      app.rpc.register([
        {
          name: "x",
          access: /** @type {"public"} */ (/** @type {unknown} */ ("root")),
          handler: () => null,
        },
      ]),
    /access level/,
  );
});

test("an error that is not an AppError is mapped to one", async () => {
  const app = createTestApp();
  app.rpc.register([
    {
      name: "boom",
      access: "public",
      handler: () => {
        throw new Error("kaboom");
      },
    },
    {
      name: "denied",
      access: "public",
      handler: () => {
        throw new AppError("conflict", "Nope.");
      },
    },
  ]);
  await rejectsWith(app.call("boom", {}, app.contextFor()), "internal", /kaboom/);
  await rejectsWith(app.call("denied", {}, app.contextFor()), "conflict", /^Nope\.$/);
});

// Validators.

/** @param {() => unknown} fn @param {RegExp} message */
const invalid = (fn, message) =>
  assert.throws(fn, (e) => {
    const error = /** @type {{ code: string, message: string }} */ (e);
    return error.code === "invalidInput" && message.test(error.message);
  });

test("string checks type, length and trims on request", () => {
  assert.equal(string({ min: 1, max: 5 })("abc", "name"), "abc");
  assert.equal(string({ trim: true, min: 1 })("  x ", "name"), "x");
  invalid(() => string()(3, "name"), /"name" must be text/);
  invalid(() => string()(undefined, "name"), /"name" is missing/);
  invalid(() => string({ min: 2 })("a", "name"), /at least 2 characters/);
  invalid(() => string({ max: 2 })("abc", "name"), /at most 2 characters/);
  invalid(() => string({ min: 1, max: 2 })("", "name"), /1 to 2 characters/);
  invalid(() => string({ trim: true, min: 1 })("   ", "name"), /"name"/);
});

test("integer refuses fractions, strings and out of range numbers", () => {
  assert.equal(integer({ min: 1, max: 3 })(2, "n"), 2);
  invalid(() => integer()(1.5, "n"), /"n" must be a whole number/);
  invalid(() => integer()("1", "n"), /whole number/);
  invalid(() => integer({ max: 3 })(4, "n"), /between/);
  invalid(() => integer()(null, "n"), /missing/);
});

test("boolean and oneOf", () => {
  assert.equal(boolean(false, "b"), false);
  invalid(() => boolean(0, "b"), /true or false/);
  assert.equal(oneOf(["a", "b"])("b", "o"), "b");
  invalid(() => oneOf(["a", "b"])("c", "o"), /one of a, b/);
});

test("array checks every entry and names its place", () => {
  assert.deepEqual(array(integer())([1, 2], "list"), [1, 2]);
  invalid(() => array(integer())([1, "x"], "list"), /"list\[1\]"/);
  invalid(() => array(integer())("no", "list"), /must be a list/);
  invalid(() => array(integer(), { max: 1 })([1, 2], "list"), /at most 1 entries/);
});

test("object validates fields, names nested paths and refuses unknown fields", () => {
  const check = object({ id: string({ min: 1 }), inner: object({ n: integer() }) });
  assert.deepEqual(check({ id: "a", inner: { n: 1 } }), { id: "a", inner: { n: 1 } });
  invalid(() => check({ id: "a", inner: { n: "x" } }), /"inner.n"/);
  invalid(() => check({ id: "a", inner: { n: 1 }, extra: 1 }), /"extra" is not known/);
  invalid(() => check("text"), /The request must be an object/);
  invalid(() => check([]), /must be an object/);
  invalid(() => check(null), /is missing/);
  assert.deepEqual(object({ a: string() }, { allowUnknown: true })({ a: "x", b: 1 }), { a: "x" });
});

test("optional and withDefault", () => {
  const check = object({
    note: optional(string({ max: 3 })),
    role: withDefault(oneOf(["user", "admin"]), "user"),
    flag: withDefault(boolean, true),
  });
  assert.deepEqual(check({}), { role: "user", flag: true });
  assert.deepEqual(check({ note: null, role: "admin", flag: false }), {
    role: "admin",
    flag: false,
  });
  invalid(() => check({ note: "toolong" }), /"note"/);
});

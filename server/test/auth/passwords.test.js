import { test } from "node:test";
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import {
  dummyVerify,
  hashPassword,
  validateEmail,
  validatePassword,
  verifyPassword,
} from "../../src/auth/passwords.js";

/** @param {() => unknown} fn @param {RegExp} [message] */
const throwsInvalid = (fn, message) =>
  assert.throws(fn, (e) => {
    const error = /** @type {{ code: string, message: string }} */ (e);
    return error.code === "invalidInput" && (!message || message.test(error.message));
  });

test("the stored form is scrypt$32768$8$1$<salt>$<hash> with a 16 and a 32 byte part", async () => {
  const stored = await hashPassword("a good password");
  const parts = stored.split("$");
  assert.equal(parts.length, 6);
  assert.deepEqual(parts.slice(0, 4), ["scrypt", "32768", "8", "1"]);
  assert.equal(Buffer.from(parts[4] ?? "", "base64").length, 16);
  assert.equal(Buffer.from(parts[5] ?? "", "base64").length, 32);
});

test("the hash is real scrypt: it matches an independent computation", async () => {
  const stored = await hashPassword("independent");
  const parts = stored.split("$");
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = scryptSync("independent", salt, 32, { N: 32768, r: 8, p: 1, maxmem: 1 << 27 });
  assert.equal(parts[5], expected.toString("base64"));
});

test("two hashes of the same password differ (random salt)", async () => {
  assert.notEqual(await hashPassword("same"), await hashPassword("same"));
});

test("verify accepts the right password and refuses a wrong one", async () => {
  const stored = await hashPassword("right password");
  assert.equal(await verifyPassword("right password", stored), true);
  assert.equal(await verifyPassword("wrong password", stored), false);
  assert.equal(await verifyPassword("", stored), false);
  assert.equal(await verifyPassword("Right password", stored), false);
});

test("verify handles non-ASCII passwords", async () => {
  const stored = await hashPassword("pässwörd-密码-🔑");
  assert.equal(await verifyPassword("pässwörd-密码-🔑", stored), true);
  assert.equal(await verifyPassword("passwörd-密码-🔑", stored), false);
});

test("unknown or malformed stored values give false, never an exception", async () => {
  const good = await hashPassword("x");
  const parts = good.split("$");
  const malformed = [
    "",
    "plain text",
    "scrypt",
    "scrypt$32768$8$1$AAAA",
    "bcrypt$32768$8$1$" + (parts[4] ?? "") + "$" + (parts[5] ?? ""),
    // Parameters that are not numbers, not powers of two, zero, or enormous.
    ["scrypt", "abc", "8", "1", parts[4], parts[5]].join("$"),
    ["scrypt", "32767", "8", "1", parts[4], parts[5]].join("$"),
    ["scrypt", "0", "8", "1", parts[4], parts[5]].join("$"),
    ["scrypt", "32768", "0", "1", parts[4], parts[5]].join("$"),
    ["scrypt", "32768", "8", "0", parts[4], parts[5]].join("$"),
    ["scrypt", String(2 ** 30), "8", "1", parts[4], parts[5]].join("$"),
    // Not base64, too short, sloppy encoding.
    ["scrypt", "32768", "8", "1", "!!!!", parts[5]].join("$"),
    ["scrypt", "32768", "8", "1", "AAAA", parts[5]].join("$"),
    ["scrypt", "32768", "8", "1", parts[4], "AAAA"].join("$"),
    ["scrypt", "32768", "8", "1", parts[4], (parts[5] ?? "").replace(/=$/, "")].join("$"),
    good + "$extra",
  ];
  for (const stored of malformed) {
    assert.equal(await verifyPassword("x", stored), false, stored);
  }
  assert.equal(
    await verifyPassword("x", /** @type {string} */ (/** @type {unknown} */ (null))),
    false,
  );
  assert.equal(
    await verifyPassword("x", /** @type {string} */ (/** @type {unknown} */ (undefined))),
    false,
  );
});

test("a hash made with other valid parameters still verifies", async () => {
  const salt = Buffer.from("0123456789abcdef");
  const hash = scryptSync("other", salt, 32, { N: 1024, r: 8, p: 2 });
  const stored = [
    "scrypt",
    "1024",
    "8",
    "2",
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
  assert.equal(await verifyPassword("other", stored), true);
  assert.equal(await verifyPassword("nope", stored), false);
});

test("dummyVerify does the work and is always false", async () => {
  assert.equal(await dummyVerify(), false);
});

test("validateEmail trims and lower-cases", () => {
  assert.equal(validateEmail("  Alice@Example.COM "), "alice@example.com");
});

test("validateEmail wants one @ with text on both sides", () => {
  for (const bad of [
    "",
    "alice",
    "@example.com",
    "alice@",
    "a@b@c",
    "al ice@example.com",
    "a@\nb",
  ]) {
    throwsInvalid(() => validateEmail(bad), /valid email/);
  }
  throwsInvalid(() => validateEmail(42));
  throwsInvalid(() => validateEmail(undefined));
});

test("validateEmail allows at most 254 characters", () => {
  const local = "a".repeat(254 - "@x.io".length);
  assert.equal(validateEmail(`${local}@x.io`).length, 254);
  throwsInvalid(() => validateEmail(`${local}a@x.io`), /254/);
});

test("validatePassword wants 8 to 200 characters and does not trim", () => {
  assert.equal(validatePassword("12345678"), "12345678");
  assert.equal(validatePassword("  12 345  "), "  12 345  ");
  assert.equal(validatePassword("x".repeat(200)).length, 200);
  throwsInvalid(() => validatePassword("1234567"), /8 to 200/);
  throwsInvalid(() => validatePassword("x".repeat(201)), /8 to 200/);
  throwsInvalid(() => validatePassword(undefined));
  // Characters, not UTF-16 units: eight emoji are eight characters.
  assert.equal(validatePassword("🔑".repeat(8)).length, 16);
});

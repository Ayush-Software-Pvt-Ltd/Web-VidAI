import { test } from "node:test";
import assert from "node:assert/strict";
import { createThrottle } from "../../src/auth/throttle.js";
import { createFakeClock } from "../rpc/support.js";

const MIN = 60_000;
const who = { email: "a@example.com", address: "10.0.0.1" };

/** @param {ReturnType<typeof createThrottle>} throttle @param {{ email: string, address: string }} w @param {number} n */
const fail = (throttle, w, n) => {
  for (let i = 0; i < n; i += 1) throttle.failure(w);
};

test("four failures do not block, the fifth blocks for 15 minutes", () => {
  const clock = createFakeClock();
  const throttle = createThrottle({ clock });
  fail(throttle, who, 4);
  assert.equal(throttle.check(who), 0);
  throttle.failure(who);
  assert.equal(throttle.check(who), 15 * MIN);
  clock.advance(10 * MIN);
  assert.equal(throttle.check(who), 5 * MIN);
  clock.advance(5 * MIN);
  assert.equal(throttle.check(who), 0);
});

test("after the block ends the counting starts again from zero", () => {
  const clock = createFakeClock();
  const throttle = createThrottle({ clock });
  fail(throttle, who, 5);
  clock.advance(15 * MIN);
  fail(throttle, who, 4);
  assert.equal(throttle.check(who), 0);
  throttle.failure(who);
  assert.ok(throttle.check(who) > 0);
});

test("failures older than 15 minutes do not count", () => {
  const clock = createFakeClock();
  const throttle = createThrottle({ clock });
  fail(throttle, who, 4);
  clock.advance(15 * MIN);
  throttle.failure(who);
  assert.equal(throttle.check(who), 0);
});

test("the same email is blocked from another address", () => {
  const clock = createFakeClock();
  const throttle = createThrottle({ clock });
  for (let i = 0; i < 5; i += 1) throttle.failure({ email: who.email, address: `10.0.0.${i}` });
  assert.ok(throttle.check({ email: who.email, address: "10.9.9.9" }) > 0);
  assert.equal(throttle.check({ email: "other@example.com", address: "10.9.9.9" }), 0);
});

test("the same address is blocked for other emails", () => {
  const clock = createFakeClock();
  const throttle = createThrottle({ clock });
  for (let i = 0; i < 5; i += 1)
    throttle.failure({ email: `user${i}@example.com`, address: who.address });
  assert.ok(throttle.check({ email: "fresh@example.com", address: who.address }) > 0);
  assert.equal(throttle.check({ email: "fresh@example.com", address: "10.7.7.7" }), 0);
});

test("a success clears the email's failures but not the address's", () => {
  const clock = createFakeClock();
  const throttle = createThrottle({ clock });
  fail(throttle, who, 4);
  throttle.success(who);
  throttle.failure(who);
  // The email key started over (1 failure), the address key is now at 5 and blocks.
  assert.ok(throttle.check({ email: "x@example.com", address: who.address }) > 0);
  assert.equal(throttle.check({ email: who.email, address: "10.7.7.7" }), 0);
});

test("a successful login for another email does not clear an attacked one", () => {
  const clock = createFakeClock();
  const throttle = createThrottle({ clock });
  fail(throttle, who, 5);
  throttle.success({ email: "other@example.com" });
  assert.ok(throttle.check(who) > 0);
});

test("memory is bounded", () => {
  const clock = createFakeClock();
  const throttle = createThrottle({ clock, maxKeys: 50 });
  for (let i = 0; i < 500; i += 1) {
    throttle.failure({ email: `user${i}@example.com`, address: `10.0.${i >> 8}.${i & 255}` });
  }
  assert.ok(throttle.size <= 50, `size ${throttle.size}`);
});

test("blocked keys survive trimming while idle ones are dropped first", () => {
  const clock = createFakeClock();
  const throttle = createThrottle({ clock, maxKeys: 20 });
  fail(throttle, who, 5);
  for (let i = 0; i < 100; i += 1) {
    throttle.failure({ email: `user${i}@example.com`, address: `10.0.0.${i}` });
  }
  assert.ok(throttle.size <= 20);
  assert.ok(throttle.check(who) > 0);
});

test("the numbers can be changed", () => {
  const clock = createFakeClock();
  const throttle = createThrottle({ clock, maxFailures: 2, blockMs: MIN });
  fail(throttle, who, 2);
  assert.equal(throttle.check(who), MIN);
});

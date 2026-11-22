import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTestApp } from "../rpc/support.js";
import { IDLE_EXPIRY_MS, TOUCH_INTERVAL_MS } from "../../src/auth/sessions.js";

const META = { address: "10.1.1.1", userAgent: "agent" };
const DAY = 24 * 60 * 60 * 1000;

test("a created session authenticates by its token", () => {
  const app = createTestApp();
  const user = app.makeUser("a@example.com", { role: "admin" });
  const { id, token } = app.sessions.create(user.id, META);
  assert.deepEqual(app.sessions.authenticate(token, META), {
    id,
    user: { id: user.id, email: "a@example.com", role: "admin" },
  });
});

test("the token is 32 random bytes in base64url and only its SHA-256 is stored", () => {
  const app = createTestApp();
  const user = app.makeUser("a@example.com");
  const { id, token } = app.sessions.create(user.id, META);
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const row = app.db.get("SELECT id, token_hash FROM sessions");
  assert.equal(row?.token_hash, createHash("sha256").update(token).digest("hex"));
  assert.notEqual(row?.id, token);
  assert.equal(row?.id, id);
  assert.notEqual(app.sessions.create(user.id, META).token, token);
});

test("unknown, empty and absurd tokens give null", () => {
  const app = createTestApp();
  app.makeUser("a@example.com");
  for (const token of ["", "nope", "x".repeat(43), "x".repeat(500)]) {
    assert.equal(app.sessions.authenticate(token, META), null);
  }
});

test("a session ends after 30 days without use", () => {
  const app = createTestApp();
  const user = app.makeUser("a@example.com");
  const { token } = app.sessions.create(user.id, META);
  app.clock.advance(IDLE_EXPIRY_MS - 1);
  assert.ok(app.sessions.authenticate(token, META));
  // Use renewed it: another 30 days minus a bit still works.
  app.clock.advance(IDLE_EXPIRY_MS - 1);
  assert.ok(app.sessions.authenticate(token, META));
  app.clock.advance(IDLE_EXPIRY_MS + 1);
  assert.equal(app.sessions.authenticate(token, META), null);
  assert.equal(app.sessionsRepo.countByUser(user.id), 0, "the expired row is removed");
});

test("last_used_at is updated at most once a minute", () => {
  const app = createTestApp();
  const user = app.makeUser("a@example.com");
  const { token } = app.sessions.create(user.id, META);
  const created = app.clock.now();
  const lastUsed = () => Number(app.db.get("SELECT last_used_at AS t FROM sessions")?.t);

  app.clock.advance(TOUCH_INTERVAL_MS - 1);
  app.sessions.authenticate(token, META);
  assert.equal(lastUsed(), created);

  app.clock.advance(1);
  app.sessions.authenticate(token, { address: "10.9.9.9", userAgent: "new agent" });
  assert.equal(lastUsed(), created + TOUCH_INTERVAL_MS);
  assert.equal(app.db.get("SELECT address FROM sessions")?.address, "10.9.9.9");

  app.clock.advance(30_000);
  app.sessions.authenticate(token, META);
  assert.equal(lastUsed(), created + TOUCH_INTERVAL_MS);
});

test("the account's last-seen time follows its sessions", () => {
  const app = createTestApp();
  const user = app.makeUser("a@example.com");
  assert.equal(app.users.byId(user.id)?.lastSeenAt, null);
  const { token } = app.sessions.create(user.id, META);
  assert.equal(app.users.byId(user.id)?.lastSeenAt, app.clock.now());
  app.clock.advance(5 * 60_000);
  app.sessions.authenticate(token, META);
  assert.equal(app.users.byId(user.id)?.lastSeenAt, app.clock.now());
});

test("a disabled account gives null, and so does a deleted one", () => {
  const app = createTestApp();
  const user = app.makeUser("a@example.com");
  const { token } = app.sessions.create(user.id, META);
  app.users.update(user.id, { disabled: true });
  assert.equal(app.sessions.authenticate(token, META), null);
  app.users.update(user.id, { disabled: false });
  assert.ok(app.sessions.authenticate(token, META));
  app.users.delete(user.id);
  assert.equal(app.sessions.authenticate(token, META), null);
});

test("end removes one session only", () => {
  const app = createTestApp();
  const user = app.makeUser("a@example.com");
  const first = app.sessions.create(user.id, META);
  const second = app.sessions.create(user.id, META);
  assert.equal(app.sessions.end(first.id), true);
  assert.equal(app.sessions.end(first.id), false);
  assert.equal(app.sessions.authenticate(first.token, META), null);
  assert.ok(app.sessions.authenticate(second.token, META));
});

test("endAllOfUser ends every session, or all but one, of that account only", () => {
  const app = createTestApp();
  const user = app.makeUser("a@example.com");
  const other = app.makeUser("b@example.com");
  const a1 = app.sessions.create(user.id, META);
  const a2 = app.sessions.create(user.id, META);
  const b1 = app.sessions.create(other.id, META);
  assert.equal(app.sessions.endAllOfUser(user.id, a1.id), 1);
  assert.ok(app.sessions.authenticate(a1.token, META));
  assert.equal(app.sessions.authenticate(a2.token, META), null);
  assert.equal(app.sessions.endAllOfUser(user.id), 1);
  assert.equal(app.sessions.countOfUser(user.id), 0);
  assert.ok(app.sessions.authenticate(b1.token, META));
});

test("purgeExpired removes only sessions idle for more than 30 days", () => {
  const app = createTestApp();
  const user = app.makeUser("a@example.com");
  app.sessions.create(user.id, META);
  app.clock.advance(20 * DAY);
  const fresh = app.sessions.create(user.id, META);
  app.clock.advance(11 * DAY);
  assert.equal(app.sessions.purgeExpired(), 1);
  assert.ok(app.sessions.authenticate(fresh.token, META));
  assert.equal(app.sessions.countOfUser(user.id), 1);
});

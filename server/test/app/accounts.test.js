// Accounts, events and settings through a real app (SPEC sections 4, 5 and 14).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, startApp, within } from "./support.js";

const ENV = { VIDAI_ADMIN_EMAIL: ADMIN_EMAIL, VIDAI_ADMIN_PASSWORD: ADMIN_PASSWORD };
const USER_EMAIL = "user@example.com";
const USER_PASSWORD = "user-password-for-tests";

/** @param {Awaited<ReturnType<typeof startApp>>} t */
async function adminClient(t) {
  const admin = t.client();
  const login = await admin.rpc("login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  assert.equal(login.status, 200);
  return admin;
}

test("an admin creates a user; the user is not an admin; deleting the user ends stream and cookie", async () => {
  const t = await startApp({ env: ENV });
  try {
    const admin = await adminClient(t);
    const created = await admin.rpc("adminCreateUser", {
      email: USER_EMAIL,
      password: USER_PASSWORD,
    });
    assert.equal(created.status, 200);
    const userId = created.json.id;

    const user = t.client();
    const login = await user.rpc("login", { email: USER_EMAIL, password: USER_PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.json.user.role, "user");
    assert.equal((await user.rpc("getSession")).json.user.email, USER_EMAIL);
    assert.notEqual(user.sessionCookie, admin.sessionCookie);

    const forbidden = await user.rpc("adminListUsers");
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json.code, "forbidden");
    assert.equal((await admin.rpc("adminListUsers")).json.length, 2);

    const stream = await user.openStream();
    assert.equal(stream.status, 200);
    await within(stream.next("hello"), "the hello event");

    const removed = await admin.rpc("adminDeleteUser", { id: userId });
    assert.equal(removed.status, 200);
    await within(stream.ended, "the user's event stream to end");
    const ended = stream.messages().find((message) => message.event === "session-ended");
    assert.equal(ended?.payload.reason, "removed");

    const stale = await user.rpc("getSession");
    assert.equal(stale.json.user, null, "the deleted user's cookie no longer authenticates");
    assert.equal((await user.rpc("getSession")).status, 200);
    assert.equal((await user.rpc("adminListUsers")).status, 401);
  } finally {
    await t.close();
  }
});

test("a settings update by the admin reaches a signed-in user's stream as settings-changed", async () => {
  const t = await startApp({ env: ENV });
  try {
    const admin = await adminClient(t);
    await admin.rpc("adminCreateUser", { email: USER_EMAIL, password: USER_PASSWORD });
    const user = t.client();
    await user.rpc("login", { email: USER_EMAIL, password: USER_PASSWORD });
    const stream = await user.openStream();
    await within(stream.next("hello"), "the hello event");

    const update = await admin.rpc("adminUpdateSettings", { maxEditsPerUser: 3 });
    assert.equal(update.status, 200);
    assert.equal(update.json.maxEditsPerUser, 3);

    const payload = await within(stream.next("settings-changed"), "settings-changed");
    assert.equal(payload.maxEditsPerUser, 3);
    assert.equal(payload.maxEdits, undefined, "users only get the public part");
    assert.equal((await user.rpc("adminGetSettings")).status, 403);
  } finally {
    await t.close();
  }
});

test("expired sessions are purged on the interval", async () => {
  /** @type {{ now: number }} */
  const time = { now: Date.now() };
  const t = await startApp({
    env: ENV,
    clock: { now: () => time.now },
    options: { purgeIntervalMs: 5 },
  });
  try {
    const admin = await adminClient(t);
    const user = t.app.users.byEmail(ADMIN_EMAIL);
    assert.ok(user);
    assert.equal(t.app.sessions.countOfUser(user.id), 1);
    time.now += 31 * 24 * 60 * 60 * 1000;
    const deadline = Date.now() + 5000;
    while (t.app.sessions.countOfUser(user.id) > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(t.app.sessions.countOfUser(user.id), 0);
    assert.equal((await admin.rpc("getSession")).json.user, null);
  } finally {
    await t.close();
  }
});

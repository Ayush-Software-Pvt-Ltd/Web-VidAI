// The first-run story and the login flow through a real app over HTTPS (SPEC sections 2 and 4).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, startApp } from "./support.js";

test("first run: setup token, one-time setupAdmin, cookie, no second setup", async () => {
  const t = await startApp();
  try {
    assert.match(t.info.setupUrl ?? "", /^https:\/\/localhost:\d+\/setup#[\w-]{40,}$/);
    assert.ok(t.info.port > 0);
    assert.equal(t.info.adminCreatedFromEnv, null);
    assert.ok(t.info.addresses.some((address) => address.endsWith(`:${t.info.port}`)));
    const token = /#(.+)$/.exec(t.info.setupUrl ?? "")?.[1];

    const admin = t.client();
    const before = await admin.rpc("getSession");
    assert.equal(before.status, 200);
    assert.equal(before.json.needsSetup, true);
    assert.equal(before.json.user, null);

    const refused = await admin.rpc("setupAdmin", {
      token: "wrong",
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    assert.equal(refused.status, 403);

    const made = await admin.rpc("setupAdmin", {
      token,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    assert.equal(made.status, 200);
    assert.equal(made.json.user.role, "admin");
    assert.ok(admin.sessionCookie, "setupAdmin signs the new admin in");

    const after = await admin.rpc("getSession");
    assert.equal(after.json.user.email, ADMIN_EMAIL);
    assert.equal(after.json.needsSetup, false);

    const again = await t.client().rpc("setupAdmin", {
      token,
      email: "second@example.com",
      password: ADMIN_PASSWORD,
    });
    assert.equal(again.status, 403);
    assert.equal(t.app.users.countEnabledAdmins(), 1);

    // The UI is served by the same server: the page, and index.html for unknown paths.
    const page = await admin.request("GET", "/setup");
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>VidAI<\/title>/);
  } finally {
    await t.close();
  }
});

test("an admin from the environment: no setup address, login works, the password is not logged", async () => {
  const t = await startApp({
    env: { VIDAI_ADMIN_EMAIL: ADMIN_EMAIL, VIDAI_ADMIN_PASSWORD: ADMIN_PASSWORD },
  });
  try {
    assert.equal(t.info.setupUrl, null);
    assert.equal(t.info.adminCreatedFromEnv, ADMIN_EMAIL);
    const client = t.client();
    assert.equal((await client.rpc("getSession")).json.needsSetup, false);

    const wrong = await client.rpc("login", { email: ADMIN_EMAIL, password: "nope-nope-nope" });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.message, "Email or password is wrong.");

    const login = await client.rpc("login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.json.user.role, "admin");
    assert.equal((await client.rpc("getSession")).json.user.email, ADMIN_EMAIL);

    await client.rpc("logout");
    assert.equal(client.sessionCookie, undefined);
    assert.equal((await client.rpc("getSession")).json.user, null);

    const log = fs.readFileSync(t.app.paths.serverLog, "utf8");
    assert.match(log, /Created the admin account admin@example\.com from the environment/);
    assert.ok(!log.includes(ADMIN_PASSWORD), "the password is nowhere in the log");
    assert.ok(!t.app.users.byEmail(ADMIN_EMAIL)?.passwordHash.includes(ADMIN_PASSWORD));
  } finally {
    await t.close();
  }
});

test("changing requests without X-VidAI: 1 are refused end to end", async () => {
  const t = await startApp({
    env: { VIDAI_ADMIN_EMAIL: ADMIN_EMAIL, VIDAI_ADMIN_PASSWORD: ADMIN_PASSWORD },
  });
  try {
    const client = t.client();
    const body = JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const noHeader = await client.request("POST", "/api/rpc/login", {
      headers: { "Content-Type": "application/json", Origin: client.origin },
      body,
    });
    assert.equal(noHeader.status, 403);
    assert.equal(client.sessionCookie, undefined, "a refused login signs nobody in");

    const foreignOrigin = await client.request("POST", "/api/rpc/login", {
      headers: {
        "Content-Type": "application/json",
        "X-VidAI": "1",
        Origin: "https://evil.example",
      },
      body,
    });
    assert.equal(foreignOrigin.status, 403);

    assert.equal((await client.rpc("login", JSON.parse(body))).status, 200);
    const signedInNoHeader = await client.request("POST", "/api/rpc/adminListUsers", {
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(signedInNoHeader.status, 403);
  } finally {
    await t.close();
  }
});

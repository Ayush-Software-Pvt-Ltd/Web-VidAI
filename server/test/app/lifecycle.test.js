// Restart, stop and modules of the composition root.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ADMIN_EMAIL, ADMIN_PASSWORD, startApp, within } from "./support.js";

const ENV = { VIDAI_ADMIN_EMAIL: ADMIN_EMAIL, VIDAI_ADMIN_PASSWORD: ADMIN_PASSWORD };

/** @param {number} port @returns {Promise<boolean>} Whether something accepts connections. */
function portAnswers(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

test("a restart on the same data directory keeps accounts and sessions and reuses the certificate", async () => {
  const first = await startApp({ env: ENV });
  /** @type {Awaited<ReturnType<typeof startApp>> | null} */
  let second = null;
  try {
    const client = first.client();
    await client.rpc("login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const cookie = client.sessionCookie;
    assert.ok(cookie);
    await first.app.stop();

    second = await startApp({ dataDir: first.dataDir, env: ENV });
    assert.equal(second.fingerprint, first.fingerprint, "the certificate is reused");
    assert.equal(second.info.setupUrl, null);
    assert.equal(second.info.adminCreatedFromEnv, null, "the admin already exists");
    assert.equal(second.app.users.countEnabledAdmins(), 1);

    const again = second.client();
    again.jar.set("vidai_session", cookie);
    const session = await again.rpc("getSession");
    assert.equal(session.json.user.email, ADMIN_EMAIL);
    assert.equal((await again.rpc("adminListUsers")).status, 200);
  } finally {
    await second?.close();
    await first.close();
  }
});

test("stop twice returns promptly with an open stream; the port and the database are free after", async () => {
  const t = await startApp({ env: ENV });
  try {
    const client = t.client();
    await client.rpc("login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    const stream = await client.openStream();
    await within(stream.next("hello"), "the hello event");
    assert.equal(await portAnswers(t.info.port), true);

    const started = Date.now();
    const [one, two] = await within(
      Promise.all([t.app.stop(), t.app.stop()]),
      "stop() to finish",
      4000,
    );
    assert.equal(one, undefined);
    assert.equal(two, undefined);
    await within(stream.ended, "the event stream to end");
    await t.app.stop();
    assert.ok(Date.now() - started < 2500, "stop does not wait for the open stream");

    assert.equal(await portAnswers(t.info.port), false, "the port is free");
    const db = new DatabaseSync(t.app.paths.db);
    try {
      db.exec("BEGIN IMMEDIATE; COMMIT;");
      const row = /** @type {{ n: number }} */ (
        db.prepare("SELECT COUNT(*) AS n FROM users").get()
      );
      assert.equal(row.n, 1);
    } finally {
      db.close();
    }
  } finally {
    await t.close();
  }
});

test("stop releases the data directory lock, also when start was never called", async () => {
  const { acquireLock, loadConfig } = await import("../../src/config.js");
  const { createApp } = await import("../../src/app.js");
  const { tempDir, makeUiDist } = await import("./support.js");
  const root = tempDir();
  try {
    const config = loadConfig({
      argv: ["--port", "0", "--host", "127.0.0.1", "--data", `${root}/data`],
      env: { VIDAI_UI_DIST: makeUiDist(root) },
      home: root,
    });
    const lockFile = `${root}/data/server.lock`;
    fs.mkdirSync(`${root}/data`, { recursive: true });
    const lock = acquireLock(lockFile, { releaseOnExit: false });
    assert.ok(fs.existsSync(lockFile));
    const app = createApp({ config, env: { VIDAI_SECRETS: "memory" }, options: { lock } });
    await app.stop();
    await app.stop();
    assert.ok(!fs.existsSync(lockFile), "the lock file is gone");
    await assert.rejects(app.start(), /already started/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failing start undoes itself: the port in use frees the database and stops the modules", async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = blocker.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const { createApp } = await import("../../src/app.js");
  const { loadConfig } = await import("../../src/config.js");
  const { tempDir, makeUiDist } = await import("./support.js");
  const root = tempDir();
  /** @type {string[]} */
  const calls = [];
  try {
    const config = loadConfig({
      argv: ["--port", String(port), "--host", "127.0.0.1", "--data", `${root}/data`],
      env: { VIDAI_UI_DIST: makeUiDist(root) },
      home: root,
    });
    const app = createApp({
      config,
      env: { VIDAI_SECRETS: "memory" },
      options: {
        modules: [
          {
            name: "probe",
            start: () => {
              calls.push("start");
            },
            stop: () => {
              calls.push("stop");
            },
          },
        ],
      },
    });
    await assert.rejects(app.start(), /already in use/);
    assert.deepEqual(calls, ["start", "stop"]);
    const db = new DatabaseSync(`${root}/data/vidai.db`);
    db.exec("BEGIN IMMEDIATE; COMMIT;");
    db.close();
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a module gets its rpc functions, routes, hooks and start and stop in the right order", async () => {
  /** @type {string[]} */
  const calls = [];
  /** @param {string} name */
  const probe = (name) => ({
    name,
    rpc: [
      {
        name: `${name}Ping`,
        /** @type {"user"} */ access: "user",
        handler: () => ({ from: name }),
      },
    ],
    routes: [
      {
        /** @type {"GET"} */ method: "GET",
        path: `/api/${name}`,
        /** @type {"session"} */ auth: "session",
        handler: (/** @type {any} */ _req, /** @type {any} */ res) => {
          res.setHeader("Content-Type", "text/plain");
          res.end(`route of ${name}`);
        },
      },
    ],
    hooks: {
      activeJobCount: () => (name === "alpha" ? 2 : 3),
      onUserRemoved: () => {
        calls.push(`removed:${name}`);
      },
    },
    start: () => {
      calls.push(`start:${name}`);
    },
    stop: () => {
      calls.push(`stop:${name}`);
    },
  });
  /** @type {import("../../src/app.js").AppContext | null} */
  let seen = null;
  const t = await startApp({
    env: ENV,
    options: {
      modules: [
        probe("alpha"),
        (context) => {
          seen = context;
          return probe("beta");
        },
      ],
    },
  });
  try {
    assert.ok(seen && /** @type {any} */ (seen).db === t.app.db, "a factory gets the context");
    assert.deepEqual(calls, ["start:alpha", "start:beta"]);
    const admin = t.client();
    await admin.rpc("login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    assert.deepEqual((await admin.rpc("alphaPing")).json, { from: "alpha" });
    assert.deepEqual((await admin.rpc("betaPing")).json, { from: "beta" });
    assert.equal((await admin.request("GET", "/api/beta")).text, "route of beta");
    assert.equal((await t.client().request("GET", "/api/alpha")).status, 401);

    await admin.rpc("adminCreateUser", { email: "user@example.com", password: "user-password-1" });
    const list = await admin.rpc("adminListUsers");
    const account = list.json.find((/** @type {any} */ item) => item.email === "user@example.com");
    assert.equal(account.activeJobs, 5, "the job counts of every module add up");
    await admin.rpc("adminDeleteUser", { id: account.id });
    assert.deepEqual(calls.slice(2), ["removed:alpha", "removed:beta"]);

    await t.app.stop();
    assert.deepEqual(calls.slice(4), ["stop:beta", "stop:alpha"], "stopped in reverse order");
  } finally {
    await t.close();
  }
});

test("registering the same rpc name twice is refused when the app is built", async () => {
  const dup = {
    name: "dup",
    rpc: [{ name: "getSession", access: /** @type {const} */ ("public"), handler: () => null }],
  };
  await assert.rejects(startApp({ options: { modules: [dup] } }), /registered twice/);
});

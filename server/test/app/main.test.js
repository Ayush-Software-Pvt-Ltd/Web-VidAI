// The executable: `node server/src/main.js` as a child process (SPEC section 2).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ADMIN_EMAIL, makeClient, makeUiDist, tempDir, within } from "./support.js";

const MAIN = fileURLToPath(new URL("../../src/main.js", import.meta.url));
const NEW_PASSWORD = "brand-new-password-1";

/**
 * Start the executable. The caller stops it; `children` is cleaned up by `finish`.
 * @param {string[]} args
 * @param {{ env?: Record<string, string>, stdin?: string }} [options]
 */
function run(args, { env = {}, stdin } = {}) {
  const outer = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("VIDAI_")),
  );
  const child = spawn(process.execPath, [MAIN, ...args], {
    env: { ...outer, VIDAI_SECRETS: "memory", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  /** @type {Set<() => void>} */
  const waiters = new Set();
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
    for (const wake of [...waiters]) wake();
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {});
  child.stdin.end(stdin ?? "");
  const exited = /** @type {Promise<number | null>} */ (
    new Promise((resolve) => {
      child.once("close", (code) => {
        resolve(code);
      });
    })
  );
  return {
    child,
    exited,
    out: () => stdout,
    err: () => stderr,
    /** @param {RegExp} pattern @returns {Promise<RegExpExecArray>} */
    printed(pattern) {
      return within(
        new Promise((resolve) => {
          const check = () => {
            const match = pattern.exec(stdout);
            if (!match) return;
            waiters.delete(check);
            resolve(match);
          };
          waiters.add(check);
          check();
        }),
        `${pattern} on the server's output (got: ${stdout.slice(-300)} ${stderr.slice(-300)})`,
        15000,
      );
    },
  };
}

/** A temporary data directory and UI, with `cleanup` that also kills the children. */
function sandbox() {
  const root = tempDir();
  /** @type {ReturnType<typeof run>[]} */
  const children = [];
  const env = {
    VIDAI_DATA_DIR: path.join(root, "data"),
    VIDAI_UI_DIST: makeUiDist(root),
  };
  return {
    root,
    env,
    /** @param {string[]} args @param {{ stdin?: string, env?: Record<string, string> }} [options] */
    start(args, options = {}) {
      const process = run(args, { ...options, env: { ...env, ...options.env } });
      children.push(process);
      return process;
    },
    async cleanup() {
      for (const one of children) one.child.kill("SIGKILL");
      await Promise.all(children.map((one) => one.exited));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("-h prints the usage and exits 0", async () => {
  const box = sandbox();
  try {
    const run1 = box.start(["-h"]);
    assert.equal(await within(run1.exited, "-h to exit"), 0);
    assert.match(run1.out(), /Usage: node server\/src\/main\.js/);
    assert.match(run1.out(), /admin-reset --email/);
    assert.equal(run1.err(), "");
    assert.ok(!fs.existsSync(box.env.VIDAI_DATA_DIR), "help touches no data directory");
  } finally {
    await box.cleanup();
  }
});

test("a bad option, a bad port and an unknown command exit 2", async () => {
  const box = sandbox();
  try {
    for (const args of [
      ["--bogus", "x"],
      ["--port", "99999"],
      ["--port"],
      ["frobnicate"],
      ["admin-reset"],
    ]) {
      const one = box.start(args);
      assert.equal(await within(one.exited, `${args.join(" ")} to exit`), 2, args.join(" "));
      assert.match(one.err(), /-h/);
    }
  } finally {
    await box.cleanup();
  }
});

test("it prints an address (port 0 accepted) and the setup address; a second instance exits 1; SIGINT exits 0", async () => {
  const box = sandbox();
  try {
    const first = box.start(["--port", "0", "--host", "127.0.0.1"]);
    const address = await first.printed(/^ {2}(https:\/\/127\.0\.0\.1:(\d+))$/m);
    const port = Number(address[2]);
    assert.ok(port > 0);
    const setup = await first.printed(/^ {2}(https:\/\/localhost:(\d+)\/setup#[\w-]+)$/m);
    assert.equal(Number(setup[2]), port, "the setup address has the real port");
    assert.ok(!first.err().includes("ExperimentalWarning"), first.err());

    // The printed address answers (the certificate is the one in the data directory).
    const client = makeClient(
      port,
      fs.readFileSync(path.join(box.env.VIDAI_DATA_DIR, "tls/cert.pem")),
    );
    assert.equal((await client.rpc("getSession")).json.needsSetup, true);

    const second = box.start(["--port", "0", "--host", "127.0.0.1"]);
    assert.equal(await within(second.exited, "the second instance to exit", 10000), 1);
    assert.match(
      second.err(),
      /Another VidAI Server \(process \d+\) is already using this data folder\./,
    );
    assert.equal(second.out(), "");

    first.child.kill("SIGINT");
    assert.equal(await within(first.exited, "SIGINT to stop the server", 10000), 0);
    assert.ok(
      !fs.existsSync(path.join(box.env.VIDAI_DATA_DIR, "server.lock")),
      "the lock file is released",
    );
  } finally {
    await box.cleanup();
  }
});

test("with an admin from the environment it says so without the password", async () => {
  const box = sandbox();
  const password = "never-print-this-password";
  try {
    const one = box.start(["--port", "0", "--host", "127.0.0.1"], {
      env: { VIDAI_ADMIN_EMAIL: ADMIN_EMAIL, VIDAI_ADMIN_PASSWORD: password },
    });
    await one.printed(/was created from VIDAI_ADMIN_EMAIL and VIDAI_ADMIN_PASSWORD/);
    assert.ok(!one.out().includes("/setup#"));
    assert.ok(!one.out().includes(password));
    assert.ok(!one.err().includes(password));
    one.child.kill("SIGTERM");
    assert.equal(await within(one.exited, "SIGTERM to stop the server", 10000), 0);
  } finally {
    await box.cleanup();
  }
});

test("admin-reset reads the password from stdin, changes it and never prints it", async () => {
  const box = sandbox();
  const oldPassword = "the-old-admin-password";
  try {
    const env = { VIDAI_ADMIN_EMAIL: ADMIN_EMAIL, VIDAI_ADMIN_PASSWORD: oldPassword };
    const created = box.start(["--port", "0", "--host", "127.0.0.1"], { env });
    await created.printed(/was created from/);
    created.child.kill("SIGINT");
    assert.equal(await within(created.exited, "the first server to stop", 10000), 0);

    const missing = box.start(["admin-reset", "--email", "nobody@example.com"], {
      stdin: `${NEW_PASSWORD}\n`,
    });
    assert.equal(await within(missing.exited, "admin-reset to exit"), 1);
    assert.match(missing.err(), /no admin account with this email/);

    const reset = box.start(["admin-reset", "--email", ADMIN_EMAIL], {
      stdin: `${NEW_PASSWORD}\n`,
    });
    assert.equal(await within(reset.exited, "admin-reset to exit"), 0);
    assert.match(reset.out(), /password of admin@example\.com was changed/);
    assert.ok(!reset.out().includes(NEW_PASSWORD) && !reset.err().includes(NEW_PASSWORD));

    const tooShort = box.start(["admin-reset", "--email", ADMIN_EMAIL], { stdin: "short\n" });
    assert.equal(await within(tooShort.exited, "admin-reset to exit"), 1);

    // A fresh instance (without the environment admin): the new password logs in, the old one not.
    const again = box.start(["--port", "0", "--host", "127.0.0.1"]);
    const address = await again.printed(/^ {2}https:\/\/127\.0\.0\.1:(\d+)$/m);
    const client = makeClient(
      Number(address[1]),
      fs.readFileSync(path.join(box.env.VIDAI_DATA_DIR, "tls/cert.pem")),
    );
    const old = await client.rpc("login", { email: ADMIN_EMAIL, password: oldPassword });
    assert.equal(old.status, 400);
    const login = await client.rpc("login", { email: ADMIN_EMAIL, password: NEW_PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.json.user.role, "admin");
    assert.ok(!again.out().includes("/setup#"), "an admin exists, so there is no setup address");
    again.child.kill("SIGINT");
    assert.equal(await within(again.exited, "the server to stop", 10000), 0);

    const log = fs.readFileSync(path.join(box.env.VIDAI_DATA_DIR, "server.log"), "utf8");
    assert.ok(!log.includes(NEW_PASSWORD) && !log.includes(oldPassword));
  } finally {
    await box.cleanup();
  }
});

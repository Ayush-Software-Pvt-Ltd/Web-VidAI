import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { acquireLock, processIsAlive } from "../../src/config.js";

describe("single-instance lock", () => {
  /** @type {string} */
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-lock-"));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = () => path.join(dir, "server.lock");
  const options = { releaseOnExit: false };

  test("writes the process id and removes the file on release", () => {
    const lock = acquireLock(file(), { ...options, pid: 4242 });
    assert.equal(fs.readFileSync(file(), "utf8").trim(), "4242");
    lock.release();
    assert.ok(!fs.existsSync(file()));
    lock.release();
  });

  test("a second holder is refused while the first is alive", () => {
    const first = acquireLock(file(), { ...options, pid: 100, isAlive: () => true });
    assert.throws(() => acquireLock(file(), { ...options, pid: 200, isAlive: () => true }), {
      code: "conflict",
      message: /process 100/,
    });
    assert.equal(fs.readFileSync(file(), "utf8").trim(), "100");
    first.release();
  });

  test("the lock of a dead process is taken over", () => {
    fs.writeFileSync(file(), "999999\n");
    const lock = acquireLock(file(), { ...options, pid: 200, isAlive: () => false });
    assert.equal(fs.readFileSync(file(), "utf8").trim(), "200");
    lock.release();
    assert.ok(!fs.existsSync(file()));
  });

  test("a lock file with garbage in it is stale", () => {
    for (const text of ["", "not a number", "-5", "0"]) {
      fs.writeFileSync(file(), text);
      const lock = acquireLock(file(), { ...options, pid: 7, isAlive: () => true });
      assert.equal(fs.readFileSync(file(), "utf8").trim(), "7", JSON.stringify(text));
      lock.release();
    }
  });

  test("releasing after a takeover does not remove the new holder's lock", () => {
    const old = acquireLock(file(), { ...options, pid: 1, isAlive: () => false });
    fs.writeFileSync(file(), "2\n");
    old.release();
    assert.equal(fs.readFileSync(file(), "utf8").trim(), "2");
    fs.rmSync(file());
  });

  test("a lock that cannot be written is an io error", () => {
    assert.throws(() => acquireLock(path.join(dir, "missing", "server.lock"), options), {
      code: "io",
    });
  });

  test("with the real process check: ours is alive, a finished child is not", async () => {
    assert.equal(processIsAlive(process.pid), true);
    const child = spawn(process.execPath, ["-e", "0"]);
    const pid = child.pid ?? 0;
    await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(processIsAlive(pid), false);
    // Our own process id is alive, so a second holder in this process is refused.
    const first = acquireLock(file(), options);
    assert.throws(() => acquireLock(file(), options), { code: "conflict" });
    first.release();
    fs.writeFileSync(file(), `${pid}\n`);
    acquireLock(file(), options).release();
  });

  test("the lock is released when the process exits", async () => {
    const script = `
      import { acquireLock } from ${JSON.stringify(new URL("../../src/config.js", import.meta.url).href)};
      acquireLock(${JSON.stringify(file())});
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: "ignore",
    });
    await new Promise((resolve) => child.on("exit", resolve));
    assert.ok(!fs.existsSync(file()));
  });
});

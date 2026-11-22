import assert from "node:assert/strict";
import https from "node:https";
import nodeTls from "node:tls";
import path from "node:path";
import { describe, test } from "node:test";
import { createEventBus } from "../../src/events.js";
import { listAddresses, localIdentity } from "../../src/http/addresses.js";
import { createHttpServer } from "../../src/http/server.js";
import { createLogger } from "../../src/log.js";
import { openStream, startServer, tempDir } from "./support.js";
import fs from "node:fs";
import { ensureCertificate } from "../../src/http/tls.js";

/** @param {number} ms */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("slow and broken clients", () => {
  test("a client that never finishes its headers is cut off", async () => {
    const t = await startServer({ options: { headersTimeoutMs: 200 } });
    try {
      const socket = nodeTls.connect({
        host: "127.0.0.1",
        port: t.port,
        ca: t.tls.cert,
        servername: "localhost",
      });
      await new Promise((resolve) => socket.once("secureConnect", resolve));
      socket.resume();
      socket.write("GET / HTTP/1.1\r\nHost: x\r\nX-Slow: ");
      const started = Date.now();
      await new Promise((resolve) => {
        socket.on("close", resolve);
        socket.on("error", () => {});
      });
      assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
    } finally {
      await t.close();
    }
  });

  test("a client that never completes the TLS handshake does not block close()", async () => {
    const t = await startServer({ options: { closeGraceMs: 100 } });
    const { default: net } = await import("node:net");
    const socket = net.connect(t.port, "127.0.0.1");
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write("not a handshake");
    socket.on("error", () => {});
    const started = Date.now();
    await t.server.close();
    assert.ok(Date.now() - started < 1500);
    socket.destroy();
    await t.close();
  });

  test("close() cuts a request that is still arriving after the grace time", async () => {
    const t = await startServer({ options: { closeGraceMs: 100 } });
    const req = https.request({
      host: "127.0.0.1",
      port: t.port,
      method: "POST",
      path: "/api/rpc/x",
      ca: t.tls.cert,
      agent: false,
      headers: { "X-VidAI": "1", "Content-Length": "1000" },
    });
    req.on("error", () => {});
    req.write("{");
    await pause(50);
    const started = Date.now();
    await t.server.close();
    assert.ok(Date.now() - started < 1500);
    req.destroy();
    await t.close();
  });

  test("close() is safe to call twice and before listen", async () => {
    const t = await startServer();
    await t.server.close();
    await t.server.close();
    await t.close();
  });

  test("a keep-alive connection that is idle does not delay close()", async () => {
    const t = await startServer();
    const agent = new https.Agent({ keepAlive: true, ca: t.tls.cert });
    await new Promise((resolve, reject) => {
      https
        .get({ host: "127.0.0.1", port: t.port, path: "/api/x", agent }, (res) => {
          res.resume();
          res.on("end", () => resolve(undefined));
        })
        .on("error", reject);
    });
    const started = Date.now();
    await t.server.close();
    assert.ok(Date.now() - started < 500, `close took ${Date.now() - started} ms`);
    agent.destroy();
    await t.close();
  });

  test("a stream whose client stopped reading does not grow without bound", async () => {
    const t = await startServer();
    const s = await openStream(t, "user-token");
    try {
      await s.until((x) => x.includes("hello"));
      s.res.pause();
      const chunk = "x".repeat(200_000);
      for (let i = 0; i < 80; i++) {
        t.events.emit({ event: "big", payload: chunk, userId: "u-user", admins: false });
      }
      await s.untilEnded().catch(() => {});
      // Reading resumes after the server cut the connection: the stream is over.
      s.res.resume();
      await s.untilEnded();
    } finally {
      s.destroy();
      await t.close();
    }
  });
});

describe("listening", () => {
  /** @param {string} dir */
  async function makeDeps(dir) {
    const tls = await ensureCertificate({
      dir: path.join(dir, "tls"),
      hostnames: [],
      addresses: [],
    });
    return /** @type {import("../../src/http/types.js").HttpDeps} */ ({
      tls,
      authenticate: () => null,
      rpc: () => Promise.resolve(null),
      events: createEventBus(),
      uiDist: dir,
      instanceId: "i",
      log: createLogger({ file: null }),
    });
  }

  test("a port in use is a readable error", async () => {
    const dir = tempDir();
    try {
      const a = createHttpServer(await makeDeps(dir));
      const b = createHttpServer(await makeDeps(dir));
      const { port } = await a.listen(0, "127.0.0.1");
      await assert.rejects(b.listen(port, "127.0.0.1"), /already in use/);
      await a.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("addresses() is empty before listen and lists https URLs after", async () => {
    const dir = tempDir();
    try {
      const server = createHttpServer(await makeDeps(dir));
      assert.deepEqual(server.addresses(), []);
      const { port } = await server.listen(0, "0.0.0.0");
      const addresses = server.addresses();
      assert.ok(port > 0);
      assert.ok(addresses.includes(`https://localhost:${port}`));
      assert.ok(addresses.every((a) => a.startsWith("https://") && a.endsWith(`:${port}`)));
      assert.ok(addresses.length >= 2);
      await server.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("address lists", () => {
  const interfaces = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [
      { address: "192.168.1.20", family: "IPv4", internal: false },
      { address: "fe80::1", family: "IPv6", internal: false },
    ],
    en1: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
  };

  test("localIdentity keeps the host name, the .local name and non-internal IPv4 addresses", () => {
    const identity = localIdentity({
      hostname: "Studio-Mac",
      interfaces: /** @type {any} */ (interfaces),
    });
    assert.equal(identity.hostname, "studio-mac");
    assert.deepEqual(identity.hostnames, ["studio-mac", "studio-mac.local"]);
    assert.deepEqual(identity.addresses, ["192.168.1.20", "10.0.0.5"]);
    const local = localIdentity({ hostname: "box.local", interfaces: {} });
    assert.deepEqual(local.hostnames, ["box.local"]);
  });

  test("a wildcard host lists the host name, each address and localhost", () => {
    const identity = localIdentity({
      hostname: "box",
      interfaces: /** @type {any} */ (interfaces),
    });
    assert.deepEqual(listAddresses({ port: 14200, host: "0.0.0.0", identity }), [
      "https://box:14200",
      "https://192.168.1.20:14200",
      "https://10.0.0.5:14200",
      "https://localhost:14200",
    ]);
  });

  test("a specific host lists only itself, and localhost when it is loopback", () => {
    const identity = localIdentity({ hostname: "box", interfaces: {} });
    assert.deepEqual(listAddresses({ port: 1, host: "127.0.0.1", identity }), [
      "https://127.0.0.1:1",
      "https://localhost:1",
    ]);
    assert.deepEqual(listAddresses({ port: 1, host: "192.168.1.9", identity }), [
      "https://192.168.1.9:1",
    ]);
    assert.deepEqual(listAddresses({ port: 1, host: "::1", identity }), [
      "https://[::1]:1",
      "https://localhost:1",
    ]);
  });
});

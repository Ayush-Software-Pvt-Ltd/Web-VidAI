// Shared helpers of the HTTP tests: a real server on port 0 with a certificate from tls.js.
import fs from "node:fs";
import https from "node:https";
import nodeTls from "node:tls";
import os from "node:os";
import path from "node:path";
import { createEventBus } from "../../src/events.js";
import { createHttpServer } from "../../src/http/server.js";
import { ensureCertificate } from "../../src/http/tls.js";
import { createLogger } from "../../src/log.js";

/** @typedef {import("../../src/http/types.js").Session} Session */

/** @type {Record<string, Session>} */
export const SESSIONS = {
  "admin-token": {
    id: "s-admin",
    user: { id: "u-admin", email: "admin@example.com", role: "admin" },
  },
  "user-token": { id: "s-user", user: { id: "u-user", email: "user@example.com", role: "user" } },
  "other-token": {
    id: "s-other",
    user: { id: "u-other", email: "other@example.com", role: "user" },
  },
};

/** @returns {string} A fresh temporary directory. */
export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vidai-http-"));
}

/**
 * @typedef {object} Reply
 * @property {number} status
 * @property {import("node:http").IncomingHttpHeaders} headers
 * @property {Buffer} body
 * @property {string} text
 * @property {any} json
 */

/**
 * @param {object} [options]
 * @param {Partial<import("../../src/http/types.js").HttpDeps>} [options.deps]
 * @param {import("../../src/http/types.js").HttpOptions} [options.options]
 * @param {Record<string, string | Buffer>} [options.files] Files of the UI directory.
 */
export async function startServer({ deps = {}, options, files = {} } = {}) {
  const dir = tempDir();
  const uiDist = path.join(dir, "dist");
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(uiDist, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.mkdirSync(uiDist, { recursive: true });
  const tls = await ensureCertificate({
    dir: path.join(dir, "tls"),
    hostnames: ["localhost"],
    addresses: ["127.0.0.1"],
  });
  /** @type {string[]} */
  const logLines = [];
  const log = createLogger({
    file: null,
    console: {
      write: (line) => {
        logLines.push(line);
      },
    },
  });
  const events = createEventBus();
  /** @type {{ token: string, address: string, userAgent: string }[]} */
  const authCalls = [];
  const server = createHttpServer({
    tls,
    authenticate: (token, meta) => {
      authCalls.push({ token, ...meta });
      return SESSIONS[token] ?? null;
    },
    rpc: () => Promise.resolve(null),
    events,
    uiDist,
    instanceId: "instance-1",
    log,
    options,
    ...deps,
  });
  const { port } = await server.listen(0, "127.0.0.1");
  const origin = `https://127.0.0.1:${port}`;

  /**
   * @param {string} method
   * @param {string} urlPath
   * @param {{ headers?: Record<string, string>, body?: string | Buffer | null, changing?: boolean }} [init]
   *   `changing: true` adds `X-VidAI: 1` and the right Origin.
   * @returns {Promise<Reply>}
   */
  function request(method, urlPath, { headers = {}, body = null, changing = false } = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: "127.0.0.1",
          port,
          method,
          path: urlPath,
          ca: tls.cert,
          headers: {
            ...(changing ? { "X-VidAI": "1", Origin: origin } : {}),
            ...headers,
          },
          agent: false,
        },
        (res) => {
          /** @type {Buffer[]} */
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const buffer = Buffer.concat(chunks);
            const text = buffer.toString("utf8");
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              // Not JSON.
            }
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: buffer,
              text,
              json,
            });
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  /**
   * A signed-in RPC call.
   * @param {string} name
   * @param {unknown} [input]
   * @param {string} [token]
   */
  function rpc(name, input, token = "admin-token") {
    return request("POST", `/api/rpc/${name}`, {
      changing: true,
      headers: { Cookie: `vidai_session=${token}`, "Content-Type": "application/json" },
      body: input === undefined ? null : JSON.stringify(input),
    });
  }

  return {
    port,
    origin,
    dir,
    uiDist,
    tls,
    server,
    events,
    authCalls,
    logLines,
    request,
    rpc,
    async close() {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * @typedef {object} StreamHandle
 * @property {import("node:http").IncomingMessage} res
 * @property {import("node:http").ClientRequest} req
 * @property {() => string} text Raw text so far.
 * @property {() => { event: string, payload: any }[]} messages Data messages so far, parsed, without `ping`.
 * @property {() => number} pings How many `ping` heartbeats arrived so far.
 * @property {(done: (text: string) => boolean) => Promise<void>} until
 * @property {boolean} ended
 * @property {() => Promise<void>} untilEnded Wait for the server to end the stream.
 * @property {() => void} destroy
 */

/**
 * Open an event stream and collect its messages.
 * @param {Awaited<ReturnType<typeof startServer>>} t
 * @param {string} token
 * @param {{ headers?: Record<string, string> }} [init]
 * @returns {Promise<StreamHandle>}
 */
export function openStream(t, token, { headers = {} } = {}) {
  return new Promise((/** @type {(handle: StreamHandle) => void} */ resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port: t.port,
        path: "/api/events",
        ca: t.tls.cert,
        headers: { Cookie: `vidai_session=${token}`, ...headers },
        agent: false,
      },
      (res) => {
        let text = "";
        /** @type {(() => void)[]} */
        const waiters = [];
        let ended = false;
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
          for (const wake of waiters.splice(0)) wake();
        });
        const finish = () => {
          ended = true;
          for (const wake of waiters.splice(0)) wake();
        };
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
        resolve({
          res,
          req,
          /** Raw text so far. */
          text: () => text,
          /** Data messages so far, parsed, without the `ping` heartbeats (see `pings`). */
          messages: () =>
            text
              .split("\n\n")
              .filter((block) => block.startsWith("data: "))
              .map((block) => JSON.parse(block.slice(6)))
              .filter((message) => message.event !== "ping"),
          /** How many `ping` heartbeats arrived so far. */
          pings: () => (text.match(/^data: \{"event":"ping","payload":null\}$/gm) ?? []).length,
          /**
           * Wait until the text satisfies a test.
           * @param {(text: string) => boolean} done
           */
          async until(done) {
            const deadline = Date.now() + 5000;
            while (!done(text)) {
              if (ended || Date.now() > deadline) throw new Error(`stream stopped at: ${text}`);
              await new Promise((wake) => {
                waiters.push(() => wake(undefined));
                setTimeout(wake, 50);
              });
            }
          },
          get ended() {
            return ended;
          },
          /** Wait for the server to end the stream. */
          async untilEnded() {
            const deadline = Date.now() + 5000;
            while (!ended) {
              if (Date.now() > deadline) throw new Error("stream did not end");
              await new Promise((wake) => {
                waiters.push(() => wake(undefined));
                setTimeout(wake, 50);
              });
            }
          },
          destroy() {
            req.destroy();
          },
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Send raw text over TLS and return everything the server answers until it closes.
 * @param {Awaited<ReturnType<typeof startServer>>} t
 * @param {string} text
 * @returns {Promise<string>}
 */
export function rawRequest(t, text) {
  return new Promise((resolve, reject) => {
    const socket = nodeTls.connect({
      host: "127.0.0.1",
      port: t.port,
      ca: t.tls.cert,
      servername: "localhost",
    });
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      received += chunk;
    });
    socket.on("end", () => resolve(received));
    socket.on("error", reject);
    socket.on("secureConnect", () => socket.write(text));
  });
}

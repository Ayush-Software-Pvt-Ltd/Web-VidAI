// Helpers of the app tests: a real app on port 0 in a temporary data directory, and a small HTTPS
// client with a cookie jar that trusts the certificate the app generated.
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config.js";

export const ADMIN_EMAIL = "admin@example.com";
export const ADMIN_PASSWORD = "admin-password-for-tests";

/** @returns {string} A fresh temporary directory. */
export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vidai-app-"));
}

/**
 * A folder with a tiny built UI, so the static handler has something to serve.
 * @param {string} root
 * @returns {string}
 */
export function makeUiDist(root) {
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>VidAI</title>");
  return dist;
}

/**
 * Create and start an app. `dataDir` may be given to restart on the same data.
 * @param {object} [input]
 * @param {string} [input.dataDir]
 * @param {Record<string, string | undefined>} [input.env]
 * @param {import("../../src/app.js").AppOptions} [input.options]
 * @param {import("../../src/db/open.js").Clock} [input.clock]
 */
export async function startApp({ dataDir, env = {}, options, clock } = {}) {
  const root = tempDir();
  const data = dataDir ?? path.join(root, "data");
  const fullEnv = { VIDAI_SECRETS: "memory", ...env };
  const config = loadConfig({
    argv: ["--port", "0", "--host", "127.0.0.1", "--data", data],
    env: { ...fullEnv, VIDAI_UI_DIST: makeUiDist(root) },
    home: root,
  });
  /** @type {ReturnType<typeof createApp>} */
  let app;
  try {
    app = createApp({ config, env: fullEnv, options, clock });
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const info = await app.start();
  const ca = fs.readFileSync(app.paths.certFile);
  /** @type {Client[]} */
  const clients = [];
  return {
    app,
    info,
    root,
    dataDir: data,
    ca,
    /** The certificate's SHA-256 fingerprint. */
    fingerprint: new X509Certificate(ca).fingerprint256,
    /** @returns {Client} A client with its own cookie jar. */
    client() {
      const client = makeClient(info.port, ca);
      clients.push(client);
      return client;
    },
    /** Stop the app, close every stream and remove the temporary files. */
    async close() {
      for (const client of clients) client.closeStreams();
      await app.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * @typedef {object} Reply
 * @property {number} status
 * @property {import("node:http").IncomingHttpHeaders} headers
 * @property {string} text
 * @property {any} json
 *
 * @typedef {object} Stream
 * @property {() => { event: string, payload: any }[]} messages Data messages so far, parsed.
 * @property {(event: string) => Promise<any>} next Payload of the first message of that name, now or later.
 * @property {Promise<void>} ended Resolves when the server ends the stream.
 * @property {number} status
 * @property {() => void} destroy
 *
 * @typedef {ReturnType<typeof makeClient>} Client
 */

/**
 * @param {number} port
 * @param {Buffer} ca
 */
export function makeClient(port, ca) {
  const origin = `https://127.0.0.1:${port}`;
  /** @type {Map<string, string>} */
  const jar = new Map();
  /** @type {Set<() => void>} */
  const streams = new Set();

  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

  /** @param {import("node:http").IncomingHttpHeaders} headers */
  function remember(headers) {
    for (const line of headers["set-cookie"] ?? []) {
      const [pair = ""] = line.split(";");
      const equals = pair.indexOf("=");
      const name = pair.slice(0, equals).trim();
      const value = pair.slice(equals + 1).trim();
      // `Max-Age=0` or an empty value clears the cookie.
      if (value === "" || /max-age=0/i.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
  }

  /**
   * @param {string} method
   * @param {string} urlPath
   * @param {{ headers?: Record<string, string>, body?: string | null, changing?: boolean }} [init]
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
          ca,
          agent: false,
          headers: {
            ...(jar.size > 0 ? { Cookie: cookieHeader() } : {}),
            ...(changing ? { "X-VidAI": "1", Origin: origin } : {}),
            ...headers,
          },
        },
        (res) => {
          /** @type {Buffer[]} */
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            remember(res.headers);
            const text = Buffer.concat(chunks).toString("utf8");
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              // Not JSON (the UI page).
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  return {
    origin,
    jar,
    request,

    /**
     * A well-formed RPC call (header and origin set).
     * @param {string} name
     * @param {unknown} [input]
     * @returns {Promise<Reply>}
     */
    rpc(name, input = {}) {
      return request("POST", `/api/rpc/${name}`, {
        changing: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    },

    /** @returns {string | undefined} */
    get sessionCookie() {
      return jar.get("vidai_session");
    },

    /**
     * Open `/api/events` with this client's cookie.
     * @returns {Promise<Stream>}
     */
    openStream() {
      return new Promise((resolve, reject) => {
        const req = https.request(
          {
            host: "127.0.0.1",
            port,
            path: "/api/events",
            ca,
            agent: false,
            headers: { Cookie: cookieHeader() },
          },
          (res) => {
            let text = "";
            /** @type {Set<() => void>} */
            const waiters = new Set();
            // The `ping` heartbeat is not an event of SPEC section 14: left out here.
            const messages = () =>
              [...text.matchAll(/^data: (.*)$/gm)]
                .map((match) => JSON.parse(match[1] ?? "null"))
                .filter((message) => message?.event !== "ping");
            const ended = new Promise((done) => {
              res.on("close", () => {
                done(undefined);
              });
            });
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              text += chunk;
              for (const wake of [...waiters]) wake();
            });
            res.on("error", () => {});
            const destroy = () => {
              req.destroy();
            };
            streams.add(destroy);
            resolve({
              status: res.statusCode ?? 0,
              messages,
              ended: /** @type {Promise<void>} */ (ended),
              destroy,
              next: (event) =>
                new Promise((found) => {
                  const check = () => {
                    const hit = messages().find((message) => message.event === event);
                    if (!hit) return;
                    waiters.delete(check);
                    found(hit.payload);
                  };
                  waiters.add(check);
                  check();
                }),
            });
          },
        );
        req.on("error", reject);
        req.end();
      });
    },

    closeStreams() {
      for (const destroy of streams) destroy();
      streams.clear();
    },
  };
}

/**
 * Reject when `promise` takes longer than `ms`, so a hang fails with a sentence.
 * @template T
 * @param {Promise<T>} promise
 * @param {string} what
 * @param {number} [ms]
 * @returns {Promise<T>}
 */
export function within(promise, what, ms = 5000) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${what}.`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

// The HTTPS server: RPC, events, extra routes and the UI (docs/SPEC.md sections 3, 4 and 14).
import https from "node:https";
import { AppError, notFound } from "../errors.js";
import { listAddresses } from "./addresses.js";
import { MAX_JSON_BYTES, readJson } from "./body.js";
import { SESSION_COOKIE, parseCookies, sessionCookieHeader } from "./cookies.js";
import {
  applySecurityHeaders,
  isChangingMethod,
  requireChangingRequestHeaders,
  requireSameOrigin,
} from "./headers.js";
import { createRouter } from "./router.js";
import { sendError, sendJson } from "./respond.js";
import { openEventStream } from "./sse.js";
import { createStaticHandler } from "./static.js";

/** What a client sees when something unexpected broke; the real error goes to the log only. */
const GENERIC_MESSAGE = "Something went wrong on the server.";

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {string}
 */
function remoteAddress(req) {
  return (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}

/**
 * Create the HTTPS server. Nothing listens until `listen` is called.
 * @param {import("./types.js").HttpDeps} deps
 */
export function createHttpServer(deps) {
  const { log, events } = deps;
  const options = {
    pingMs: 15_000,
    headersTimeoutMs: 15_000,
    bodyIdleMs: 30_000,
    maxJsonBytes: MAX_JSON_BYTES,
    closeGraceMs: 1_000,
    ...deps.options,
  };
  const serveUi = createStaticHandler(deps.uiDist);
  /** @type {Set<{ end(): void }>} */
  const streams = new Set();
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();
  /** @type {number | null} */
  let boundPort = null;
  /** @type {string} */
  let boundHost = "0.0.0.0";

  /** @type {import("./types.js").Route[]} */
  const routes = [
    {
      method: "POST",
      path: /^\/api\/rpc\/(?<name>[a-zA-Z][a-zA-Z0-9]*)$/,
      auth: "none",
      handler: handleRpc,
    },
    { method: "GET", path: "/api/events", auth: "session", handler: handleEvents },
    ...(deps.routes ?? []),
  ];
  const router = createRouter(routes);

  /**
   * @param {import("node:http").IncomingMessage} req
   * @returns {import("./types.js").Session | null}
   */
  function sessionOf(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    return deps.authenticate(token, {
      address: remoteAddress(req),
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300),
    });
  }

  /** @type {import("./types.js").Route["handler"]} */
  async function handleRpc(req, res, ctx) {
    const input = await readJson(req, { limit: options.maxJsonBytes, idleMs: options.bodyIdleMs });
    const result = await deps.rpc(ctx.params.name ?? "", input, {
      session: ctx.session,
      address: ctx.address,
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300),
      setSessionCookie: (token) => {
        res.setHeader("Set-Cookie", sessionCookieHeader(token));
      },
    });
    sendJson(res, 200, result);
  }

  /** @type {import("./types.js").Route["handler"]} */
  function handleEvents(req, res, ctx) {
    requireSameOrigin(req);
    if (!ctx.session) throw new AppError("unauthenticated", "Please sign in.");
    /** @type {{ end(): void }} */
    const stream = openEventStream({
      req,
      res,
      session: ctx.session,
      events,
      instanceId: deps.instanceId,
      pingMs: options.pingMs,
      onEnd: () => streams.delete(stream),
    });
    streams.add(stream);
  }

  /**
   * Answer a failed request: an `AppError` as it is, anything else as a generic `internal`.
   * @param {import("node:http").ServerResponse} res
   * @param {unknown} error
   * @param {string} what For the log.
   */
  function fail(res, error, what) {
    if (res.headersSent) {
      log.warn(`${what}: failed after the answer started`, error);
      res.destroy();
      return;
    }
    let answer;
    if (error instanceof AppError) {
      answer = error;
      if (error.code === "internal") log.error(`${what}: ${error.message}`, error.cause ?? error);
    } else {
      log.error(`${what}: unexpected error`, error);
      answer = new AppError("internal", GENERIC_MESSAGE);
    }
    // The client may still be sending a body we did not read; do not wait for it.
    if (answer.code === "tooLarge") res.setHeader("Connection", "close");
    sendError(res, answer);
  }

  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  async function handle(req, res) {
    applySecurityHeaders(res);
    const method = req.method ?? "GET";
    const what = `${method} ${String(req.url).split("?")[0]}`.slice(0, 200);
    try {
      const target = req.url ?? "/";
      if (!target.startsWith("/")) throw new AppError("invalidInput", "That address is not valid.");
      /** @type {URL} */
      let url;
      try {
        url = new URL(`https://${req.headers.host ?? "localhost"}${target}`);
      } catch {
        url = new URL(`https://localhost${target}`);
      }
      const pathname = url.pathname;
      const match = router.match(method, pathname);

      if (match.kind === "method") {
        res.setHeader("Allow", match.allow.join(", "));
        sendJson(res, 405, {
          code: "invalidInput",
          message: "This request method is not allowed here.",
        });
        return;
      }
      if (match.kind === "none") {
        if (pathname === "/api" || pathname.startsWith("/api/")) {
          throw notFound("There is nothing at this address.");
        }
        await serveUi(req, res, pathname);
        return;
      }

      const { route, params } = match;
      if (isChangingMethod(method)) requireChangingRequestHeaders(req);
      const session = sessionOf(req);
      if (route.auth === "session" && session === null) {
        throw new AppError("unauthenticated", "Please sign in.");
      }
      await route.handler(req, res, { session, url, params, address: remoteAddress(req) });
    } catch (error) {
      fail(res, error, what);
    }
  }

  const server = https.createServer(
    {
      key: deps.tls.key,
      cert: deps.tls.cert,
      minVersion: "TLSv1.2",
      handshakeTimeout: 10_000,
      headersTimeout: options.headersTimeoutMs,
      // Uploads and downloads can take hours; slow clients are handled per request instead.
      requestTimeout: 0,
      connectionsCheckingInterval: Math.max(50, Math.floor(options.headersTimeoutMs / 2)),
    },
    (req, res) => {
      void handle(req, res);
    },
  );
  server.on("connection", (socket) => {
    const tracked = /** @type {import("node:net").Socket} */ (socket);
    sockets.add(tracked);
    tracked.once("close", () => sockets.delete(tracked));
  });
  // A browser rejecting the self-signed certificate lands here; that is not worth a log line each time.
  server.on("tlsClientError", () => {});

  return {
    /**
     * @param {number} port 0 picks a free port.
     * @param {string} host
     * @returns {Promise<{ port: number }>}
     */
    listen(port, host) {
      return new Promise((resolve, reject) => {
        /** @param {Error} error */
        const onError = (error) => {
          const code = /** @type {{ code?: string }} */ (error).code;
          reject(
            code === "EADDRINUSE"
              ? new AppError("io", `Port ${port} is already in use. Choose another with --port.`, {
                  cause: error,
                })
              : error,
          );
        };
        server.once("error", onError);
        server.listen(port, host, () => {
          server.off("error", onError);
          const address = server.address();
          boundPort = typeof address === "object" && address ? address.port : port;
          boundHost = host;
          resolve({ port: boundPort });
        });
      });
    },

    /**
     * Stop listening and end every connection, event streams first; running answers get a short
     * grace period.
     * @returns {Promise<void>}
     */
    close() {
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        const grace = setTimeout(() => {
          server.closeAllConnections();
          for (const socket of sockets) socket.destroy();
        }, options.closeGraceMs);
        server.close(() => {
          clearTimeout(grace);
          resolve();
        });
        for (const stream of [...streams]) stream.end();
        server.closeIdleConnections();
      });
    },

    /** The addresses people can open, once `listen` has run. */
    addresses() {
      return boundPort === null ? [] : listAddresses({ port: boundPort, host: boundHost });
    },
  };
}

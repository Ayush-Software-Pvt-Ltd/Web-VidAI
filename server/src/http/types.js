// Type declarations of the HTTP layer's seam with the rest of the server (docs/SPEC.md sections 4 and 14).
// This file has no code; other modules import its typedefs.

/**
 * @typedef {import("node:http").IncomingMessage} Request
 * @typedef {import("node:http").ServerResponse} Response
 * @typedef {import("../log.js").Logger} Logger
 * @typedef {import("../events.js").EventBus} EventBus
 *
 * @typedef {object} Session Who is asking.
 * @property {string} id Session id (not the cookie token).
 * @property {{ id: string, email: string, role: "admin" | "user" }} user
 *
 * @typedef {object} RpcContext
 * @property {Session | null} session
 * @property {string} address Remote address.
 * @property {string} userAgent
 * @property {(token: string | null) => void} setSessionCookie Set (login) or clear (logout) the cookie on this answer.
 *
 * @typedef {object} RouteContext
 * @property {Session | null} session Always set on routes with `auth: "session"`.
 * @property {URL} url
 * @property {Record<string, string>} params Named groups of a RegExp path, or `{ rest }` of a prefix path.
 * @property {string} address Remote address.
 *
 * @typedef {object} Route
 * @property {"GET" | "PUT" | "POST" | "DELETE" | "HEAD"} method
 *   A `GET` route also answers `HEAD` unless a `HEAD` route exists for the same path.
 * @property {string | RegExp} path
 *   A string is an exact path, or a prefix when it ends with `/*` (`/p/*` matches `/p/a/b`, with
 *   `params.rest` the decoded rest `a/b`, which may contain `..` or `/` and must be validated by the
 *   handler). A RegExp is tested against the whole path (percent-escapes not decoded); its named
 *   groups become `params`.
 * @property {"session" | "none"} auth `"session"` answers 401 JSON without a valid session before the handler runs.
 * @property {(req: Request, res: Response, ctx: RouteContext) => void | Promise<void>} handler
 *   Throw an `AppError` to answer it as JSON. The default security headers are already set on `res`
 *   with `setHeader`, so a handler may replace or remove them (the preview route does).
 *
 * @typedef {object} HttpOptions Timings and limits; every one has a real default, tests shorten them.
 * @property {number} [pingMs] Silence after which an idle event stream gets a `ping` data event (15 s).
 * @property {number} [headersTimeoutMs] Time a client has to send its request line and headers (15 s).
 * @property {number} [bodyIdleMs] Longest silence while a JSON body arrives (30 s).
 * @property {number} [maxJsonBytes] RPC body limit (1 MB).
 * @property {number} [closeGraceMs] Time `close()` lets running answers finish before cutting them (1 s).
 *
 * @typedef {object} HttpDeps
 * @property {{ key: string, cert: string }} tls
 * @property {(token: string, meta: { address: string, userAgent: string }) => Session | null} authenticate
 * @property {(name: string, input: unknown, ctx: RpcContext) => Promise<unknown>} rpc Throws `AppError`.
 * @property {EventBus} events
 * @property {string} uiDist Directory of the built UI.
 * @property {string} instanceId Sent in the SSE `hello` event.
 * @property {Route[]} [routes] Extra routes added by other modules (uploads, files, preview).
 * @property {Logger} log
 * @property {HttpOptions} [options]
 */

export {};

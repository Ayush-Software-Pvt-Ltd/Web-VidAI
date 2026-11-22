// Security headers and the checks that keep other sites from driving a signed-in browser
// (docs/SPEC.md section 4).
import { forbidden } from "../errors.js";

/** Scripts, styles, fonts, media and connections only from the server itself; frames only from itself (preview). */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  // The UI sets inline styles.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

/** @type {Readonly<Record<string, string>>} */
export const SECURITY_HEADERS = Object.freeze({
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
});

/**
 * Put the default security headers on a response. They are plain `setHeader` values, so a handler
 * can still replace or remove one before it writes.
 * @param {import("node:http").ServerResponse} res
 */
export function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

/**
 * When the browser sends `Origin`, it must be this server's own origin.
 * @param {import("node:http").IncomingMessage} req
 * @throws {import("../errors.js").AppError} `forbidden`
 */
export function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  const host = req.headers.host;
  if (host === undefined || origin.toLowerCase() !== `https://${host.toLowerCase()}`) {
    throw forbidden("This request came from another website and was refused.");
  }
}

const CHANGING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/**
 * Whether the method changes state.
 * @param {string | undefined} method
 */
export function isChangingMethod(method) {
  return CHANGING_METHODS.has(method ?? "");
}

/**
 * A changing request must carry `X-VidAI: 1` and, when it has an `Origin`, the server's own.
 * @param {import("node:http").IncomingMessage} req
 * @throws {import("../errors.js").AppError} `forbidden`
 */
export function requireChangingRequestHeaders(req) {
  if (req.headers["x-vidai"] !== "1") {
    throw forbidden("This request is missing its VidAI header and was refused.");
  }
  requireSameOrigin(req);
}

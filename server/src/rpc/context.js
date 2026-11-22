// The seam between the HTTP layer and the RPC functions (docs/SPEC.md sections 3 and 14).
// Types only; the HTTP layer builds an `RpcContext` per request and calls `rpc.call`.

import { AppError } from "../errors.js";

/**
 * @typedef {object} Session
 * @property {string} id Session row id, not the cookie token.
 * @property {{ id: string, email: string, role: "admin" | "user" }} user
 */

/**
 * @typedef {object} RpcContext
 * @property {Session | null} session
 * @property {string} address
 * @property {string} userAgent
 * @property {(token: string | null) => void} setSessionCookie Login sets it, logout clears it.
 */

/**
 * The session of a call to a function that needs one; `RpcRegistry.call` has already refused
 * callers without it, this only narrows the type.
 * @param {RpcContext} ctx
 * @returns {Session}
 */
export function requireSession(ctx) {
  if (!ctx.session) throw new AppError("unauthenticated", "Sign in to continue.");
  return ctx.session;
}

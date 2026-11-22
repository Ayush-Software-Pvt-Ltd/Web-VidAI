// The session cookie (docs/SPEC.md section 4).

export const SESSION_COOKIE = "vidai_session";
/** 30 days, the session's idle lifetime. */
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * @param {string | undefined} header The `Cookie` request header.
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const cookies = {};
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    let value = part.slice(at + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      value = value.slice(1, -1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep the raw value; it will simply not match a session.
    }
    if (!(name in cookies)) cookies[name] = value;
  }
  return cookies;
}

/**
 * The `Set-Cookie` value that sets (token) or clears (null) the session cookie.
 * @param {string | null} token
 * @returns {string}
 */
export function sessionCookieHeader(token) {
  const attributes = "HttpOnly; Secure; SameSite=Lax; Path=/";
  if (token === null) {
    return `${SESSION_COOKIE}=; ${attributes}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${attributes}; Max-Age=${MAX_AGE_SECONDS}`;
}

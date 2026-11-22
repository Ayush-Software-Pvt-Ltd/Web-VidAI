// Preview tokens (docs/SPEC.md section 11, Preview): one 32-byte random token per session and video.
// Tokens live in memory only, so after a restart the page asks for a new one. A token ends with its
// session, when its video goes away, or after the time to live (12 hours from the last `open`).
import { randomBytes } from "node:crypto";

/** @typedef {{ now(): number }} Clock */

/**
 * @typedef {object} PreviewTarget What a token opens.
 * @property {string} projectDir The `<video>/output/<name>.hf` folder.
 * @property {string} videoDir The video folder (links in `assets/media` may point inside it).
 * @property {string} channelDir The channel directory (links may also point inside it).
 *
 * @typedef {PreviewTarget & { token: string, sessionId: string, userId: string, videoKey: string, expiresAt: number }} PreviewGrant
 */

/** A token is 32 bytes as base64url, which is always 43 characters. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** SPEC section 11: the token ends after 12 hours. */
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * @param {object} deps
 * @param {Clock} deps.clock
 * @param {number} [deps.ttlMs]
 * @param {(size: number) => Buffer} [deps.random] Source of the token bytes (tests fix it).
 */
export function createTokenStore({ clock, ttlMs = DEFAULT_TTL_MS, random = randomBytes }) {
  /** @type {Map<string, PreviewGrant>} */
  const byToken = new Map();
  /** @type {Map<string, string>} `sessionId NUL videoKey` to token, so the same session reuses its token. */
  const byOwner = new Map();

  /** @param {string} sessionId @param {string} videoKey */
  const ownerKey = (sessionId, videoKey) => `${sessionId}\0${videoKey}`;

  /** @param {PreviewGrant} grant */
  function drop(grant) {
    byToken.delete(grant.token);
    const key = ownerKey(grant.sessionId, grant.videoKey);
    if (byOwner.get(key) === grant.token) byOwner.delete(key);
  }

  /** @param {PreviewGrant} grant */
  const expired = (grant) => clock.now() >= grant.expiresAt;

  return {
    /**
     * The token of this session and video; the same one while it lives, which keeps a reopened
     * timeline's address stable. Opening again also restarts the time to live.
     * @param {{ sessionId: string, userId: string, videoKey: string } & PreviewTarget} info
     * @returns {string}
     */
    open(info) {
      const key = ownerKey(info.sessionId, info.videoKey);
      const existingToken = byOwner.get(key);
      const existing = existingToken === undefined ? undefined : byToken.get(existingToken);
      const expiresAt = clock.now() + ttlMs;
      if (existing && !expired(existing)) {
        existing.expiresAt = expiresAt;
        existing.projectDir = info.projectDir;
        existing.videoDir = info.videoDir;
        existing.channelDir = info.channelDir;
        return existing.token;
      }
      if (existing) drop(existing);
      const token = random(32).toString("base64url");
      byToken.set(token, { ...info, token, expiresAt });
      byOwner.set(key, token);
      return token;
    },

    /**
     * @param {string} token
     * @returns {PreviewGrant | null} Null for an unknown, malformed or expired token.
     */
    lookup(token) {
      if (!TOKEN_PATTERN.test(token)) return null;
      const grant = byToken.get(token);
      if (!grant) return null;
      if (expired(grant)) {
        drop(grant);
        return null;
      }
      return grant;
    },

    /** @param {string} sessionId */
    closeSession(sessionId) {
      for (const grant of [...byToken.values()]) if (grant.sessionId === sessionId) drop(grant);
    },

    /** @param {string} videoKey */
    closeVideo(videoKey) {
      for (const grant of [...byToken.values()]) if (grant.videoKey === videoKey) drop(grant);
    },

    /** Drop every expired token. */
    sweep() {
      for (const grant of [...byToken.values()]) if (expired(grant)) drop(grant);
    },

    /** Forget everything. */
    clear() {
      byToken.clear();
      byOwner.clear();
    },

    /** How many tokens are held (expired ones count until swept or looked up). */
    get size() {
      return byToken.size;
    },
  };
}

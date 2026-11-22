// The login throttle (docs/SPEC.md section 4): 5 failures for the same email, or from the same
// address, within 15 minutes block that email or address for 15 minutes. In memory only; a
// restart forgives everybody, which is fine for an intranet tool.

const DEFAULTS = {
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
  // Bounds memory against someone trying endless made-up emails.
  maxKeys: 10000,
};

/**
 * @typedef {object} Entry
 * @property {number[]} failures Times of failures still inside the window.
 * @property {number} blockedUntil 0 when not blocked.
 */

/**
 * @param {{
 *   clock: import("../db/open.js").Clock,
 *   maxFailures?: number,
 *   windowMs?: number,
 *   blockMs?: number,
 *   maxKeys?: number,
 * }} options
 */
export function createThrottle({ clock, ...overrides }) {
  const { maxFailures, windowMs, blockMs, maxKeys } = { ...DEFAULTS, ...overrides };
  /** @type {Map<string, Entry>} */
  const entries = new Map();

  /** @param {{ email: string, address: string }} who */
  const keysOf = ({ email, address }) => [`email:${email}`, `address:${address}`];

  /** Drops what no longer matters, then the oldest entries if the map is still too big. */
  function trim() {
    if (entries.size <= maxKeys) return;
    const now = clock.now();
    for (const [key, entry] of entries) {
      const stillBlocked = entry.blockedUntil > now;
      const stillCounting = entry.failures.some((at) => now - at < windowMs);
      if (!stillBlocked && !stillCounting) entries.delete(key);
    }
    for (const [key, entry] of entries) {
      if (entries.size <= maxKeys) break;
      if (entry.blockedUntil <= now) entries.delete(key);
    }
    for (const key of entries.keys()) {
      if (entries.size <= maxKeys) break;
      entries.delete(key);
    }
  }

  return {
    /**
     * How long this email or address must wait; 0 when an attempt is allowed.
     * @param {{ email: string, address: string }} who
     * @returns {number} Milliseconds.
     */
    check(who) {
      const now = clock.now();
      let wait = 0;
      for (const key of keysOf(who)) {
        const entry = entries.get(key);
        if (entry && entry.blockedUntil > now) wait = Math.max(wait, entry.blockedUntil - now);
      }
      return wait;
    },

    /** Records a failed attempt for the email and for the address. @param {{ email: string, address: string }} who */
    failure(who) {
      const now = clock.now();
      for (const key of keysOf(who)) {
        const entry = entries.get(key) ?? { failures: [], blockedUntil: 0 };
        entry.failures = entry.failures.filter((at) => now - at < windowMs);
        entry.failures.push(now);
        if (entry.failures.length >= maxFailures) {
          entry.blockedUntil = now + blockMs;
          entry.failures = [];
        }
        // Re-insert so the Map order is "least recently touched first".
        entries.delete(key);
        entries.set(key, entry);
      }
      trim();
    },

    /** A successful login clears the email's count (the address keeps its own). @param {{ email: string }} who */
    success({ email }) {
      entries.delete(`email:${email}`);
    },

    /** For tests: how many keys are remembered. */
    get size() {
      return entries.size;
    },
  };
}

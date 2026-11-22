// The timers the limits code uses, injectable so tests drive time by hand.

/**
 * Handles are opaque: pass them back to the matching `clear` function. A callback may return a
 * promise; the real timers ignore it (callers catch their own errors).
 * @typedef {object} Timers
 * @property {(callback: () => unknown, ms: number) => unknown} setInterval
 * @property {(handle: unknown) => void} clearInterval
 * @property {(callback: () => unknown, ms: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 */

/**
 * The real timers. Every handle is unref'd: a pending limits timer never keeps the server (or a
 * test run) alive.
 * @type {Timers}
 */
export const realTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms).unref(),
  clearInterval: (handle) => clearInterval(/** @type {NodeJS.Timeout} */ (handle)),
  setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
  clearTimeout: (handle) => clearTimeout(/** @type {NodeJS.Timeout} */ (handle)),
};

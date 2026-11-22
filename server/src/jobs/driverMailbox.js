// The one queue a running job's driver reads the events of
// its agent program and the requests of the manager (pause, stop), in the order they came. Reading
// has a time limit and every limit is a timer of the injected `timers`, so the driver never polls
// and tests move time by hand.

/**
 * What the driver receives.
 * - `event`: an event of the agent program number `gen` (a message of an earlier program of the
 *   same job is old news and ignored).
 * - `pause` and `stop`: the requests of the manager.
 * - `timeout`: nothing came in time.
 * @typedef {{ type: "event", gen: number, event: import("../agents/claude/session.js").SessionEvent }
 *   | { type: "pause" } | { type: "stop" } | { type: "timeout" }} Message
 */

/**
 * @typedef {object} Timers
 * @property {(fn: () => void, ms: number) => unknown} setTimeout
 * @property {(handle: unknown) => void} clearTimeout
 */

/** The real timers, unref'd so a forgotten job never keeps the server alive. */
export const realTimers = Object.freeze({
  setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (/** @type {unknown} */ handle) =>
    clearTimeout(/** @type {NodeJS.Timeout} */ (handle)),
});

/**
 * @param {Timers} timers
 */
export function createMailbox(timers) {
  /** @type {Message[]} */
  const queue = [];
  /** @type {((message: Message) => void) | null} */
  let waiter = null;

  return {
    /** @param {Message} message */
    push(message) {
      if (waiter !== null) {
        const wake = waiter;
        waiter = null;
        wake(message);
      } else {
        queue.push(message);
      }
    },

    /**
     * The oldest message that is waiting, or `null`.
     * @returns {Message | null}
     */
    tryRecv() {
      return queue.shift() ?? null;
    },

    /**
     * The next message, or `{ type: "timeout" }` after `ms`. One reader at a time.
     * @param {number} ms
     * @returns {Promise<Message>}
     */
    recv(ms) {
      const waiting = queue.shift();
      if (waiting !== undefined) return Promise.resolve(waiting);
      return new Promise((resolve) => {
        /** @type {unknown} */
        let handle = null;
        /** @param {Message} message */
        const wake = (message) => {
          if (handle !== null) timers.clearTimeout(handle);
          resolve(message);
        };
        waiter = wake;
        handle = timers.setTimeout(
          () => {
            if (waiter === wake) waiter = null;
            resolve({ type: "timeout" });
          },
          Math.max(0, ms),
        );
      });
    },
  };
}

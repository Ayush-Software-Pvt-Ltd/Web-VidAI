// The queue of preview copies (docs/SPEC.md section 11, Preview copies): one file at a time for the
// whole server, in the order it was asked for, a file wanted by two videos made once, a failed file
// remembered so it is not tried again in a loop.
//
// The queue knows nothing about ffmpeg: `run(item, signal)` makes one copy and says how it went.

/**
 * @typedef {"made" | "failed" | "cancelled"} Outcome
 *
 * @typedef {object} QueueItem
 * @property {string} name The copy's name (see `proxyName.js`); the identity of the work.
 *
 * @typedef {object} QueueDeps
 * @property {(item: any, signal: AbortSignal) => Promise<Outcome>} run Makes one copy. It must not
 *   throw; if it does, the item counts as failed.
 * @property {(item: any, outcome: Outcome) => void} [onFinished] After an item ended (not when it
 *   was cancelled).
 * @property {() => void} [onChange] After anything changed (an item started or ended, a video was
 *   cancelled).
 * @property {import("../log.js").Logger} log
 */

/**
 * @template {QueueItem} T
 * @param {QueueDeps} deps
 */
export function createCopyQueue(deps) {
  const { log } = deps;
  /** Waiting items, the next one first. @type {{ item: T, videos: Set<string> }[]} */
  let waiting = [];
  /** @type {{ item: T, videos: Set<string>, controller: AbortController, done: Promise<void> } | null} */
  let current = null;
  /** Names that failed; they are tried again after a restart or when the file changes (new name). @type {Set<string>} */
  const failed = new Set();
  let stopped = false;
  /** @type {(() => void)[]} */
  let idleWaiters = [];

  function changed() {
    try {
      deps.onChange?.();
    } catch (error) {
      log.warn("preview copies: a listener failed", error);
    }
  }

  function settleIdle() {
    if (current !== null || waiting.length > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const wake of waiters) wake();
  }

  /** Starts the next item when none runs. */
  function pump() {
    if (stopped || current !== null) return;
    const next = waiting.shift();
    if (!next) {
      settleIdle();
      return;
    }
    const controller = new AbortController();
    const entry = {
      item: next.item,
      videos: next.videos,
      controller,
      done: Promise.resolve(),
    };
    current = entry;
    entry.done = (async () => {
      /** @type {Outcome} */
      let outcome;
      try {
        outcome = await deps.run(next.item, controller.signal);
      } catch (error) {
        log.warn("preview copies: a copy ended with an error", error);
        outcome = "failed";
      }
      if (outcome === "failed") failed.add(next.item.name);
      current = null;
      if (outcome !== "cancelled") {
        try {
          deps.onFinished?.(next.item, outcome);
        } catch (error) {
          log.warn("preview copies: a listener failed", error);
        }
      }
      changed();
      pump();
    })();
    changed();
  }

  return {
    /**
     * Wants a copy for a video. Does nothing for a file that failed before.
     * @param {T} item
     * @param {string} videoKey
     * @param {{ first?: boolean }} [options] `first`: a video the user has open, ahead of the rest.
     * @returns {boolean} Whether the copy is queued, running or about to be (false: it failed).
     */
    want(item, videoKey, { first = false } = {}) {
      if (stopped || failed.has(item.name)) return false;
      if (current?.item.name === item.name) {
        current.videos.add(videoKey);
        return true;
      }
      const index = waiting.findIndex((entry) => entry.item.name === item.name);
      if (index >= 0) {
        const entry = /** @type {{ item: T, videos: Set<string> }} */ (waiting[index]);
        entry.videos.add(videoKey);
        if (first && index > 0) {
          waiting.splice(index, 1);
          waiting.unshift(entry);
        }
      } else {
        const entry = { item, videos: new Set([videoKey]) };
        if (first) waiting.unshift(entry);
        else waiting.push(entry);
      }
      pump();
      return true;
    },

    /**
     * A video no longer needs its copies (it was removed). Work nobody wants any more is dropped;
     * a running copy that nobody wants is ended.
     * @param {string} videoKey
     */
    cancelVideo(videoKey) {
      let touched = false;
      for (const entry of waiting) touched = entry.videos.delete(videoKey) || touched;
      const before = waiting.length;
      waiting = waiting.filter((entry) => entry.videos.size > 0);
      if (current?.videos.delete(videoKey)) {
        touched = true;
        if (current.videos.size === 0) current.controller.abort();
      }
      if (touched || waiting.length !== before) changed();
      settleIdle();
    },

    /** @param {string} name */
    hasFailed: (name) => failed.has(name),

    /** @param {string} name @returns {boolean} Whether the copy is queued or being made. */
    isPending: (name) =>
      current?.item.name === name || waiting.some((entry) => entry.item.name === name),

    /** @param {string} name @returns {boolean} */
    isRunning: (name) => current?.item.name === name,

    /** @returns {boolean} */
    busy: () => current !== null || waiting.length > 0,

    /** Resolves when nothing is queued or running. @returns {Promise<void>} */
    idle() {
      if (current === null && waiting.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },

    /** Ends the running copy, forgets the rest and resolves when it is over. @returns {Promise<void>} */
    async stop() {
      stopped = true;
      waiting = [];
      const running = current;
      if (running) {
        running.controller.abort();
        await running.done;
      }
      settleIdle();
    },
  };
}

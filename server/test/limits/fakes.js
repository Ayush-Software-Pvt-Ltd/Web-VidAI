// Fakes for the limits tests: a clock and timers that run by hand, and a scripted process table.

/**
 * A clock and timers driven by `advance`. Callbacks that return a promise are awaited, and the
 * event loop is let go after every one so continuations of async code have run before the next.
 * @param {number} [start] Milliseconds since 1970 (default: now, so file times look real).
 */
export function createFakeTime(start = Date.now()) {
  let now = start;
  let seq = 0;
  /** @type {{ id: number, at: number, every: number | null, fn: () => unknown, order: number }[]} */
  let entries = [];

  /** @param {number} ms @param {boolean} repeat @param {() => unknown} fn */
  function add(fn, ms, repeat) {
    seq += 1;
    entries.push({ id: seq, at: now + ms, every: repeat ? Math.max(1, ms) : null, fn, order: seq });
    return seq;
  }
  /** @param {unknown} handle */
  function clear(handle) {
    entries = entries.filter((entry) => entry.id !== handle);
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  return {
    clock: { now: () => now },
    timers: {
      setInterval: (/** @type {() => unknown} */ fn, /** @type {number} */ ms) => add(fn, ms, true),
      clearInterval: clear,
      setTimeout: (/** @type {() => unknown} */ fn, /** @type {number} */ ms) => add(fn, ms, false),
      clearTimeout: clear,
    },
    /** Timers that are still waiting. */
    pending: () => entries.length,
    flush,
    /** @param {number} ms */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = entries
          .filter((entry) => entry.at <= target)
          .sort((a, b) => a.at - b.at || a.order - b.order)[0];
        if (due === undefined) break;
        now = Math.max(now, due.at);
        if (due.every === null) entries = entries.filter((entry) => entry !== due);
        else {
          due.at += due.every;
          seq += 1;
          due.order = seq;
        }
        await due.fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

/**
 * @typedef {object} FakeProcess
 * @property {number} pid
 * @property {number} ppid
 * @property {number} pgid
 * @property {string} start
 * @property {number} rate CPU seconds per second while running.
 * @property {number} cpu
 * @property {boolean} stopped
 * @property {boolean} zombie
 */

/**
 * A scripted process table: processes burn `rate` CPU seconds per second of fake time while they
 * are not stopped. Every signal is logged.
 * @param {{ now(): number }} clock
 */
export function createFakeTable(clock) {
  /** @type {Map<number, FakeProcess>} */
  const procs = new Map();
  /** @type {{ pid: number, signal: string }[]} */
  const signals = [];
  let last = clock.now();
  let startCounter = 0;
  /** @type {Set<number>} */
  const failing = new Set();
  const state = { snapshotError: /** @type {Error | null} */ (null), snapshotNull: false };

  function accrue() {
    const seconds = (clock.now() - last) / 1000;
    last = clock.now();
    for (const p of procs.values()) if (!p.stopped && !p.zombie) p.cpu += p.rate * seconds;
  }

  const table = {
    procs,
    signals,
    state,
    /** Signals for this pid throw. @param {number} pid */
    failOn: (pid) => failing.add(pid),
    /**
     * @param {{ pid: number, ppid?: number, pgid?: number, rate?: number, cpu?: number, start?: string }} p
     * @returns {FakeProcess}
     */
    spawn(p) {
      accrue();
      startCounter += 1;
      /** @type {FakeProcess} */
      const proc = {
        pid: p.pid,
        ppid: p.ppid ?? 1,
        pgid: p.pgid ?? p.pid,
        start:
          p.start ??
          `Sun Nov 22 10:00:${String(startCounter % 60).padStart(2, "0")} 2026 #${startCounter}`,
        rate: p.rate ?? 0,
        cpu: p.cpu ?? 0,
        stopped: false,
        zombie: false,
      };
      procs.set(proc.pid, proc);
      return proc;
    },
    /** The process, which must exist. @param {number} pid @returns {FakeProcess} */
    get(pid) {
      const proc = procs.get(pid);
      if (proc === undefined) throw new Error(`no process ${pid}`);
      return proc;
    },
    /** @param {number} pid */
    kill(pid) {
      accrue();
      procs.delete(pid);
    },
    /** @param {number} pid @param {string} signal */
    count: (pid, signal) => signals.filter((s) => s.pid === pid && s.signal === signal).length,
    /** @param {number} pid */
    signalsTo: (pid) => signals.filter((s) => s.pid === pid),
    /** CPU seconds used so far by every process (also gone ones are not counted). */
    totalCpu() {
      accrue();
      let sum = 0;
      for (const p of procs.values()) sum += p.cpu;
      return sum;
    },
    /** @param {number[]} pids */
    stoppedAmong: (pids) => pids.filter((pid) => procs.get(pid)?.stopped === true),
    processes: {
      async snapshot() {
        if (state.snapshotError) throw state.snapshotError;
        if (state.snapshotNull) return null;
        accrue();
        return [...procs.values()].map((p) => ({
          pid: p.pid,
          ppid: p.ppid,
          pgid: p.pgid,
          zombie: p.zombie,
          stopped: p.stopped,
          start: p.start,
          cpu: p.cpu,
        }));
      },
      /** @param {number} pid @param {"SIGSTOP" | "SIGCONT"} signal */
      signal(pid, signal) {
        if (failing.has(pid)) throw new Error(`cannot signal ${pid}`);
        accrue();
        signals.push({ pid, signal });
        const p = procs.get(pid);
        if (p === undefined) return false;
        p.stopped = signal === "SIGSTOP";
        return true;
      },
    },
  };
  return table;
}

/** A logger that keeps what it is told. */
export function createFakeLog() {
  /** @type {{ level: string, message: string }[]} */
  const lines = [];
  return {
    lines,
    info: (/** @type {string} */ message) => lines.push({ level: "info", message }),
    warn: (/** @type {string} */ message) => lines.push({ level: "warn", message }),
    error: (/** @type {string} */ message) => lines.push({ level: "error", message }),
  };
}

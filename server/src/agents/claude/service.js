// Keeps `ClaudeInfo` and `UsageStatus` fresh (docs/SPEC.md sections 5 and 14; ported from
// src-tauri/src/claude/service.rs): the cached values, the reused usage helper process and the
// refresh schedule.
//
// - Usage: at startup, every `usageIntervalVisibleMs` while somebody watches (an open event
//   stream), every `usageIntervalJobsMs` while nobody watches but a job runs, on demand, and from
//   every `rate_limit_event` of a running job. One helper Claude Code process is reused for the
//   periodic `get_usage` requests: every `get_usage` is a live request to the server (verified
//   against Claude Code 2.1.319: a long-lived helper reports changes exactly when a fresh process
//   does), so reuse costs no freshness. The helper is replaced after `helperMaxAgeMs` (so a
//   Claude Code update or a new login is picked up) and closed after `helperIdleMs` without use.
//   Nobody watching and no job running: nothing is asked.
// - Info: at startup, on demand, and when the cached list is older than a day. Every fetch uses a
//   fresh short-lived process, so the model list and the defaults reflect the current settings.
//
// Both exist for the Claude subscription only (its model and effort pickers and its usage
// meters, SPEC section 5): on any other setup nothing here starts a Claude Code process (an
// OpenCode 2 setup never needs Claude Code at all), see `wanted`.
//
// The clock, the timers and every program are injected, so the schedule runs under a fake clock.

import { AppError } from "../../errors.js";
import { startControlClient } from "./control.js";
import { INITIALIZE_TIMEOUT_MS, MAX_AGE_MS, emptyInfo, fetchInfo, sameModels } from "./info.js";
import { emptyUsage, limitsFromRateLimitInfo, mergeLimits, parseUsage } from "./usage.js";

/** @typedef {import("../../../../src/lib/wire/usage.ts").ClaudeInfo} ClaudeInfo */
/** @typedef {import("../../../../src/lib/wire/usage.ts").UsageStatus} UsageStatus */
/** @typedef {import("./control.js").ControlClient} ControlClient */
/** @typedef {Readonly<Record<string, string | undefined>>} Env */

/**
 * The refresh schedule; every value is in milliseconds and tests shorten them.
 * @typedef {object} ServiceTimings
 * @property {number} usageIntervalVisibleMs Usage refresh while somebody watches (60 s).
 * @property {number} usageIntervalJobsMs Usage refresh while nobody watches but a job runs (5 min).
 * @property {number} helperMaxAgeMs The reused helper is replaced when it is older (1 h).
 * @property {number} helperIdleMs The reused helper is closed when it was not used for this long (10 min).
 * @property {number} usageTimeoutMs How long `get_usage` may take (30 s; it asks the server).
 * @property {number} tickMs How often the schedule looks at what is due (5 s).
 * @property {number} infoRetryEmptyMs After a failed info fetch while no list was ever fetched (60 s).
 * @property {number} infoRetryMs After a failed info fetch with an old list (1 h).
 * @property {number} infoMaxAgeMs How old the cached list may get before it is fetched again (24 h).
 */

/** @type {ServiceTimings} */
export const DEFAULT_TIMINGS = Object.freeze({
  usageIntervalVisibleMs: 60_000,
  usageIntervalJobsMs: 5 * 60_000,
  helperMaxAgeMs: 60 * 60_000,
  helperIdleMs: 10 * 60_000,
  usageTimeoutMs: 30_000,
  tickMs: 5000,
  infoRetryEmptyMs: 60_000,
  infoRetryMs: 60 * 60_000,
  infoMaxAgeMs: MAX_AGE_MS,
});

/** Working folder of the helper processes, inside the data directory. */
export const HELPER_DIR = "claude-helper";

/** The setups for which the helper is asked: only the Claude subscription (see the header). */
const METERED_SETUPS = new Set(["claudeSubscription"]);

/**
 * Whether the Claude Code helper is asked for the model list and the usage limits on `setup`:
 * only the Claude subscription shows them (the pickers and the meters). The other three setups
 * choose their model in the admin settings and show their own quota, so a helper process for
 * them would be wasted work, and an error (Claude Code is not installed) that no one asked for.
 * @param {string} setup
 * @returns {boolean}
 */
export function metersWanted(setup) {
  return METERED_SETUPS.has(setup);
}

/**
 * @typedef {object} ServiceDeps
 * @property {string} helperDir The working folder of the helper processes (created when missing).
 * @property {() => Env} env The complete environment of the helper (asked at every start).
 * @property {{ now(): number }} clock
 * @property {{ setInterval: typeof setInterval, clearInterval: typeof clearInterval }} timers
 * @property {() => boolean} wanted Whether the active setup uses the helper (`metersWanted`).
 * @property {() => string | null | Promise<string | null>} locate The `claude` program, or `null`
 *   when it is not installed.
 * @property {(bin: string, env: Env) => Promise<boolean>} isLoggedIn
 * @property {(options: import("./control.js").StartControlOptions) => ControlClient} [startClient]
 *   Default `startControlClient`.
 * @property {(status: UsageStatus) => void} [onUsage] Called when the usage status changed
 *   (limits, availability or error; not for a later `fetchedAt` alone).
 * @property {(info: ClaudeInfo, previous: ClaudeInfo) => void} [onInfo] Called when a fetch gave a
 *   different model list or default model than before (the owner of the saved selection checks
 *   it again then).
 * @property {(message: string, detail?: unknown) => void} [log] Receives background failures.
 * @property {Partial<ServiceTimings>} [timings]
 * @property {number} [exitGraceMs] Passed to the helper clients (tests shorten it).
 */

/**
 * @param {ServiceDeps} deps
 */
export function createClaudeService(deps) {
  const { clock, timers } = deps;
  /** @type {ServiceTimings} */
  const timings = { ...DEFAULT_TIMINGS, ...deps.timings };
  const startClient = deps.startClient ?? startControlClient;
  /** @param {string} message @param {unknown} [detail] */
  const log = (message, detail) => deps.log?.(message, detail);

  /** @type {UsageStatus} */
  let usage = emptyUsage();
  /** @type {ClaudeInfo} */
  let info = emptyInfo();

  /** The reused usage helper. @type {{ client: ControlClient, bin: string } | null} */
  let helper = null;
  /** @type {number | null} */
  let helperLastUsed = null;
  /** @type {number | null} */
  let usageLastAttempt = null;
  /** @type {Promise<UsageStatus> | null} */
  let usageRunning = null;
  /** @type {number | null} */
  let infoLastAttempt = null;
  /** @type {Promise<ClaudeInfo> | null} */
  let infoRunning = null;
  /** Every helper process that is alive, so `stop` leaves none behind. @type {Set<ControlClient>} */
  const live = new Set();

  let watchers = 0;
  let jobsRunning = false;
  let stopped = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let ticker = null;

  /**
   * @param {string} bin
   * @param {Env} env
   * @param {string} cwd
   * @returns {ControlClient}
   */
  function spawnHelper(bin, env, cwd) {
    if (stopped) throw new AppError("internal", "The Claude Code helper was stopped.");
    const client = startClient({
      command: bin,
      env,
      cwd,
      clock,
      ...(deps.exitGraceMs === undefined ? {} : { exitGraceMs: deps.exitGraceMs }),
    });
    live.add(client);
    return client;
  }

  /**
   * Ends a helper and forgets it.
   * @param {ControlClient} client
   * @returns {Promise<void>}
   */
  async function closeClient(client) {
    try {
      await client.close();
    } finally {
      live.delete(client);
    }
  }

  async function dropHelper() {
    const old = helper;
    helper = null;
    if (old !== null) await closeClient(old.client);
  }

  /**
   * `get_usage` on the reused helper, starting a new one when there is none, it stopped, it is
   * older than the maximum age or `bin` changed. A failure of a reused helper is retried once on
   * a fresh process.
   * @param {string} bin
   * @param {Env} env
   * @returns {Promise<{ available: boolean, limits: import("../../../../src/lib/wire/usage.ts").UsageLimit[] }>}
   */
  async function helperUsage(bin, env) {
    const reusable =
      helper !== null &&
      helper.bin === bin &&
      helper.client.isAlive() &&
      clock.now() - helper.client.startedAt < timings.helperMaxAgeMs;
    if (!reusable) await dropHelper();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (helper === null) {
        const client = spawnHelper(bin, env, deps.helperDir);
        try {
          await client.request("initialize", INITIALIZE_TIMEOUT_MS);
        } catch (error) {
          await closeClient(client);
          throw error;
        }
        helper = { client, bin };
      }
      const fresh = !reusable || attempt > 0;
      const { client } = helper;
      helperLastUsed = clock.now();
      try {
        return parseUsage(await client.request("get_usage", timings.usageTimeoutMs));
      } catch (error) {
        await dropHelper();
        if (fresh) throw error;
      }
    }
    throw new AppError("internal", "Claude Code did not report usage.");
  }

  /**
   * The program to run, after checking that it is installed and logged in.
   * @returns {Promise<string>}
   */
  async function readyProgram() {
    const bin = await deps.locate();
    if (bin === null) {
      throw new AppError("notReady", "Claude Code is not installed on the server.");
    }
    if (!(await deps.isLoggedIn(bin, deps.env()))) {
      throw new AppError("notReady", "Claude Code is not logged in on the server.");
    }
    return bin;
  }

  /**
   * Sets the status; tells the owner when limits, availability or error changed.
   * @param {UsageStatus} next
   */
  function setUsage(next) {
    const before = usage;
    usage = next;
    const same =
      before.available === next.available &&
      before.error === next.error &&
      JSON.stringify(before.limits) === JSON.stringify(next.limits);
    if (same) return;
    try {
      deps.onUsage?.(next);
    } catch (error) {
      log("The usage listener failed.", error);
    }
  }

  /** @returns {Promise<UsageStatus>} */
  function runUsageRefresh() {
    usageLastAttempt = clock.now();
    return (async () => {
      try {
        const bin = await readyProgram();
        const { available, limits } = await helperUsage(bin, deps.env());
        setUsage({ available, limits, fetchedAt: clock.now(), error: null });
      } catch (error) {
        // A refresh cut short by `stop` is not a failure worth showing.
        if (stopped) return usage;
        const message =
          error instanceof Error ? error.message : "Claude Code did not report usage.";
        setUsage({ ...usage, error: message });
      }
      return usage;
    })();
  }

  /**
   * Asks Claude Code for the usage limits now and returns the new status; a refresh that is
   * already running is joined. A failure keeps the last values and sets `error`.
   * @returns {Promise<UsageStatus>}
   */
  function refreshUsage() {
    if (!deps.wanted() || stopped) return Promise.resolve(usage);
    if (usageRunning !== null) return usageRunning;
    const run = runUsageRefresh();
    usageRunning = run;
    const done = () => {
      if (usageRunning === run) usageRunning = null;
    };
    run.then(done, done);
    return run;
  }

  /**
   * Applies the 5-hour and weekly limits of a `rate_limit_event`'s `rate_limit_info`. The status
   * is announced when anything changed. Never throws.
   * @param {unknown} rateLimitInfo
   */
  function recordRateLimitEvent(rateLimitInfo) {
    const updates = limitsFromRateLimitInfo(rateLimitInfo);
    if (updates.length === 0) return;
    const merged = mergeLimits(usage.limits, updates);
    if (!merged.changed && usage.available) return;
    setUsage({ available: true, limits: merged.limits, fetchedAt: clock.now(), error: null });
  }

  /** @returns {Promise<ClaudeInfo>} */
  function runInfoFetch() {
    infoLastAttempt = clock.now();
    return (async () => {
      const bin = await deps.locate();
      if (bin === null) {
        throw new AppError("notReady", "Claude Code is not installed on the server.");
      }
      const client = spawnHelper(bin, deps.env(), deps.helperDir);
      /** @type {ClaudeInfo} */
      let fetched;
      try {
        fetched = await fetchInfo(client, clock.now());
      } finally {
        await closeClient(client);
      }
      const previous = info;
      info = fetched;
      if (previous.fetchedAt === null || !sameModels(previous, fetched)) {
        try {
          deps.onInfo?.(fetched, previous);
        } catch (error) {
          log("The model list listener failed.", error);
        }
      }
      return fetched;
    })();
  }

  /**
   * Fetches `ClaudeInfo` from a fresh helper process; a fetch that is already running is joined.
   * On failure the cached list is kept and the error is thrown. On a setup that does not use the
   * helper the cache is returned untouched.
   * @returns {Promise<ClaudeInfo>}
   */
  function refreshInfo() {
    if (!deps.wanted() || stopped) return Promise.resolve(info);
    if (infoRunning !== null) return infoRunning;
    const run = runInfoFetch();
    infoRunning = run;
    const done = () => {
      if (infoRunning === run) infoRunning = null;
    };
    run.then(done, done);
    return run;
  }

  /** Closes the reused helper when it has not been used for the idle time. */
  function closeIdleHelper() {
    if (helper === null || usageRunning !== null) return;
    if (helperLastUsed === null || clock.now() - helperLastUsed >= timings.helperIdleMs) {
      void dropHelper().catch((error) => log("Ending the Claude Code helper failed.", error));
    }
  }

  /** Whether the usage is due for its periodic refresh. */
  function usageDue() {
    const interval =
      watchers > 0
        ? timings.usageIntervalVisibleMs
        : jobsRunning
          ? timings.usageIntervalJobsMs
          : null;
    if (interval === null || usageRunning !== null) return false;
    return usageLastAttempt === null || clock.now() - usageLastAttempt >= interval;
  }

  /** Whether the cached info is due for its unprompted refresh. */
  function infoDue() {
    const age = info.fetchedAt === null ? null : clock.now() - info.fetchedAt;
    if (age !== null && age < timings.infoMaxAgeMs) return false;
    if (infoRunning !== null) return false;
    const retry = info.fetchedAt === null ? timings.infoRetryEmptyMs : timings.infoRetryMs;
    return infoLastAttempt === null || clock.now() - infoLastAttempt >= retry;
  }

  /** Looks at what is due; called every tick and when somebody starts watching. */
  function tick() {
    if (stopped) return;
    if (deps.wanted() && usageDue()) {
      void refreshUsage();
    } else {
      closeIdleHelper();
    }
    if (deps.wanted() && infoDue()) {
      refreshInfo().catch((error) => log("Fetching the Claude Code model list failed.", error));
    }
  }

  return {
    /** The last known usage status. @returns {UsageStatus} */
    usage: () => usage,

    /** The last fetched model list and defaults (empty before the first fetch). @returns {ClaudeInfo} */
    info: () => info,

    /**
     * A fetch that is running now, or `null`: lets a caller wait for the startup fetch without
     * starting one.
     * @returns {Promise<unknown> | null}
     */
    pendingInfo: () => infoRunning,

    refreshUsage,
    refreshInfo,
    recordRateLimitEvent,

    /**
     * How many event streams are open: usage is refreshed every minute while there is one.
     * Somebody starting to watch triggers a look at what is due at once.
     * @param {number} count
     */
    setWatchers(count) {
      const before = watchers;
      watchers = Math.max(0, count);
      if (before === 0 && watchers > 0 && ticker !== null) tick();
    },

    /** Whether a job runs: usage is then refreshed every 5 minutes even without watchers. @param {boolean} running */
    setJobsRunning(running) {
      jobsRunning = running;
    },

    /**
     * Starts the background work: the first info and usage fetches, then the schedule. Returns
     * a promise for the first fetches; it never rejects and nobody has to wait for it.
     * @returns {Promise<void>}
     */
    start() {
      if (ticker !== null || stopped) return Promise.resolve();
      ticker = timers.setInterval(tick, timings.tickMs);
      ticker.unref?.();
      const first = [
        refreshInfo().catch((error) => log("Fetching the Claude Code model list failed.", error)),
        refreshUsage(),
      ];
      return Promise.all(first).then(() => undefined);
    },

    /**
     * Stops the schedule and ends every helper process, also while a request is pending. Nothing
     * is started afterwards.
     * @returns {Promise<void>}
     */
    async stop() {
      stopped = true;
      if (ticker !== null) {
        timers.clearInterval(ticker);
        ticker = null;
      }
      helper = null;
      await Promise.all([...live].map((client) => closeClient(client)));
      // A refresh that was running ends with the closed helper; let it finish.
      await Promise.allSettled([usageRunning, infoRunning]);
    },
  };
}

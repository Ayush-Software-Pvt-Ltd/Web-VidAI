// Claude Code login state (docs/SPEC.md section 5, "Finding and checking Claude Code"; ported
// from src-tauri/src/claude/auth.rs).
//
// Runs `claude auth status`, which prints JSON containing `loggedIn`. On the server this is the
// login of the OS user that runs the server (SPEC section 5).
//
// Only the `loggedIn` field is read; the rest of the output (account details) is never stored,
// logged or passed on.
//
// A positive answer is remembered for `POSITIVE_TTL_MS` so a check is cheap enough to make before
// every job start. A negative answer is never remembered, so the server recovers the moment
// somebody logs in.

import { AppError } from "../../errors.js";
import { runHelper } from "../../platform/process.js";

/** How long a successful login check is trusted. */
export const POSITIVE_TTL_MS = 120_000;
/** How long `claude auth status` may take. */
export const STATUS_TIMEOUT_MS = 20_000;

/**
 * The `loggedIn` value of `claude auth status` output, or `null` when it is not that JSON.
 * Tolerates text before or after the JSON object (the JSON is taken from the first `{` to the
 * last `}`).
 * @param {string} stdout
 * @returns {boolean | null}
 */
export function parseStatus(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    /** @type {unknown} */
    const value = JSON.parse(stdout.slice(start, end + 1));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const loggedIn = /** @type {Record<string, unknown>} */ (value)["loggedIn"];
    return typeof loggedIn === "boolean" ? loggedIn : null;
  } catch {
    return null;
  }
}

/** @typedef {Readonly<Record<string, string | undefined>>} Env */

/**
 * @typedef {object} LoginCheckDeps
 * @property {{ now(): number }} clock
 * @property {typeof runHelper} [run] How a program is run (default: `runHelper`; tests pass a
 *   recording stand-in).
 * @property {number} [ttlMs] Default `POSITIVE_TTL_MS`.
 * @property {number} [timeoutMs] Default `STATUS_TIMEOUT_MS`.
 */

/**
 * The login check with its cache of positive answers. One per server (no module-level state).
 * @param {LoginCheckDeps} deps
 */
export function createLoginCheck(deps) {
  const run = deps.run ?? runHelper;
  const ttlMs = deps.ttlMs ?? POSITIVE_TTL_MS;
  const timeoutMs = deps.timeoutMs ?? STATUS_TIMEOUT_MS;
  /** The program that was last seen logged in, and when. @type {{ bin: string, at: number } | null} */
  let remembered = null;
  /** Counts `forgetLogin` calls: a check that started before one must not remember its answer. */
  let generation = 0;
  /** The check that is running, so concurrent callers share one process. @type {Map<string, Promise<boolean>>} */
  const running = new Map();

  /** @param {string} bin */
  function isFresh(bin) {
    return (
      remembered !== null && remembered.bin === bin && deps.clock.now() - remembered.at < ttlMs
    );
  }

  /**
   * Runs `claude auth status` now (no cache) and remembers a positive answer.
   *
   * Output that is not the expected JSON (for example from a Claude Code too old to have
   * `auth status`) counts as not logged in. Throws only when the command cannot run at all or
   * does not answer in time.
   * @param {string} bin
   * @param {Env} env The environment `claude` runs in (nothing else is inherited).
   * @returns {Promise<boolean>}
   */
  function checkNow(bin, env) {
    const shared = running.get(bin);
    if (shared !== undefined) return shared;
    const started = generation;
    const check = (async () => {
      /** @type {import("../../platform/process.js").HelperResult} */
      let result;
      try {
        result = await run({ command: bin, args: ["auth", "status"], env, timeoutMs });
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        throw new AppError("internal", `Checking the Claude Code login failed: ${why}`);
      }
      if (result.timedOut) {
        throw new AppError(
          "internal",
          `Checking the Claude Code login failed: no answer within ${Math.round(timeoutMs / 1000)} seconds.`,
        );
      }
      const loggedIn = parseStatus(result.stdout) ?? false;
      if (started === generation) remembered = loggedIn ? { bin, at: deps.clock.now() } : null;
      return loggedIn;
    })();
    running.set(bin, check);
    const forget = () => {
      if (running.get(bin) === check) running.delete(bin);
    };
    check.then(forget, forget);
    return check;
  }

  return {
    /**
     * Whether Claude Code is logged in: a positive answer younger than the cache time is
     * trusted, anything else asks `claude auth status`.
     * @param {string} bin
     * @param {Env} env
     * @returns {Promise<boolean>}
     */
    async isLoggedIn(bin, env) {
      if (isFresh(bin)) return true;
      return checkNow(bin, env);
    },

    checkNow,

    /**
     * Forgets a remembered positive answer, for example after a job found Claude Code logged
     * out, so the next check asks `claude auth status` again.
     */
    forgetLogin() {
      generation += 1;
      remembered = null;
    },
  };
}

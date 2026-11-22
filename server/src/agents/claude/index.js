// The Claude Code module (docs/SPEC.md sections 5 and 14): the login of the OS user that runs the
// server, the model list and the plan's usage meter, which every signed-in user sees read-only.
//
//   const claude = createClaudeModule({ events, dataDir, env: process.env, clock, log, setupOf });
//   rpc.register(claude.rpc);
//   claude.start();
//   ...
//   await claude.stop();
//
// Other modules call the provider functions directly (they are not RPC functions):
// `claudeModels()` for the admin harness screen, `claudeLoggedIn()` and `locate()` for readiness
// and the System page, `ensureReady()` before a job starts, `recordRateLimitEvent()` from the
// jobs' event stream, `forgetLogin()` when a job found Claude Code logged out, `setWatchers()`
// and `setJobsRunning()` for the refresh schedule.
//
// The helper process is only ever started while the active setup is the Claude subscription (the
// one setup that has a Claude model list and Claude meters); on any other setup this module
// never runs `claude` on its own.

import path from "node:path";
import { AppError } from "../../errors.js";
import { boolean, object, optional } from "../../rpc/validate.js";
import { detectRouting } from "../opencode/routing.js";
import { createLoginCheck } from "./auth.js";
import { agentEnv } from "./env.js";
import { findClaude, locateClaude } from "./locate.js";
import { HELPER_DIR, createClaudeService, metersWanted } from "./service.js";

export { normalizeSelection } from "./info.js";
export { metersWanted } from "./service.js";

/** @typedef {import("../../../../src/lib/wire/usage.ts").ClaudeInfo} ClaudeInfo */
/** @typedef {import("../../../../src/lib/wire/usage.ts").UsageStatus} UsageStatus */
/** @typedef {import("../../../../src/lib/wire/usage.ts").UsageView} UsageView */
/** @typedef {import("../../../../src/lib/wire/harness.ts").OpencodeUsage} OpencodeUsage */
/** @typedef {import("../../../../src/lib/wire/harness.ts").ClaudeModelInfo} ClaudeModelInfo */
/** @typedef {import("../../rpc/index.js").RpcFunction} RpcFunction */

/**
 * @typedef {object} ClaudeDeps Everything is injected; nothing here is global.
 * @property {import("../../rpc/index.js").Events} events Gets `usage-updated`.
 * @property {string} dataDir The data directory; the helper works in `<dataDir>/claude-helper`.
 * @property {Readonly<Record<string, string | undefined>>} env The server's environment (the
 *   base of what `claude` runs in, see `agentEnv`).
 * @property {import("../../db/open.js").Clock} clock
 * @property {import("../../log.js").Logger} log
 * @property {Partial<import("./service.js").ServiceTimings>} [timings]
 * @property {() => import("../../../../src/lib/wire.ts").Setup} [setupOf] The active setup
 *   (default: the Claude subscription).
 * @property {string} [home] The home directory of the OS user that runs the server (default: the
 *   environment's `HOME` or `USERPROFILE`); where `~/.claude` is.
 * @property {(refresh: boolean) => OpencodeUsage | Promise<OpencodeUsage>} [opencodeUsage] The
 *   OpenCode Go quota, which `getUsage` adds while the active setup is OpenCode Go.
 * @property {(info: ClaudeInfo, previous: ClaudeInfo) => void} [onInfoChange] Called when a
 *   fetch changed the model list or the default model: the owner of the saved model selection
 *   checks it again with `normalizeSelection`.
 * @property {{ setInterval: typeof setInterval, clearInterval: typeof clearInterval }} [timers]
 * @property {(options: import("./control.js").StartControlOptions) => import("./control.js").ControlClient} [startClient]
 * @property {typeof import("../../platform/process.js").runHelper} [run] How `claude auth status`
 *   is run (tests).
 * @property {number} [exitGraceMs] How long a closed helper may take to exit (tests).
 */

/**
 * @param {ClaudeDeps} deps
 */
export function createClaudeModule(deps) {
  const { events, clock, log } = deps;
  const setupOf = deps.setupOf ?? (() => "claudeSubscription");
  // An explicit home wins over the environment, so a test never reads the real `~/.claude`.
  const base =
    deps.home === undefined ? deps.env : { ...deps.env, HOME: deps.home, USERPROFILE: deps.home };
  /** @returns {Record<string, string>} The environment `claude` runs in. */
  const childEnv = () => agentEnv(base);

  const login = createLoginCheck({ clock, run: deps.run });

  /** @returns {string | null} The program, or `null` when Claude Code is not installed. */
  const find = () => findClaude(childEnv());

  const service = createClaudeService({
    helperDir: path.join(deps.dataDir, HELPER_DIR),
    env: childEnv,
    clock,
    timers: deps.timers ?? { setInterval, clearInterval },
    wanted: () => metersWanted(setupOf()),
    locate: find,
    isLoggedIn: (bin, env) => login.isLoggedIn(bin, env),
    startClient: deps.startClient,
    timings: deps.timings,
    exitGraceMs: deps.exitGraceMs,
    onUsage: (status) =>
      events.emit({
        event: "usage-updated",
        payload: { claude: status },
        userId: null,
        admins: false,
      }),
    onInfo: deps.onInfoChange,
    log: (message, detail) => log.warn(message, detail),
  });

  /** @type {RpcFunction[]} */
  const rpc = [
    // The plan's usage limits, cached unless `refresh`; read-only for every user (SPEC section 5).
    {
      name: "getUsage",
      access: "user",
      async handler(raw) {
        const input = object({ refresh: optional(boolean) })(raw ?? {});
        const refresh = input.refresh === true;
        const claude = refresh ? await service.refreshUsage() : service.usage();
        const opencode =
          setupOf() === "opencodeGo" && deps.opencodeUsage !== undefined
            ? await deps.opencodeUsage(refresh)
            : null;
        return /** @type {UsageView} */ ({ claude, opencode });
      },
    },
  ];

  return {
    name: "claude",
    rpc,
    service,

    /**
     * Starts the first model list and usage fetches and the refresh schedule. Returns a promise
     * for the first fetches; it never rejects and nobody has to wait for it.
     * @returns {Promise<void>}
     */
    start: () => service.start(),

    /** Stops the schedule and ends every helper process. @returns {Promise<void>} */
    stop: () => service.stop(),

    /** The last known usage status of the Claude plan. @returns {UsageStatus} */
    usage: () => service.usage(),

    /** Asks Claude Code for the usage now. @returns {Promise<UsageStatus>} */
    refreshNow: () => service.refreshUsage(),

    /** The last fetched list, defaults, plan and version. @returns {ClaudeInfo} */
    info: () => service.info(),

    /**
     * The models Claude Code offers (empty before the first fetch, or when the active setup is
     * not the Claude subscription). Waits for a fetch that is running, never starts one.
     * @returns {Promise<ClaudeModelInfo[]>}
     */
    async claudeModels() {
      const running = service.pendingInfo();
      if (running !== null) await running.catch(() => undefined);
      return service.info().models;
    },

    /** Fetches the list again now. @returns {Promise<ClaudeInfo>} */
    refreshInfo: () => service.refreshInfo(),

    /**
     * Whether Claude Code is installed and `claude auth status` says it is logged in; a positive
     * answer is trusted for 2 minutes. `false` also when the check could not run.
     * @returns {Promise<boolean>}
     */
    async claudeLoggedIn() {
      const bin = find();
      if (bin === null) return false;
      try {
        return await login.isLoggedIn(bin, childEnv());
      } catch (error) {
        log.warn("Checking the Claude Code login failed.", error);
        return false;
      }
    },

    /**
     * Finds Claude Code and its version: `{ path, version }` (`version` is `null` when the file
     * does not answer `--version`), or `null` when it is nowhere.
     * @returns {Promise<{ path: string, version: string | null } | null>}
     */
    locate: () => locateClaude(childEnv()),

    /**
     * The program to start a Claude Code job with, after checking that it is installed and
     * logged in.
     * @returns {Promise<string>}
     * @throws {AppError} `notReady` with a sentence for the admin.
     */
    async ensureReady() {
      const bin = find();
      if (bin === null) {
        throw new AppError("notReady", "Claude Code is not installed on the server.");
      }
      if (!(await login.isLoggedIn(bin, childEnv()))) {
        throw new AppError("notReady", "Claude Code is not logged in on the server.");
      }
      return bin;
    },

    /** Drops a remembered login, after a job found Claude Code logged out. */
    forgetLogin: () => login.forgetLogin(),

    /**
     * Feeds the `rate_limit_info` of a job's `rate_limit_event` into the meter (the `raw` of the
     * parsed event). Never blocks, never throws.
     * @param {unknown} rateLimitInfo
     */
    recordRateLimitEvent: (rateLimitInfo) => service.recordRateLimitEvent(rateLimitInfo),

    /** How many event streams are open (usage is refreshed every minute while there is one). @param {number} count */
    setWatchers: (count) => service.setWatchers(count),

    /** Whether a job runs (usage is then refreshed every 5 minutes without watchers). @param {boolean} running */
    setJobsRunning: (running) => service.setJobsRunning(running),

    /**
     * Where the server's own Claude Code setup points `ANTHROPIC_BASE_URL`, if it does:
     * `ANTHROPIC_BASE_URL` in `<home>/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`) wins over
     * the environment, as in Claude Code.
     * @returns {Promise<import("../../../../src/lib/wire/usage.ts").ClaudeRouting | null>}
     */
    routing: () => detectRouting({ env: childEnv() }),
  };
}

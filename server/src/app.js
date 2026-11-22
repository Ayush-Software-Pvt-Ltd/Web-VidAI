// The composition root of VidAI Server (docs/SPEC.md sections 2, 3, 4 and 14): builds every part
// from a config, starts listening and stops everything again. `main.js` is only the executable
// around it; tests build an app of their own on port 0 in a temporary data directory.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createSessions } from "./auth/sessions.js";
import { withEndNotice } from "./auth/sessionEnds.js";
import { createSetup } from "./auth/setup.js";
import { createThrottle } from "./auth/throttle.js";
import { prepareDataDir } from "./config.js";
import { openDatabase, systemClock } from "./db/open.js";
import { createSessionsRepo } from "./db/sessions.js";
import { createSettingsRepo } from "./db/settings.js";
import { createUsersRepo } from "./db/users.js";
import { createEngine } from "./engine.js";
import { createEventBus } from "./events.js";
import { localIdentity } from "./http/addresses.js";
import { createHttpServer } from "./http/server.js";
import { ensureCertificate } from "./http/tls.js";
import { createLogger } from "./log.js";
import { createRpc } from "./rpc/index.js";
import { createSecrets } from "./secrets.js";
import { createSettings } from "./settings.js";

/** One hour: how often sessions idle for 30 days are deleted (SPEC section 4). */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Everything a module may use; modules written as a function receive it.
 * @typedef {object} AppContext
 * @property {import("./config.js").Config} config
 * @property {Record<string, string | undefined>} env
 * @property {import("./config.js").DataPaths} paths
 * @property {import("./log.js").Logger} log
 * @property {import("./db/open.js").Clock} clock
 * @property {import("./db/open.js").Database} db
 * @property {ReturnType<typeof createUsersRepo>} users
 * @property {ReturnType<typeof withEndNotice<ReturnType<typeof createSessions>>>} sessions
 * @property {ReturnType<typeof createSettings>} settings
 * @property {ReturnType<typeof createSecrets>} secrets
 * @property {import("./events.js").EventBus} events
 * @property {string} version
 *
 * A part of the server that plugs in by one entry of `modules` (job engine, storage, library,
 * timeline). Everything is optional except the name.
 * @typedef {object} AppModule
 * @property {string} name For the log.
 * @property {import("./rpc/index.js").RpcFunction[]} [rpc] Registered before the first request.
 * @property {import("./http/types.js").Route[]} [routes] Added to the HTTP server's routes.
 * @property {Partial<import("./rpc/index.js").Hooks>} [hooks] Reactions to account changes;
 *   every module's hook runs, in module order (`activeJobCount` adds up).
 * @property {() => void | Promise<void>} [start] Runs in module order before the server listens.
 * @property {() => void | Promise<void>} [stop] Runs in reverse module order on `stop()`, also for a
 *   module whose `start` never ran or failed, so it must cope with that.
 *
 * @typedef {AppModule | ((context: AppContext) => AppModule)} ModuleSource
 *
 * @typedef {object} AppOptions Timings and test seams; every one has a real default.
 * @property {ModuleSource[]} [modules] Run after the built-in modules.
 * @property {number} [purgeIntervalMs] How often expired sessions are deleted (one hour).
 * @property {import("./http/types.js").HttpOptions} [http]
 * @property {{ release(): void } | null} [lock] The data directory lock, released by `stop()`.
 * @property {string} [version] Reported as `serverVersion`.
 * @property {import("./engine.js").EngineOptions} [engine] Test seams of the built-in modules
 *   (a partial dependency bag per module, see `engine.js`); never used in production.
 *
 * @typedef {object} StartInfo
 * @property {number} port The port actually bound (the config may ask for 0).
 * @property {string[]} addresses Every URL the server can be reached at.
 * @property {string | null} setupUrl The one-time first-admin address, null when an admin exists.
 * @property {string | null} adminCreatedFromEnv Email of the admin made from `VIDAI_ADMIN_EMAIL`
 *   and `VIDAI_ADMIN_PASSWORD` on this start, or null.
 */

/**
 * The modules that are part of the server, in START order (stop is the reverse). The order and the
 * reason for each dependency are written in `engine.js`, and nowhere else.
 * @param {AppContext} context
 * @param {import("./engine.js").EngineOptions} [engine]
 * @returns {ReturnType<typeof createEngine>}
 */
function builtinModules(context, engine) {
  const modules = createEngine(context, engine);
  context.sessions.onEnd(modules.sessionEnded);
  return modules;
}

/** @returns {string} */
function packageVersion() {
  try {
    const text = fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    const version = /** @type {{ version?: unknown }} */ (JSON.parse(text)).version;
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Build the server from a config. Opens the database at once (so it can be inspected before
 * `start`); nothing listens until `start()`.
 * @param {object} input
 * @param {import("./config.js").Config} input.config
 * @param {Record<string, string | undefined>} [input.env] Defaults to the process environment.
 * @param {import("./log.js").Logger} [input.log] Defaults to `server.log` in the data directory.
 * @param {import("./db/open.js").Clock} [input.clock]
 * @param {AppOptions} [input.options]
 */
export function createApp({ config, env = process.env, log, clock = systemClock, options = {} }) {
  const paths = prepareDataDir(config.dataDir);
  const logger = log ?? createLogger({ file: paths.serverLog, clock });
  const db = openDatabase(paths.db, { clock });
  try {
    return build({ config, env, paths, log: logger, clock, db, options });
  } catch (error) {
    db.close();
    options.lock?.release();
    throw error;
  }
}

/**
 * @param {{
 *   config: import("./config.js").Config,
 *   env: Record<string, string | undefined>,
 *   paths: import("./config.js").DataPaths,
 *   log: import("./log.js").Logger,
 *   clock: import("./db/open.js").Clock,
 *   db: import("./db/open.js").Database,
 *   options: AppOptions,
 * }} input
 */
function build({ config, env, paths, log, clock, db, options }) {
  const version = options.version ?? packageVersion();
  const instanceId = randomUUID();
  const events = createEventBus({
    onError: (error) => {
      log.error("An event listener failed.", error);
    },
  });
  const users = createUsersRepo(db, { clock });
  const sessionsRepo = createSessionsRepo(db);
  const sessions = withEndNotice(
    createSessions({ sessions: sessionsRepo, users, clock }),
    sessionsRepo,
  );
  const settings = createSettings({ repo: createSettingsRepo(db) });
  const secrets = createSecrets({
    db,
    keyFile: paths.secretKey,
    memory: env.VIDAI_SECRETS === "memory",
    log,
  });
  const throttle = createThrottle({ clock });
  const setup = createSetup({ users, log });

  /** @type {AppContext} */
  const context = {
    config,
    env,
    paths,
    log,
    clock,
    db,
    users,
    sessions,
    settings,
    secrets,
    events,
    version,
  };
  const builtin = builtinModules(context, options.engine);
  /** @type {AppModule[]} */
  const modules = [...builtin, ...(options.modules ?? [])].map((source) =>
    typeof source === "function" ? source(context) : source,
  );

  // Hooks of every module in one object, looked up when called so order and later changes hold.
  /** @type {import("./rpc/index.js").Hooks} */
  const hooks = {
    async onUserRemoved(userId) {
      for (const module of modules) await module.hooks?.onUserRemoved?.(userId);
    },
    async afterUserRemoved(userId) {
      for (const module of modules) await module.hooks?.afterUserRemoved?.(userId);
    },
    async onUserDisabled(userId) {
      for (const module of modules) await module.hooks?.onUserDisabled?.(userId);
    },
    async beforeSettingsChange(clean) {
      for (const module of modules) await module.hooks?.beforeSettingsChange?.(clean);
    },
    activeJobCount: (userId) =>
      modules.reduce((sum, module) => sum + (module.hooks?.activeJobCount?.(userId) ?? 0), 0),
  };

  const rpc = createRpc({
    db,
    users,
    sessions,
    settings,
    secrets,
    throttle,
    setup,
    events,
    clock,
    version,
    hooks,
  });
  for (const module of modules) if (module.rpc) rpc.register(module.rpc);

  /** @type {ReturnType<typeof createHttpServer> | null} */
  let http = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let purgeTimer = null;
  /** @type {"new" | "starting" | "running"} */
  let state = "new";
  /** @type {Promise<void> | null} */
  let stopping = null;

  /** @param {string} what @param {() => unknown} work */
  async function attempt(what, work) {
    try {
      await work();
    } catch (error) {
      log.error(`${what} failed.`, error);
    }
  }

  /** How many modules had their `start` called (the failing one included): only those are stopped. */
  let reached = 0;

  async function shutDown() {
    if (purgeTimer) clearInterval(purgeTimer);
    purgeTimer = null;
    for (const module of modules.slice(0, reached).reverse()) {
      if (module.stop) await attempt(`Stopping ${module.name}`, () => module.stop?.());
    }
    if (http) await attempt("Closing the HTTP server", () => http?.close());
    await attempt("Closing the database", () => {
      db.close();
    });
    await attempt("Releasing the data folder lock", () => {
      options.lock?.release();
    });
  }

  /**
   * Stop the modules (reverse order), the HTTP server and the database, and release the lock.
   * Safe to call again, before `start`, and after a failed `start`.
   * @returns {Promise<void>}
   */
  function stop() {
    stopping ??= shutDown();
    return stopping;
  }

  return {
    config,
    paths,
    log,
    db,
    users,
    sessions,
    settings,
    secrets,
    throttle,
    setup,
    events,
    rpc,
    modules,
    /** The built-in modules' `api` objects (tests and tools; not used by the server itself). */
    engine: builtin.api,
    instanceId,
    version,

    /**
     * Make the first admin when needed, prepare the certificate, start the modules, then listen.
     * A failure undoes what was done (as `stop()` does) before it is thrown.
     * @returns {Promise<StartInfo>}
     */
    async start() {
      if (state !== "new" || stopping) throw new Error("This server was already started.");
      state = "starting";
      try {
        const first = await setup.ensureFirstAdmin({ env });
        const identity = localIdentity();
        const certificate = await ensureCertificate({
          dir: paths.tlsDir,
          hostnames: identity.hostnames,
          addresses: identity.addresses,
        });
        log.info(
          `Certificate ${certificate.action}${certificate.reason ? `: ${certificate.reason}` : ""}.`,
        );
        for (const module of modules) {
          reached += 1;
          try {
            await module.start?.();
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`The ${module.name} part of the server could not start: ${reason}`, {
              cause: error,
            });
          }
        }

        http = createHttpServer({
          tls: certificate,
          authenticate: (token, meta) => sessions.authenticate(token, meta),
          rpc: rpc.call,
          events,
          uiDist: config.uiDist,
          instanceId,
          routes: modules.flatMap((module) => module.routes ?? []),
          log,
          options: options.http,
        });
        const { port } = await http.listen(config.port, config.host);

        purgeTimer = setInterval(() => {
          try {
            sessions.purgeExpired();
          } catch (error) {
            log.warn("Deleting expired sessions failed.", error);
          }
        }, options.purgeIntervalMs ?? PURGE_INTERVAL_MS);
        purgeTimer.unref();

        state = "running";
        const token = setup.setupToken;
        const fromEnv = first.created
          ? (env.VIDAI_ADMIN_EMAIL?.trim().toLowerCase() ?? null)
          : null;
        log.info(`VidAI Server ${version} listens on port ${port}.`);
        return {
          port,
          addresses: http.addresses(),
          setupUrl: token ? `https://localhost:${port}/setup#${token}` : null,
          adminCreatedFromEnv: fromEnv,
        };
      } catch (error) {
        log.error("The server could not start.", error);
        await stop();
        throw error;
      }
    },

    stop,
  };
}

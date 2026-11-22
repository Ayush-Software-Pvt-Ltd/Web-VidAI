// The toolkit module (docs/SPEC.md sections 5, 7 and 12): installs one copy of the editing
// toolkit for the whole server, prepares its Python environment, and gives the admin's System
// page its data. Plug it into the composition root like the other modules:
//
//   const toolkit = createToolkitModule({ dataDir, clock, log, events, version, db, limits, ... });
//   rpc.register(toolkit.rpc);   // adminGetSystem, adminPrepareToolkit
//   await toolkit.start();       // installs or upgrades, then starts Prepare when it is needed
//   ... await toolkit.stop();    // ends a running Prepare's child processes
//
// What the others use (`api`):
//  - `paths()`: `{ root, toolkitFolder, python, memoryFile, version }` for the prompt header;
//  - `prepared()`: edits may start (the harness module's probe `toolkitPrepared`);
//  - `renderReady()`: renders may start (browser and test render are done as well);
//  - `env()`: `VE_FFMPEG`, `VE_FFPROBE`, `VE_NODE`, ... and `PYTHONDONTWRITEBYTECODE=1` for the
//    toolkit's programs inside jobs.

import fs from "node:fs";
import path from "node:path";
import { adminSystemFunctions } from "../rpc/adminSystem.js";
import { createSystem } from "../system.js";
import { installToolkit, readVersion } from "./install.js";
import { publicPaths, shippedToolkitDir, toolkitPaths } from "./paths.js";
import { pythonEnv } from "../platform/python.js";
import { runProcess } from "./run.js";
import { createHardwareProbe } from "./hardware.js";
import { createPrepare } from "./prepare.js";
import { createToolProbes } from "./probes.js";

/** @typedef {import("../../../src/lib/wire/system.ts").PrepareState} PrepareState */
/** @typedef {import("../../../src/lib/wire/system.ts").SystemToolkit} SystemToolkit */

/**
 * `system-changed` goes to admins only: a user id nobody has, with `admins` set.
 * @type {{ event: string, payload: null, userId: string, admins: true }}
 */
const SYSTEM_CHANGED = { event: "system-changed", payload: null, userId: "", admins: true };

/**
 * @typedef {object} ToolkitDeps
 * @property {string} dataDir
 * @property {import("../db/open.js").Clock} clock
 * @property {import("../log.js").Logger} log
 * @property {{ emit(event: { event: string, payload: unknown, userId: string | null, admins: boolean }): void }} events
 * @property {string} version The server's version (System page).
 * @property {import("../db/open.js").Database} db Counts of users, channels and jobs.
 * @property {{ cpuState: () => { processors: number, running: number, budget: number }, gpuState: () => { total: number, perJob: number, slots: import("../../../src/lib/wire/system.ts").SystemGpuSlot[] } }} limits
 *   The limits module's `api` (`cpuState`, `gpuState`).
 * @property {() => string[]} [addresses] The addresses the server listens on.
 * @property {Partial<Record<"claude" | "opencode" | "ffmpeg" | "ffprobe" | "python" | "hyperframes", import("../system.js").Probe>>} [probes]
 *   The probes of the System page; ffmpeg, ffprobe and Python default to this module's own.
 * @property {import("./prepare.js").RenderStep | null} [ensureBrowser] The renderer's browser step.
 * @property {import("./prepare.js").RenderStep | null} [testRender] The test render step.
 * @property {string | null} [hyperframesBin] The pinned `hyperframes.mjs`, told to the toolkit.
 * @property {boolean} [autoPrepare] Start Prepare in `start()` when it is needed (default true).
 * @property {string} [source] The shipped `toolkit/` folder (default: found from this file).
 * @property {NodeJS.Platform} [platform] Only tests pass it.
 * @property {Readonly<Record<string, string | undefined>>} [env]
 * @property {Partial<import("./install.js").InstallFs>} [installFs] Tests fail single file operations.
 * @property {Omit<import("./prepare.js").PrepareDeps, "paths" | "clock" | "log" | "onChange" | "ensureBrowser" | "testRender" | "hyperframesBin" | "env" | "platform">} [prepareOptions]
 *   Test seams of Prepare (`runner`, `pythonCandidates`, `findFfmpeg`, `timeouts`, ...).
 * @property {Partial<import("../system.js").SystemDeps>} [systemOptions] Test seams of the page
 *   (`statfs`, `os`, `probeTimeoutMs`).
 */

/**
 * @param {ToolkitDeps} deps
 */
export function createToolkitModule(deps) {
  const { dataDir, clock, log, events } = deps;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const source = deps.source ?? shippedToolkitDir();
  const paths = toolkitPaths(dataDir, platform);
  const exists = deps.prepareOptions?.exists ?? ((/** @type {string} */ file) => fs.existsSync(file));

  /** @type {string | null} */
  let installError = null;
  let usable = exists(paths.driver);

  const announce = () => events.emit(SYSTEM_CHANGED);

  const prepare = createPrepare({
    ...deps.prepareOptions,
    paths,
    clock,
    log,
    env,
    platform,
    onChange: announce,
    ensureBrowser: deps.ensureBrowser ?? null,
    testRender: deps.testRender ?? null,
    hyperframesBin: deps.hyperframesBin ?? null,
  });

  const toolProbes = createToolProbes({
    paths,
    env,
    platform,
    exists,
    ...(deps.prepareOptions?.findFfmpeg ? { findFfmpeg: deps.prepareOptions.findFfmpeg } : {}),
    ...(deps.prepareOptions?.findFfprobe ? { findFfprobe: deps.prepareOptions.findFfprobe } : {}),
    ...(deps.prepareOptions?.pythonCandidates
      ? { pythonCandidates: deps.prepareOptions.pythonCandidates }
      : {}),
  });

  const hardware = createHardwareProbe({
    paths,
    runner: deps.prepareOptions?.runner ?? runProcess,
    env: () => pythonEnv(env, prepare.toolkitVars()),
    clock,
    nvidia: () => prepare.nvidia().name ?? (prepare.nvidia().present ? "NVIDIA GPU" : null),
    generation: () => {
      const state = prepare.view();
      return `${state.finishedAt}:${state.running}`;
    },
    exists,
  });

  /** @returns {string | null} */
  const installedVersion = () => readVersion(paths.versionFile);

  /** @returns {SystemToolkit} */
  function toolkitInfo() {
    const installed = installedVersion();
    const shipped = readVersion(path.join(source, "VERSION"));
    return {
      installedVersion: installed,
      shippedVersion: shipped,
      upToDate: installed !== null && installed === shipped && installError === null,
      installError,
      folder: paths.toolkitFolder,
      python: paths.python,
      hasPrevious: exists(paths.previousFolder),
    };
  }

  const system = createSystem({
    db: deps.db,
    dataDir,
    version: deps.version,
    clock,
    ...(deps.addresses ? { addresses: deps.addresses } : {}),
    probes: { ffmpeg: toolProbes.ffmpeg, ffprobe: toolProbes.ffprobe, python: toolProbes.python, ...deps.probes },
    limits: deps.limits,
    toolkit: toolkitInfo,
    prepare: () => prepare.view(),
    hardware,
    ...deps.systemOptions,
  });

  /** @returns {PrepareState} */
  function startPrepare() {
    void prepare.run();
    return prepare.view();
  }

  return {
    name: "toolkit",

    /** The RPC functions `adminGetSystem` and `adminPrepareToolkit`. */
    rpc: adminSystemFunctions({
      system,
      toolkit: { start: startPrepare, installError: () => installError },
    }),

    /**
     * Installs or upgrades the toolkit (SPEC section 7), then starts Prepare when edits could not
     * start without it. A failed install is logged and shown on the System page; the server
     * keeps running with whatever toolkit was there.
     * @returns {Promise<void>}
     */
    async start() {
      try {
        const result = installToolkit({
          source,
          target: paths.root,
          ...(deps.installFs ? { fs: deps.installFs } : {}),
        });
        installError = null;
        log.info(
          result.action === "current"
            ? `Toolkit ${result.to} is installed.`
            : `Toolkit ${result.action}: ${result.from ?? "nothing"} to ${result.to}${result.keptPrevious ? " (the old one is kept as CLAUDE_VE_ALL.previous)" : ""}.`,
        );
      } catch (error) {
        installError = error instanceof Error ? error.message : String(error);
        log.error("Installing the toolkit failed.", error);
      }
      usable = exists(paths.driver);
      await prepare.refreshHardware();
      announce();
      if ((deps.autoPrepare ?? true) && usable && !prepare.prepared()) void prepare.run();
    },

    /**
     * Ends a running Prepare's child processes.
     * @returns {Promise<void>}
     */
    async stop() {
      await prepare.stop();
    },

    api: {
      /** Where things are; the job manager puts `toolkitFolder` and `python` into the prompt header. */
      paths: () => publicPaths(dataDir, installedVersion(), platform),
      /** Edits may start: the toolkit is installed and Prepare's editing steps are done. */
      prepared: () => usable && prepare.prepared(),
      /** Renders may start: editing is ready, and the browser and test render are done. */
      renderReady: () => usable && prepare.renderReady(),
      /** Starts Prepare (or joins it) and answers at once with its state. */
      prepare: startPrepare,
      /** Starts Prepare and resolves when it ends. */
      prepareAndWait: () => prepare.run(),
      /** The recorded steps. */
      prepareState: () => prepare.view(),
      /** Environment variables for the toolkit's programs inside jobs. */
      env: () => prepare.toolkitVars(),
      /** The System page's toolkit part. */
      info: toolkitInfo,
      /** The System page. */
      system: () => system.view(),
      /** Why the install failed, or `null`. */
      installError: () => installError,
    },
  };
}

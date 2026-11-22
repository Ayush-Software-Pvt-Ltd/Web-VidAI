// Prepare (docs/SPEC.md section 7 and section 12, last paragraph): makes the toolkit usable on this
// computer and records each step's result.
//
//  1. python    finds a Python 3.10 to 3.13 (versions are read by running each candidate);
//  2. venv      creates `<data dir>/toolkit/venv` and checks pip works in it;
//  3. packages  upgrades pip and installs `CLAUDE_VE_ALL/requirements.txt`;
//  4. ffmpeg    checks ffmpeg and ffprobe exist;
//  5. doctor    runs the toolkit's own check (`ve.py doctor`);
//  6. speech    downloads the speech model into the packages' own cache (the toolkit has no
//               command for it, so a small program of this module does what `vekit/asr.py`
//               does on first use, with the toolkit's own backend and model names);
//  7. browser   the renderer's browser (injected `ensureBrowser`);
//  8. render    the two second test render (injected `testRender`).
//
// Which steps block editing and which only rendering: `steps.js`. One Prepare at a time: a call
// while one runs joins it. A step runs only when the steps it needs are done. Results are kept in
// `prepare.json` (`state.js`); a restart shows them, and a step that was running becomes failed.
//
// Whether the environment must be prepared again is derived, never stored as a flag, so a crash
// cannot lose it: the environment's Python is missing, the packages were never installed, or the
// hash of `requirements.txt` differs from the one recorded when they were installed.

import fs from "node:fs";
import path from "node:path";
import {
  PIP_UPGRADE_ARGS,
  PIP_VERSION_ARGS,
  VERSION_ARGS,
  ffmpegInstallHint,
  formatPythonVersion,
  isSupportedPython,
  parsePythonVersion,
  pipInstallArgs,
  pythonCandidates as defaultCandidates,
  pythonEnv,
  pythonInstallHint,
  venvArgs,
} from "../platform/python.js";
import { findFfmpeg, findFfprobe } from "../platform/tools.js";
import { requirementsHash } from "./install.js";
import { runProcess } from "./run.js";
import { LOG_LINES, readPrepare, writePrepare } from "./state.js";
import { STEPS, stepDefinition } from "./steps.js";

/** @typedef {import("../../../src/lib/wire/system.ts").PrepareState} PrepareState */
/** @typedef {import("../../../src/lib/wire/system.ts").PrepareStepId} PrepareStepId */
/** @typedef {import("./run.js").Runner} Runner */
/** @typedef {import("./run.js").RunResult} RunResult */
/** @typedef {import("../platform/python.js").PythonCandidate} PythonCandidate */

/**
 * What the renderer's two steps give back.
 * @typedef {object} StepOutcome
 * @property {boolean} ok
 * @property {string} message
 *
 * @typedef {object} RenderStepOptions
 * @property {AbortSignal} signal Aborted when the server stops.
 * @property {(line: string) => void} onLine Adds a line to Prepare's log.
 *
 * @typedef {(options: RenderStepOptions) => Promise<StepOutcome>} RenderStep
 */

/** The longest each kind of child may take. */
const DEFAULT_TIMEOUTS = {
  version: 20_000,
  venv: 5 * 60_000,
  pip: 60 * 60_000,
  doctor: 2 * 60_000,
  speech: 2 * 60 * 60_000,
};

/**
 * Downloads the speech model of the toolkit's own backend (`vekit/asr.py`: `mlx` on Apple Silicon,
 * `faster` elsewhere) into the cache the toolkit reads from on first use. `argv[1]` is the
 * toolkit folder, `argv[2]` the toolkit's model name.
 */
const SPEECH_SNIPPET = [
  "import sys",
  "sys.path.insert(0, sys.argv[1])",
  "from vekit import asr",
  "which = asr.backend()",
  "name = asr.model_name(sys.argv[2], which)",
  "if which == 'mlx':",
  "    from huggingface_hub import snapshot_download",
  "    where = snapshot_download(name)",
  "else:",
  "    from faster_whisper.utils import download_model",
  "    where = download_model(name)",
  "print('VIDAI_MODEL', which, name, where)",
].join("\n");

/**
 * @typedef {object} PrepareDeps
 * @property {ReturnType<typeof import("./paths.js").toolkitPaths>} paths
 * @property {import("../db/open.js").Clock} clock
 * @property {import("../log.js").Logger} log
 * @property {() => void} [onChange] Called whenever a step or the running state changes.
 * @property {Runner} [runner]
 * @property {Readonly<Record<string, string | undefined>>} [env]
 * @property {NodeJS.Platform} [platform]
 * @property {() => PythonCandidate[]} [pythonCandidates]
 * @property {() => string | null} [findFfmpeg]
 * @property {() => string | null} [findFfprobe]
 * @property {RenderStep | null} [ensureBrowser] Installs the renderer's browser; `null`: not available.
 * @property {RenderStep | null} [testRender] Renders the two second test project; `null`: not available.
 * @property {string | null} [hyperframesBin] The pinned `hyperframes.mjs`, told to the toolkit.
 * @property {string} [speechModel] The toolkit's model name (default `large-v3`, as `transcribe.py`).
 * @property {Partial<typeof DEFAULT_TIMEOUTS>} [timeouts]
 * @property {(file: string) => boolean} [exists]
 * @property {() => string | null} [requirementsHash] The hash of the installed `requirements.txt`.
 *
 * @typedef {object} RunOptions
 * @property {PrepareStepId} [stopAfter] Stops after this step; the later ones stay pending
 *   (used to check a machine without installing the large packages).
 */

/**
 * @param {PrepareDeps} deps
 */
export function createPrepare(deps) {
  const { paths, clock, log } = deps;
  const runner = deps.runner ?? runProcess;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const candidates = deps.pythonCandidates ?? (() => defaultCandidates(env, { platform }));
  const ffmpegFinder = deps.findFfmpeg ?? (() => findFfmpeg(env));
  const ffprobeFinder = deps.findFfprobe ?? (() => findFfprobe(env));
  const exists = deps.exists ?? ((file) => fs.existsSync(file));
  const currentHash = deps.requirementsHash ?? (() => requirementsHash(paths.requirements));
  const timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
  const speechModel = deps.speechModel ?? "large-v3";
  const changed = deps.onChange ?? (() => {});

  let record = readPrepare(paths.prepareFile);
  /** @type {Promise<PrepareState> | null} */
  let running = null;
  /** @type {AbortController | null} */
  let abort = null;
  let lastNotified = 0;

  function save() {
    try {
      writePrepare(paths.prepareFile, record);
    } catch (error) {
      log.warn("Could not save the Prepare results.", error);
    }
  }

  /** @param {PrepareStepId} id */
  function stepOf(id) {
    const step = record.steps.find((s) => s.id === id);
    if (!step) throw new Error(`Unknown Prepare step ${id}`);
    return step;
  }

  /**
   * @param {PrepareStepId} id
   * @param {"pending" | "running" | "done" | "failed"} state
   * @param {string | null} message
   * @param {number | null} at
   */
  function setStep(id, state, message, at) {
    const step = stepOf(id);
    step.state = state;
    step.message = message;
    step.at = at;
    save();
    lastNotified = clock.now();
    changed();
  }

  /** @param {string} line */
  function addLog(line) {
    record.log.push(line);
    if (record.log.length > LOG_LINES) record.log.splice(0, record.log.length - LOG_LINES);
    log.info(`toolkit: ${line}`);
    // The page follows a long pip run: tell it at most once a second.
    if (clock.now() - lastNotified >= 1000) {
      lastNotified = clock.now();
      changed();
    }
  }

  /**
   * Why the environment must be prepared (again), or `null`.
   * @returns {string | null}
   */
  function needsReason() {
    if (!exists(paths.python)) return "The Python environment has not been created yet.";
    if (record.requirementsHash === null) return "The Python packages are not installed yet.";
    const hash = currentHash();
    if (hash === null) return "The toolkit's list of Python packages is missing.";
    if (hash !== record.requirementsHash) {
      return "The toolkit's Python packages changed since they were installed.";
    }
    return null;
  }

  /** @returns {PrepareState} */
  function view() {
    const reason = needsReason();
    const steps = STEPS.map((def) => {
      const step = stepOf(def.id);
      return {
        id: def.id,
        label: def.label,
        state: step.state,
        message: step.message,
        at: step.at,
        blocks: def.blocks,
      };
    });
    const doneFor = (/** @type {"editing" | "rendering"} */ blocks) =>
      steps.filter((s) => s.blocks === blocks).every((s) => s.state === "done");
    const editReady = running === null && reason === null && doneFor("editing");
    return {
      running: running !== null,
      steps,
      log: [...record.log],
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      needsPrepare: reason !== null,
      reason,
      editReady,
      renderReady: editReady && doneFor("rendering"),
    };
  }

  /**
   * The variables the toolkit's programs get on top of the server's environment: the programs
   * this server found and no bytecode files written into the toolkit folder (SPEC section 7).
   * @returns {Record<string, string>}
   */
  function toolkitVars() {
    /** @type {Record<string, string>} */
    const extra = { PYTHONDONTWRITEBYTECODE: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1" };
    const ffmpeg = ffmpegFinder();
    const ffprobe = ffprobeFinder();
    if (ffmpeg !== null) extra.VE_FFMPEG = ffmpeg;
    if (ffprobe !== null) extra.VE_FFPROBE = ffprobe;
    extra.VE_NODE = process.execPath;
    const npx = path.join(path.dirname(process.execPath), platform === "win32" ? "npx.cmd" : "npx");
    if (exists(npx)) extra.VE_NPX = npx;
    if (deps.hyperframesBin && exists(deps.hyperframesBin)) extra.VE_HYPERFRAMES = deps.hyperframesBin;
    return extra;
  }

  /**
   * The whole environment of Prepare's own children: what pip and Python need plus `toolkitVars`.
   * @returns {Record<string, string | undefined>}
   */
  function toolkitEnv() {
    return pythonEnv(env, toolkitVars());
  }

  /**
   * @param {RunResult} result
   * @param {number} [lines]
   * @returns {string}
   */
  function lastLines(result, lines = 8) {
    const text = result.tail.slice(-lines).join("\n");
    return result.error !== null ? `${result.error}${text ? `\n${text}` : ""}` : text;
  }

  /**
   * @param {string} command
   * @param {readonly string[]} args
   * @param {{ timeoutMs: number, quiet?: boolean, env?: Record<string, string | undefined> }} options
   * @returns {Promise<RunResult>}
   */
  function run(command, args, { timeoutMs, quiet = false, env: childEnv }) {
    return runner({
      command,
      args,
      cwd: paths.root,
      env: childEnv ?? toolkitEnv(),
      timeoutMs,
      ...(abort ? { signal: abort.signal } : {}),
      ...(quiet ? {} : { onLine: addLog }),
    });
  }

  /**
   * The Python version a program prints.
   * @param {PythonCandidate} candidate
   * @returns {Promise<{ ok: boolean, version: import("../platform/python.js").PythonVersion | null }>}
   */
  async function readVersion(candidate) {
    const result = await run(candidate.command, [...candidate.args, ...VERSION_ARGS], {
      timeoutMs: timeouts.version,
      quiet: true,
    });
    if (!result.started || result.code !== 0) return { ok: false, version: null };
    const line = [...result.tail].reverse().find((l) => parsePythonVersion(l) !== null);
    return { ok: true, version: line === undefined ? null : parsePythonVersion(line) };
  }

  /**
   * @typedef {object} Context What the steps of one run pass on.
   * @property {PythonCandidate | null} python The Python the environment is made from.
   */

  /** @param {Context} ctx @returns {Promise<StepOutcome>} */
  async function stepPython(ctx) {
    /** @type {string[]} */
    const rejected = [];
    for (const candidate of candidates()) {
      if (abort?.signal.aborted) break;
      const { ok, version } = await readVersion(candidate);
      if (!ok || version === null) {
        rejected.push(`${candidate.label} did not start`);
        continue;
      }
      if (!isSupportedPython(version)) {
        rejected.push(`${candidate.label} is Python ${formatPythonVersion(version)}`);
        continue;
      }
      ctx.python = candidate;
      return {
        ok: true,
        message: `Python ${formatPythonVersion(version)} at ${candidate.label}.`,
      };
    }
    const found = rejected.length > 0 ? ` Found but not usable: ${rejected.join("; ")}.` : "";
    return { ok: false, message: `${pythonInstallHint(platform)}${found}` };
  }

  /** @param {Context} ctx @returns {Promise<StepOutcome>} */
  async function stepVenv(ctx) {
    const base = ctx.python;
    if (base === null) return { ok: false, message: "No Python was chosen." };
    let reuse = false;
    if (exists(paths.python)) {
      const { ok, version } = await readVersion({
        command: paths.python,
        args: [],
        label: paths.python,
      });
      reuse = ok && version !== null && isSupportedPython(version);
    }
    if (!reuse) {
      const made = await run(
        base.command,
        [...base.args, ...venvArgs(paths.venvDir, { clear: exists(paths.venvDir) })],
        { timeoutMs: timeouts.venv },
      );
      if (made.code !== 0) {
        return {
          ok: false,
          message: `Creating the Python environment failed. ${lastLines(made)}`.trim(),
        };
      }
    }
    const pip = await run(paths.python, PIP_VERSION_ARGS, { timeoutMs: timeouts.version });
    const pipLine = pip.tail.find((l) => /^pip\s+\d/.test(l));
    if (pip.code !== 0 || pipLine === undefined) {
      return {
        ok: false,
        message: `The Python environment was created but pip does not work in it. ${lastLines(pip)}`.trim(),
      };
    }
    const pipVersion = /^pip\s+(\S+)/.exec(pipLine)?.[1] ?? "?";
    const py = await readVersion({ command: paths.python, args: [], label: paths.python });
    const pyText = py.version === null ? "" : `Python ${formatPythonVersion(py.version)}, `;
    return {
      ok: true,
      message: `${reuse ? "Environment found" : "Environment created"} (${pyText}pip ${pipVersion}).`,
    };
  }

  /** @returns {Promise<StepOutcome>} */
  async function stepPackages() {
    if (!exists(paths.requirements)) {
      return { ok: false, message: "The toolkit's requirements.txt is missing." };
    }
    const hash = currentHash();
    // Half-installed packages must not count as installed.
    record.requirementsHash = null;
    save();
    const upgrade = await run(paths.python, PIP_UPGRADE_ARGS, { timeoutMs: timeouts.pip });
    if (upgrade.code !== 0) log.warn("toolkit: upgrading pip failed; going on with the old one.");
    const install = await run(paths.python, pipInstallArgs(paths.requirements), {
      timeoutMs: timeouts.pip,
    });
    if (install.code !== 0) {
      const why = install.timedOut
        ? "took too long"
        : install.code === null
          ? "did not run"
          : `ended with code ${install.code}`;
      return {
        ok: false,
        message: `Installing the Python packages ${why}. Is the internet reachable? The last lines of pip's output:\n${lastLines(install)}`,
      };
    }
    record.requirementsHash = hash;
    return { ok: true, message: "Python packages installed." };
  }

  /** @returns {Promise<StepOutcome>} */
  async function stepFfmpeg() {
    const ffmpeg = ffmpegFinder();
    const ffprobe = ffprobeFinder();
    const missing = [ffmpeg === null ? "ffmpeg" : null, ffprobe === null ? "ffprobe" : null].filter(
      (name) => name !== null);
    if (missing.length > 0) {
      return {
        ok: false,
        message: `${missing.join(" and ")} ${missing.length > 1 ? "were" : "was"} not found. ${ffmpegInstallHint(platform)}`,
      };
    }
    return { ok: true, message: `ffmpeg at ${ffmpeg}, ffprobe at ${ffprobe}.` };
  }

  /** @returns {Promise<StepOutcome>} */
  async function stepDoctor() {
    const result = await run(paths.python, [paths.driver, "doctor"], { timeoutMs: timeouts.doctor });
    const lines = result.tail.map((l) => l.trim().replace(/\s+/g, " "));
    if (result.code === 0) {
      const facts = lines.filter((l) => /^(hardware|speech) /.test(l));
      return {
        ok: true,
        message: facts.length > 0 ? facts.join("; ") : "The toolkit reports it is ready.",
      };
    }
    const findings = lines.filter((l) => /\bMISSING\b/.test(l) && !/optional/.test(l));
    const what = findings.length > 0 ? findings.join("; ") : lastLines(result);
    return {
      ok: false,
      message: `The toolkit's own check found problems: ${what}. Fix them and press Prepare again.`,
    };
  }

  /** @returns {Promise<StepOutcome>} */
  async function stepSpeech() {
    const result = await run(paths.python, ["-c", SPEECH_SNIPPET, paths.toolkitFolder, speechModel], {
      timeoutMs: timeouts.speech,
    });
    if (result.code !== 0) {
      return {
        ok: false,
        message: `Downloading the speech model failed. Is the internet reachable? ${lastLines(result, 5)}`.trim(),
      };
    }
    const line = result.tail.find((l) => l.startsWith("VIDAI_MODEL "));
    const [, backend, name] = line === undefined ? [] : line.split(" ");
    return {
      ok: true,
      message:
        backend && name
          ? `Speech model ${name} is ready (${backend}).`
          : "The speech model is ready.",
    };
  }

  /**
   * @param {RenderStep | null | undefined} step
   * @param {string} what
   * @returns {Promise<StepOutcome>}
   */
  async function renderStep(step, what) {
    if (!step) {
      return { ok: false, message: `${what} is not available in this server, so rendering cannot be used.` };
    }
    return step({ signal: /** @type {AbortController} */ (abort).signal, onLine: addLog });
  }

  /**
   * @param {PrepareStepId} id
   * @param {Context} ctx
   * @returns {Promise<StepOutcome>}
   */
  function runStep(id, ctx) {
    switch (id) {
      case "python":
        return stepPython(ctx);
      case "venv":
        return stepVenv(ctx);
      case "packages":
        return stepPackages();
      case "ffmpeg":
        return stepFfmpeg();
      case "doctor":
        return stepDoctor();
      case "speech":
        return stepSpeech();
      case "browser":
        return renderStep(deps.ensureBrowser, "The renderer's browser");
      case "render":
        return renderStep(deps.testRender, "The test render");
      default:
        return Promise.resolve({ ok: false, message: "Unknown step." });
    }
  }

  /** @param {RunOptions} options @returns {Promise<PrepareState>} */
  async function execute(options) {
    const controller = new AbortController();
    abort = controller;
    record = {
      ...record,
      steps: record.steps.map((s) => ({ ...s, state: "pending", message: null, at: null })),
      log: [],
      startedAt: clock.now(),
      finishedAt: null,
    };
    fs.mkdirSync(paths.root, { recursive: true });
    save();
    changed();
    /** @type {Context} */
    const ctx = { python: null };
    try {
      for (const def of STEPS) {
        if (controller.signal.aborted) break;
        const waitingFor = def.needs.find((need) => stepOf(need).state !== "done");
        if (waitingFor !== undefined) {
          setStep(def.id, "pending", `Waits for "${stepDefinition(waitingFor).label}".`, null);
          continue;
        }
        setStep(def.id, "running", null, clock.now());
        addLog(`== ${def.label} ==`);
        /** @type {StepOutcome} */
        let outcome;
        try {
          outcome = await runStep(def.id, ctx);
        } catch (error) {
          log.warn(`Prepare step ${def.id} threw.`, error);
          outcome = {
            ok: false,
            message: `${def.label} failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        if (controller.signal.aborted) {
          setStep(def.id, "failed", "Stopped because the server was shutting down.", clock.now());
          break;
        }
        addLog(`${outcome.ok ? "ok" : "FAILED"}: ${outcome.message.split("\n")[0]}`);
        setStep(def.id, outcome.ok ? "done" : "failed", outcome.message, clock.now());
        if (options.stopAfter === def.id) break;
      }
    } finally {
      record.finishedAt = clock.now();
      abort = null;
      running = null;
      save();
      changed();
    }
    return view();
  }

  return {
    /**
     * Starts Prepare, or joins the one that is running. Resolves with the final state; never
     * rejects.
     * @param {RunOptions} [options]
     * @returns {Promise<PrepareState>}
     */
    run(options = {}) {
      if (running !== null) return running;
      // Started in a microtask so `running` is set before the first change is announced.
      running = Promise.resolve()
        .then(() => execute(options))
        .catch((error) => {
          log.error("Prepare failed.", error);
          running = null;
          return view();
        });
      return running;
    },
    /** @returns {PrepareState} */
    view,
    /** Whether edits may start (SPEC section 7). */
    prepared: () => view().editReady,
    /** Whether renders may start. */
    renderReady: () => view().renderReady,
    /** @returns {boolean} */
    isRunning: () => running !== null,
    /** The variables for the toolkit's programs (`VE_FFMPEG`, ...), to add to an environment. */
    toolkitVars,
    /** Ends a running Prepare's child processes and waits for it to finish. */
    async stop() {
      const current = running;
      abort?.abort();
      if (current) await current;
    },
  };
}

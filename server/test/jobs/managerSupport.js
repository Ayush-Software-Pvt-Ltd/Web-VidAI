// Shared set-up of the job manager tests: the library and timeline modules (real, on a temporary
// data dir), the jobs module on top of them with the fake Claude Code as the editing program, and
// stubs for the harness, the limits and the Claude module. Not a test file itself.
//
// The fake Claude Code writes an fcpxml, not a HyperFrames project, so the project is left behind
// by test code: `world.onStart` runs when a program starts (the `startAgent` seam).

import fs from "node:fs";
import path from "node:path";
import { startAgent } from "../../src/agents/start.js";
import { createSettingsRepo } from "../../src/db/settings.js";
import { notReady } from "../../src/errors.js";
import { createJobsModule } from "../../src/jobs/index.js";
import { createSettings } from "../../src/settings.js";
import { createTimelineModule } from "../../src/timeline/index.js";
import { createLibraryWorld } from "../library/support.js";
import { FIXTURES } from "../timeline/helpers.js";
import { FAKE_CLAUDE } from "./engineSupport.js";

export const DRIVER_TIMINGS = {
  settle: 250,
  interruptTimeout: 3000,
  exitTimeout: 5000,
  killGrace: 500,
  stallTimeout: 15_000,
  progressInterval: 100,
  treeRefresh: 200,
  retrySecond: 0,
};

/** @param {() => boolean} check @param {number} [limitMs] */
export async function until(check, limitMs = 30_000) {
  for (let spent = 0; !check(); spent += 20) {
    if (spent > limitMs) throw new Error("the condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * @param {import("node:test").TestContext} t
 * @param {{ runLint?: (dir: string) => Promise<{ errors: string[], problem: string | null }>, renderRunner?: any, jobsOptions?: Record<string, unknown> }} [options]
 */
export function createManagerWorld(t, { runLint, renderRunner = null, jobsOptions = {} } = {}) {
  /** @type {{ api: any } | null} */
  let jobsRef = null;
  const w = createLibraryWorld({
    jobsFor: (keys) => jobsRef?.api.jobsFor(keys) ?? new Map(),
  });
  const timeline = createTimelineModule({
    db: w.db,
    clock: w.clock,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    events: { emit: () => {} },
    dataDir: w.dataDir,
    library: w.library.api,
    activeJob: (key) => jobsRef?.api.activeJob(key) ?? null,
    requestTimelineEdit: (request) => jobsRef?.api.requestTimelineEdit(request),
    runLint: runLint ?? (async () => ({ errors: [], problem: null })),
  });
  const stateDir = path.join(w.dataDir, "fake-state");
  fs.mkdirSync(stateDir, { recursive: true });
  /** @type {Record<string, string | undefined>} */
  const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", FAKE_STATE: stateDir };
  const settings = createSettings({ repo: createSettingsRepo(w.db) });
  const emitted =
    /** @type {{ event: string, payload: any, userId: string | null, admins: boolean }[]} */ ([]);
  const knobs = {
    setup: /** @type {import("../../src/agents/harness.js").Setup} */ ("claudeSubscription"),
    notReady: /** @type {Set<string>} */ (new Set()),
    ended: /** @type {string[]} */ ([]),
    forgotten: 0,
    editLog: /** @type {any[]} */ ([]),
  };
  /** @type {Array<(spec: any) => void>} */
  const starts = [];
  const harness = {
    /** @param {any} [setup] */
    launchFor(setup = knobs.setup) {
      const codes = setup === "opencodeGo" || setup === "openaiApi";
      return {
        setup,
        program: codes ? /** @type {const} */ ("opencode2") : /** @type {const} */ ("claudeCode"),
        option: setup === "opencodeGo" ? /** @type {const} */ ("opencodeGo") : null,
        model: codes ? "glm-5.3" : null,
        effort: null,
        baseUrl: null,
        key: null,
      };
    },
    jobEnv: (
      /** @type {any} */ _state,
      /** @type {Record<string, string | undefined>} */ base,
    ) => ({
      ...base,
    }),
    secretsToScrub: () => [],
    async ensureReady({ setup = knobs.setup } = {}) {
      if (knobs.notReady.has(setup)) throw notReady(`${setup} is not ready on this computer.`);
    },
  };
  const limits = {
    envFor: () => ({ VE_CPU_CORES: "2" }),
    limitsFor: () => ({ cpuCores: 2, renderWorkers: 1 }),
    jobStarted: () => {},
    jobEnded: (/** @type {string} */ id) => void knobs.ended.push(id),
    resumeAll: () => {},
    resumeLeftovers: () => {},
    gpuState: () => ({ perJob: 1, total: 1, slots: [] }),
  };
  const jobs = createJobsModule({
    db: w.db,
    dataDir: w.dataDir,
    // A real clock: the driver's settle time needs time to pass (the library's fake one is fixed).
    clock: { now: () => Date.now() },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    events: { emit: (e) => void emitted.push(/** @type {any} */ (e)) },
    settings,
    harness: /** @type {any} */ (harness),
    claude: {
      locate: async () => ({ path: FAKE_CLAUDE }),
      forgetLogin: () => void (knobs.forgotten += 1),
      recordRateLimitEvent: () => {},
    },
    limits: /** @type {any} */ (limits),
    library: w.library.api,
    timeline: timeline.api,
    toolkit: { folder: path.join(w.dataDir, "toolkit", "CLAUDE_VE_ALL"), python: "python3" },
    machine: /** @type {any} */ ({ facts: async () => null }),
    hyperframesBin: "hyperframes.mjs",
    baseEnv: env,
    renderRunner,
    editLog: { record: (entry) => void knobs.editLog.push(entry) },
    startAgent: (spec) => {
      for (const hook of starts) hook(spec);
      return startAgent(spec);
    },
    driverTimings: DRIVER_TIMINGS,
    shutdownMs: 10_000,
    ...jobsOptions,
  });
  jobsRef = jobs;
  t.after(async () => {
    await jobs.stop();
    w.cleanup();
  });

  /**
   * A video with an A-roll and, with `project`, a project copied from the long fixture.
   * @param {{ id: string }} user
   * @param {{ folder?: string, project?: boolean, channelName?: string, aroll?: boolean }} [options]
   */
  async function videoOf(
    user,
    { folder = "001 A", project = false, channelName = "Main", aroll = true } = {},
  ) {
    const ch = await w.channelOf(user, channelName);
    const dir = aroll ? ch.video(folder, "clip.mp4") : ch.video(folder);
    const projectDir = path.join(dir, "output", `${folder}.hf`);
    if (project) fs.cpSync(path.join(FIXTURES, "long"), projectDir, { recursive: true });
    const videoId = `${ch.channel.id}/${folder}`;
    const key = (await w.library.api.videoByWireId(user.id, videoId)).key;
    return { videoId, key, dir, projectDir, channelDir: ch.dir };
  }

  /** Leaves a project (or a change to it) behind when the program starts. @param {string} projectDir */
  function writesProject(projectDir) {
    starts.push(() => {
      if (!fs.existsSync(projectDir)) {
        fs.cpSync(path.join(FIXTURES, "long"), projectDir, { recursive: true });
      } else {
        fs.appendFileSync(path.join(projectDir, "index.html"), "\n<!-- changed by the agent -->\n");
      }
    });
  }

  /**
   * @param {{ id: string, role?: string }} user
   * @param {string} name
   * @param {unknown} input
   * @returns {Promise<any>}
   */
  async function call(user, name, input) {
    const fn = jobs.rpc.find((f) => f.name === name);
    if (!fn) throw new Error(`no RPC function ${name}`);
    return fn.handler(input, /** @type {never} */ (w.ctxOf(user)));
  }

  /** @param {string} jobId */
  const stateOf = (jobId) =>
    String(w.db.get("SELECT state FROM jobs WHERE id = ?", jobId)?.["state"]);

  return {
    ...w,
    timeline,
    jobs,
    env,
    knobs,
    emitted,
    settings,
    starts,
    videoOf,
    writesProject,
    call,
    stateOf,
    /** @param {string} jobId @param {string} state */
    waitFor: (jobId, state) => until(() => stateOf(jobId) === state),
    /** @param {string} scenario */
    scenario: (scenario) => void (env["FAKE_SCENARIO"] = scenario),
    sessionOf: (/** @type {string} */ key) => w.library.api.videos.byKey(key)?.sessionId ?? null,
  };
}

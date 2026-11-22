// Launching a job that got a slot (docs/SPEC.md section 8, "Launching", and docs/SPEC-desktop.md
// section 6): resolve the video, decide setup and session, save the revision before a job that can
// change a project, take the change requests, compose the messages, build the driver's context and
// run it. Every failure on the way ends the job as failed with a sentence; nothing is thrown to the
// queue.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError, notReady } from "../errors.js";
import { findOpencode2 } from "../agents/opencode/locate.js";
import { SETUP_INFO } from "../agents/setups.js";
import { loadProject } from "../timeline/profile.js";
import { fingerprint } from "../timeline/revisionFiles.js";
import { brollFolderName } from "../storage/names.js";
import { runAgentJob } from "./driver.js";
import { programName } from "./errors.js";
import { createPaths } from "./logPaths.js";
import { statusDraft } from "./logDescribe.js";
import {
  composeContinue,
  composeEdit,
  composeReEdit,
  composeTimelineEdit,
  selectSlots,
} from "./prompt.js";
import { markerRules } from "./progressMarkers.js";
import { createDiskProbe } from "./progressEvidence.js";
import { createTracker } from "./progressTracker.js";
import { evidence, scan } from "./work.js";
import { decideSession } from "./managerSession.js";
import { requestOf } from "./managerTypes.js";

const CHECK_CLI = fileURLToPath(new URL("../timeline/checkCli.js", import.meta.url));

/** @param {string} text */
const quoted = (text) => `"${text.replaceAll('"', '\\"')}"`;

/**
 * The seam for the agent's command: the located program of the harness.
 * @param {import("./managerDeps.js").ManagerDeps} d
 * @param {"claudeCode" | "opencode2"} program
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<string>}
 */
async function commandFor(d, program, env) {
  const seam = d.programs[program];
  const found =
    seam !== undefined
      ? await seam()
      : program === "claudeCode"
        ? ((await d.claude.locate())?.path ?? null)
        : ((await findOpencode2(env))?.path ?? null);
  if (!found) {
    throw notReady(`${programName(program)} is not installed on this computer.`);
  }
  return found;
}

/**
 * @param {import("./managerDeps.js").ManagerDeps} d
 * @param {ReturnType<typeof import("./managerOutcome.js").createOutcomes>} outcomes
 * @param {Set<string>} [justContinued] Jobs a Continue just queued (the Continue was logged).
 */
export function createLauncher(d, outcomes, justContinued = new Set()) {
  const { jobs, videos, queues, limits, timeline, library, runs } = d;

  /**
   * The video of a job with everything a launch needs from the library.
   * @param {import("./managerTypes.js").JobRecord} job
   */
  async function resolveVideo(job) {
    const described = library.describeKey(job.videoKey);
    if (!described) throw new AppError("notFound", "This video does not exist any more.");
    const video = await library.videoByWireId(described.userId, described.videoId);
    return { ...video, wireId: described.videoId, ownerId: described.userId };
  }

  /**
   * Handles an error before or around the driver: the job ends as failed with its sentence.
   * @param {import("./managerTypes.js").JobRecord} job
   * @param {unknown} error
   */
  async function failLaunch(job, error) {
    const message =
      error instanceof AppError ? error.message : "The edit could not be started on this computer.";
    if (!(error instanceof AppError)) d.log.error?.(`Launch of ${job.id} failed`, error);
    await outcomes.finish(job, {
      state: "failed",
      error: { code: "failed", message },
      sessionId: null,
      costUsd: null,
      activeMs: 0,
      deliverable: null,
    });
  }

  /**
   * @param {import("./managerTypes.js").JobRecord} job
   * @param {import("./managerRuns.js").Run} run
   */
  async function runRender(job, run) {
    if (!d.renderRunner)
      throw new AppError("conflict", "Rendering is not available on this server.");
    const v = await resolveVideo(job);
    const request = requestOf(job);
    // The runner reports through the `onUpdate` of the job it is given (two renders at once must
    // not mix their progress), and its patch carries the driver's progress shape: `memory` is
    // always null for a render, so the progress memory of the edit is never touched here.
    /** @type {import("./managerTypes.js").RenderFacts["onUpdate"]} */
    const onUpdate = (patch) => {
      if (patch.lastActivity !== undefined)
        queues.setLive(job.id, { lastActivity: patch.lastActivity });
      if (patch.progress) {
        jobs.setProgress(job.id, patch.progress.view);
        queues.changed(job.id);
      }
    };
    const handle = d.renderRunner.run(
      { ...job, onUpdate },
      {
        videoKey: job.videoKey,
        videoId: v.wireId,
        userId: v.ownerId,
        videoDir: v.dir,
        channelDir: v.channelDir,
        projectDir: await timeline.projectDir(job.videoKey),
        folderName: v.folderName,
        resolution: request.resolution === 2160 ? 2160 : 1080,
        videoType: job.videoType,
        onUpdate,
      },
    );
    run.attach({ pause: () => {}, stop: () => handle.stop() });
    await outcomes.finish(job, await handle.done);
  }

  /**
   * @param {import("./managerTypes.js").JobRecord} job
   * @param {import("./managerRuns.js").Run} run
   */
  async function runAgent(job, run) {
    const v = await resolveVideo(job);
    const key = job.videoKey;
    const row = videos.byKey(key) ?? v.row;
    const decision = await decideSession({ job, row, harness: d.harness });
    const { launch } = decision;
    const program = launch.program;
    const setup = launch.setup;
    const projectDir = await timeline.projectDir(key);
    const hasProject = await timeline.projectExists(key);
    let request = requestOf(job);
    /** @param {Record<string, unknown>} more */
    const remember = (more) => {
      request = { ...request, ...more };
      jobs.setRequest(job.id, request);
    };

    if (job.setup !== setup || job.harness !== program || launch.model !== job.model) {
      jobs.setLaunch(job.id, {
        setup,
        harness: program,
        model: launch.model,
        effort: launch.effort,
      });
    }
    const running = { ...job, setup, harness: program, model: launch.model, effort: launch.effort };

    // The project before the job: a revision to go back to and a fingerprint to compare with.
    if (request.beforeFingerprint === undefined) {
      if (hasProject) {
        const first = (await timeline.latestRevision(key)) === null;
        const saved = await timeline.saveRevision(key, {
          label: first ? "Existing project" : "Changed outside VidAI",
          userId: null,
          jobId: job.id,
          onlyIfChanged: true,
        });
        remember({ beforeRevision: saved.n, beforeFingerprint: await fingerprint(projectDir) });
      } else {
        remember({ beforeRevision: null, beforeFingerprint: null });
      }
    }
    if (job.kind === "timelineEdit" && request.notes === undefined) {
      const taken = await timeline.takeNotes(key, job.id);
      remember({ notes: await d.describeNotes(key, taken) });
    }

    const type = job.videoType;
    const profile = v.channel[type];
    const inputs = row.inputs;
    const limitsNow = limits.limitsFor(job.id);
    const subfolders = fs
      .readdirSync(v.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const context = {
      mainFolder: v.dir,
      channelFolder: v.channelDir,
      channelName: v.channel.name,
      toolkitFolder: d.toolkit.folder,
      python: d.toolkit.python,
      videoType: type,
      brollFolder: path.join(v.dir, brollFolderName(subfolders)),
      projectFolder: projectDir,
      checkCommand: `${quoted(process.execPath)} ${quoted(CHECK_CLI)} ${quoted(projectDir)}`,
      machine: await d.machine.facts(),
      limits: { cpuCores: limitsNow.cpuCores, gpuTasks: d.limits.gpuState().perJob },
      setup,
      harness: program,
    };
    const editInput = () => {
      selectSlots(profile, inputs.promptSlot, inputs.styleSlot, type);
      return { ...context, ...inputs, profile };
    };
    const followBase = (/** @type {ReturnType<typeof editInput> | null} */ newSession) => ({
      setup,
      harness: program,
      newSession,
      hasProject,
    });
    const timelineFacts = async () => {
      const facts = (await loadProject(projectDir)).facts;
      if (!facts) {
        throw new AppError(
          "conflict",
          "The project cannot be read, so the requests cannot be sent.",
        );
      }
      return { fps: facts.fps, width: facts.width, height: facts.height };
    };
    const timelineView = job.kind === "timelineEdit" ? await timelineFacts() : null;
    const build = (/** @type {ReturnType<typeof editInput> | null} */ newSession) => {
      if (job.resume) {
        return composeContinue({
          ...followBase(newSession),
          afterFailure: request.afterFailure ?? null,
        });
      }
      switch (job.kind) {
        case "reEdit":
          return composeReEdit({ ...followBase(newSession), changes: request.text ?? "" });
        case "timelineEdit":
          return composeTimelineEdit({
            ...followBase(newSession),
            ...(timelineView ?? { fps: { num: 30, den: 1 }, width: 1920, height: 1080 }),
            requests: request.notes ?? [],
          });
        default:
          return composeEdit(editInput());
      }
    };
    const firstMessage = build(decision.sessionId === null ? editInput() : null);
    /** @type {string | undefined} */
    let fullMessage;
    if (decision.sessionId !== null) {
      try {
        fullMessage = build(editInput());
      } catch {
        fullMessage = undefined;
      }
    }

    // Environment, program and log.
    const state = { setup, baseUrl: launch.baseUrl ?? "", key: launch.key, model: launch.model };
    const env = {
      ...d.harness.jobEnv(state, d.baseEnv),
      ...d.toolkit.env?.(),
      ...limits.envFor(job.id),
      PYTHONDONTWRITEBYTECODE: "1",
      VE_HYPERFRAMES: d.hyperframesBin,
      VE_NODE: d.nodePath,
    };
    const command = await commandFor(d, program, env);
    for (const secret of d.harness.secretsToScrub()) d.sink.addSecret(secret);
    if (launch.key) d.sink.addSecret(launch.key);
    if (decision.fallback) d.sink.push(v.wireId, job.id, [statusDraft(decision.fallback)]);

    const clock = d.clock;
    const tracker = createTracker({
      kind: /** @type {"edit" | "reEdit" | "timelineEdit"} */ (job.kind),
      videoType: type,
      jobId: job.id,
      clock,
      history: d.history,
      activeBeforeMs: job.activeMs,
      since: job.startedAt,
      memory: row.progressMemory,
      progress: job.progress,
      probeOutput: createDiskProbe(v.dir),
      scanWork: () => evidence(scan(v.dir, { clock }), job.startedAt ?? clock.now()),
    });
    const windows = path.sep === "\\";
    const handle = runAgentJob({
      job: {
        id: job.id,
        kind: /** @type {"edit" | "reEdit" | "timelineEdit"} */ (job.kind),
        videoId: v.wireId,
        videoDir: v.dir,
        sessionId: decision.sessionId,
        setup,
        ...(setup === "anthropicApi" ? { serviceName: SETUP_INFO[setup].service } : {}),
        activeBeforeMs: job.activeMs,
      },
      agent: {
        harness: program,
        command,
        cwd: v.dir,
        env,
        model: launch.model,
        effort: launch.effort,
        jobDir: path.join(d.dataDir, "cache", "opencode", job.id),
        ...(launch.option ? { option: launch.option } : {}),
        key: launch.key,
        baseUrl: launch.baseUrl,
        title: `VidAI: ${v.folderName}`,
        secrets: d.harness.secretsToScrub(),
        ...(d.agentTimings ? { timings: d.agentTimings } : {}),
      },
      firstMessage,
      ...(fullMessage === undefined ? {} : { fullMessage }),
      verify: async () => (await timeline.check(key)).violations,
      deliverable: () => outcomes.deliverable(running),
      tracker,
      sink: d.sink,
      limiter: {
        jobStarted: (rootPid) => limits.jobStarted(job.id, { rootPid, kind: job.kind }),
        jobEnded: () => limits.jobEnded(job.id),
        resumeAll: () => limits.resumeAll(job.id),
      },
      registry: d.registry,
      onUpdate: (patch) => {
        if (patch.sessionId) videos.setSession(key, patch.sessionId, program);
        if (patch.costUsd !== undefined || patch.lastActivity !== undefined) {
          queues.setLive(job.id, {
            ...(patch.lastActivity === undefined ? {} : { lastActivity: patch.lastActivity }),
            ...(patch.costUsd === undefined ? {} : { costUsd: patch.costUsd }),
          });
        }
        if (patch.progress) {
          jobs.setProgress(job.id, patch.progress.view);
          if (patch.progress.persist) videos.setProgressMemory(key, patch.progress.memory);
          queues.changed(job.id);
        }
      },
      clock,
      ...(d.driverTimings ? { timings: d.driverTimings } : {}),
      ...(d.timers ? { timers: d.timers } : {}),
      maxRetries: () => d.settings.getAll().maxModelRetries,
      describe: /** @type {never} */ ({
        markers: markerRules,
        paths: createPaths([v.dir, v.channelDir, projectDir], { windows }),
      }),
      onRateLimit: (raw) => {
        if (program === "claudeCode") d.claude.recordRateLimitEvent(raw);
      },
      ...(d.startAgent ? { startAgent: d.startAgent } : {}),
    });
    run.attach(handle);
    await outcomes.finish(running, await handle.done);
  }

  /**
   * The edit log line of a job's first start (SPEC section 16); a Continue logs its own line.
   * @param {import("./managerTypes.js").JobRecord} job
   */
  function logStart(job) {
    if (justContinued.delete(job.id)) return;
    const what =
      job.kind === "render"
        ? "Render started"
        : job.kind === "timelineEdit"
          ? "Change request started"
          : job.kind === "reEdit"
            ? "Re-Edit started"
            : "Started";
    const message =
      job.kind === "render" ? what : `${what} (${programName(job.harness ?? "claudeCode")})`;
    d.editLog?.record({ userId: job.userId, videoKey: job.videoKey, event: "started", message });
  }

  /**
   * What the queue calls for a job that got a slot. Never rejects.
   * @param {import("./managerTypes.js").JobRecord} job
   * @returns {Promise<void>}
   */
  async function launch(job) {
    const run = runs.begin(job.id);
    logStart(job);
    try {
      if (job.kind === "render") await runRender(job, run);
      else await runAgent(job, run);
    } catch (error) {
      await failLaunch(jobs.get(job.id) ?? job, error);
      run.end();
    }
  }

  return { launch };
}

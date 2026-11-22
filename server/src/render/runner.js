// The render runner (docs/SPEC.md section 12): turns a project into an MP4 on the
// server with one `hyperframes render`, without an agent, and levels the sound.
//
//   const runner = createRenderRunner(deps);
//   const { done, stop } = runner.run({ id }, facts);   // done: Promise<RenderOutcome>, never rejects
//
// What the job manager does with it: it treats the runner like the agent driver. It calls `run`
// when a `render` job gets a slot, publishes the `onUpdate` patches, stores the outcome and calls
// `stop` for Stop. Patches go to `job.onUpdate` (or the runner's `onUpdate`).
// The runner itself counts the job with the limits module (`jobStarted` with the
// pid of each child, `jobEnded` at the end) and records every child in the process registry, so
// the manager must not do either for a render.
//
// Steps: read the project -> check the disk -> wait for a GPU slot -> render -> check the file
// (ffprobe) -> level the sound (ffmpeg loudnorm, two passes) -> move to `output/` -> clean up.
// Each step can be stopped; `cache/render/<jobId>/` is deleted and the GPU slot given back in
// every case.

import fs from "node:fs/promises";
import path from "node:path";
import { renderArgs, renderEnv, workFolders } from "./args.js";
import { diskRefusal } from "./diskSpace.js";
import { failureMessage } from "./diagnostics.js";
import {
  levelArgs,
  measureArgs,
  needsLevelling,
  parseMeasured,
  parseProbe,
  probeArgs,
  TARGET_LUFS,
} from "./loudness.js";
import { publishFinal, realFileOps } from "./outputName.js";
import { readProjectFacts } from "./projectFacts.js";
import { createRendererOutput } from "./rendererOutput.js";
import { runTool } from "./tool.js";
import { dataPaths } from "../config.js";
import { renderWorkersAt } from "../limits/budget.js";
import { spawnAgent, endTree } from "../platform/process.js";
import { statusDraft, errorDraft } from "../jobs/logDescribe.js";
import { createPublisher, PUBLISH_INTERVAL_MS } from "../jobs/progressView.js";
import { createRenderProgress, renderProgress, renderView } from "../jobs/progressRender.js";

/** @typedef {import("./args.js").RenderResolution} RenderResolution */
/** @typedef {import("../../../src/lib/wire/progress.ts").JobProgress} JobProgress */

/**
 * What the manager gives `run` besides the job.
 * @typedef {object} RenderFacts
 * @property {string} videoKey The video's database key (the job log is kept under it).
 * @property {string} projectDir `<video>/output/<video folder name>.hf`.
 * @property {string} videoDir The video's folder.
 * @property {string} folderName The video folder's name (the final file is named after it).
 * @property {RenderResolution} resolution `1080` or `2160`.
 * @property {string} userId Who started it (named in the log only).
 */

/**
 * How the run ended (the shape of the agent driver's `AgentOutcome`; a render is never paused).
 * @typedef {object} RenderOutcome
 * @property {"completed" | "stopped" | "failed"} state
 * @property {{ code: string, message: string } | null} error `code` is `"failed"`.
 * @property {null} sessionId
 * @property {null} costUsd
 * @property {number} activeMs From `run` to the end, waiting for a GPU slot included.
 * @property {string | null} deliverable The final file, set when `completed`.
 */

/**
 * What the runner reports while it runs, to be merged into the job like the driver's `JobPatch`.
 * @typedef {object} RenderPatch
 * @property {string} [lastActivity]
 * @property {{ view: JobProgress, memory: null, persist: boolean }} [progress]
 */

/**
 * @typedef {object} RenderLimits The part of `limits.api` the runner uses.
 * @property {(jobKey: string) => Record<string, string>} envFor
 * @property {(jobKey: string) => { renderWorkers: number }} limitsFor
 * @property {(jobKey: string, job: { rootPid: number | null, kind: string }) => unknown} jobStarted
 * @property {(jobKey: string) => void} jobEnded
 * @property {(jobKey: string) => unknown} resumeAll
 * @property {(jobKey: string, signal?: AbortSignal) => Promise<{ index: number, release(): void }>} acquireGpuSlot
 */

/** @typedef {string | null | (() => string | null)} PathSource */

/**
 * @typedef {object} RenderRunnerDeps
 * @property {RenderLimits} limits
 * @property {{ add(entry: { jobId: string, pid: number }): Promise<void>, remove(pid: number): Promise<void> } | null} [registry]
 * @property {{ push(videoKey: string, jobId: string, drafts: readonly import("../jobs/logDescribe.js").Draft[]): void }} sink
 * @property {(patch: RenderPatch) => void} [onUpdate] Default: ignored. The manager binds the job.
 * @property {string} dataDir
 * @property {{ now(): number }} clock
 * @property {{ setTimeout(callback: () => void, ms: number): unknown, clearTimeout(handle: unknown): void }} [timers]
 * @property {import("../log.js").Logger} log
 * @property {string} hyperframesBin The `hyperframes.mjs` script of the pinned installation.
 * @property {string} [nodePath] The Node.js that runs it (default: this server's).
 * @property {PathSource} ffmpeg
 * @property {PathSource} ffprobe
 * @property {PathSource} browserPath The browser Prepare found (`null`: the renderer looks itself).
 * @property {(dir: string) => Promise<number>} freeBytes Free bytes of the disk holding `dir`.
 * @property {(spec: import("./tool.js").ToolSpec) => import("./tool.js").ChildLike} [spawn]
 *   Default: `spawnAgent` of `platform/process.js`.
 * @property {(pid: number, options?: { graceMs?: number }) => Promise<boolean>} [endTree]
 * @property {number} [endGraceMs] How long a tree may take to end after SIGTERM (default 3000).
 * @property {import("./outputName.js").FileOps} [fileOps]
 * @property {Readonly<Record<string, string | undefined>>} [env] The base environment (default:
 *   the server's).
 * @property {number} [gpuNoteMs] How long a wait for a GPU slot must last before the log says so
 *   (default 1500).
 */

/** The thing thrown to leave the pipeline when `stop` was called. */
class Stopped extends Error {}

/** A failure with a sentence for the user. */
class Failure extends Error {}

const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/u;

/** @param {PathSource} source @returns {string | null} */
const pathOf = (source) => (typeof source === "function" ? source() : source);

/** @param {unknown} error @returns {string} */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * @param {RenderRunnerDeps} deps
 */
export function createRenderRunner(deps) {
  const {
    limits,
    registry = null,
    sink,
    onUpdate = () => {},
    dataDir,
    clock,
    timers = {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(/** @type {NodeJS.Timeout} */ (h)),
    },
    log,
    hyperframesBin,
    nodePath = process.execPath,
    freeBytes,
    spawn = (spec) =>
      /** @type {import("./tool.js").ChildLike} */ (
        /** @type {unknown} */ (
          spawnAgent({
            command: spec.command,
            args: spec.args,
            env: spec.env,
            ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
          })
        )
      ),
    endTree: end = endTree,
    endGraceMs = 3000,
    fileOps = realFileOps,
    env: baseEnv = process.env,
    gpuNoteMs = 1500,
  } = deps;
  const renderRoot = dataPaths(dataDir).renderCacheDir;
  /** Jobs running now (their folders are not swept). @type {Set<string>} */
  const active = new Set();

  /** @param {string} jobId @returns {string} */
  const workDirOf = (jobId) => path.join(renderRoot, jobId);

  /**
   * @param {{ id: string, onUpdate?: (patch: RenderPatch) => void }} job `onUpdate` receives this
   *   job's patches (the manager binds the job id there); default: the runner's `onUpdate`.
   * @param {RenderFacts} facts
   * @returns {{ done: Promise<RenderOutcome>, stop(): void }}
   */
  function run(job, facts) {
    const jobId = job.id;
    const report = job.onUpdate ?? onUpdate;
    const startedAt = clock.now();
    const abort = new AbortController();
    let stopped = false;
    /** The pid of the child that runs now. @type {number | null} */
    let current = null;
    /** @type {{ release(): void } | null} */
    let slot = null;
    const workDir = workDirOf(jobId);

    // ---- log and progress ------------------------------------------------------------------
    /** @param {readonly import("../jobs/logDescribe.js").Draft[]} drafts */
    const push = (drafts) => {
      try {
        sink.push(facts.videoKey, jobId, drafts);
      } catch (error) {
        log.warn(`The log of render ${jobId} could not be written`, error);
      }
    };
    /** @param {string} text @param {string | null} [detail] */
    const say = (text, detail = null) => push([statusDraft(text, { detail })]);
    /** @param {string} text */
    const complain = (text) => push([errorDraft(text)]);

    let bar = createRenderProgress();
    const publisher = createPublisher({ clock, intervalMs: PUBLISH_INTERVAL_MS });
    /** @param {JobProgress} view @param {string} activity @param {boolean} [force] */
    const publish = (view, activity, force = false) => {
      const decision = publisher.consider(view, force);
      if (!decision.publish) return;
      try {
        report({
          lastActivity: activity,
          progress: { view, memory: null, persist: decision.persist },
        });
      } catch (error) {
        log.warn(`The progress of render ${jobId} could not be published`, error);
      }
    };
    /** A step after the renderer: the bar stays where it is, the stage changes. @param {string} stage */
    const stepTo = (stage) => {
      publish({ percent: bar.percent, stage, secondsLeft: null }, stage, true);
    };

    // ---- children --------------------------------------------------------------------------
    /** Ends the tree of the running child (resuming it first if the limiter froze it). */
    async function endCurrent() {
      const pid = current;
      if (pid === null) return;
      try {
        limits.resumeAll(jobId);
      } catch {
        // Nothing frozen is the usual case.
      }
      try {
        await end(pid, { graceMs: endGraceMs });
      } catch (error) {
        log.warn(`The process tree of render ${jobId} could not be ended`, error);
      }
    }

    /**
     * Runs a child to its end. Throws `Stopped` when `stop` was called meanwhile.
     * @param {string} command
     * @param {readonly string[]} args
     * @param {{ env: Record<string, string | undefined>, counted: boolean, renderer?: boolean, onLine?: (line: string) => void }} options
     * @returns {Promise<import("./tool.js").ToolResult>}
     */
    async function child(command, args, { env, counted, renderer = false, onLine }) {
      if (stopped) throw new Stopped();
      const started = runTool(
        { command, args, env, cwd: workDir },
        {
          spawn,
          onStart: async (pid) => {
            if (counted) limits.jobStarted(jobId, { rootPid: pid, kind: "render" });
            await registry?.add({ jobId, pid });
          },
          onEnd: async (pid) => {
            await registry?.remove(pid);
          },
          ...(onLine ? { onLine } : {}),
        },
      );
      current = started.pid;
      // `stop` may have been called while the child was being made.
      if (stopped) void endCurrent();
      const result = await started.done;
      // Whatever the renderer left running (its browsers) goes with it.
      const pid = current;
      current = null;
      if (renderer && pid !== null) await end(pid, { graceMs: 500 }).catch(() => false);
      if (stopped) throw new Stopped();
      return result;
    }

    // ---- the steps -------------------------------------------------------------------------
    /** @returns {string} */
    function tool(/** @type {PathSource} */ source, /** @type {string} */ name) {
      const found = pathOf(source);
      if (found === null) {
        throw new Failure(
          `${name} is not installed on the server, so the final video cannot be checked and levelled. ` +
            "Ask the administrator to install FFmpeg.",
        );
      }
      return found;
    }

    /**
     * @param {string} ffprobe
     * @param {string} file
     * @returns {Promise<import("./loudness.js").FileFacts>}
     */
    async function probe(ffprobe, file) {
      const result = await child(ffprobe, probeArgs(file), { env: toolEnv, counted: false });
      const facts_ = result.code === 0 ? parseProbe(result.stdout) : null;
      if (facts_ === null) throw new Failure("The rendered video file cannot be read.");
      return facts_;
    }

    /** The environment of ffmpeg and ffprobe: the server's, with the working folder for temp files. */
    const toolEnv = {
      ...baseEnv,
      ...renderEnv({ base: baseEnv, limits: {}, workDir, browserPath: null }),
    };

    async function pipeline() {
      if (!JOB_ID.test(jobId)) throw new Failure("This render has no valid job number.");
      if (facts.resolution !== 1080 && facts.resolution !== 2160) {
        throw new Failure("The render resolution must be 1080 or 2160.");
      }
      const ffmpeg = tool(deps.ffmpeg, "ffmpeg");
      const ffprobe = tool(deps.ffprobe, "ffprobe");

      // 1. The project.
      /** @type {import("./projectFacts.js").ProjectFacts} */
      let project;
      try {
        project = await readProjectFacts(facts.projectDir);
      } catch (error) {
        throw new Failure(messageOf(error));
      }

      // 2. The disk.
      let free;
      try {
        free = await freeBytes(renderRoot);
      } catch (error) {
        log.warn(`The free disk space for render ${jobId} is unknown`, error);
        free = null;
      }
      if (free !== null) {
        const refusal = diskRefusal({
          seconds: project.seconds,
          freeBytes: free,
          resolution: facts.resolution,
        });
        if (refusal !== null) throw new Failure(refusal);
      }
      if (stopped) throw new Stopped();

      const folders = workFolders(workDir);
      for (const dir of Object.values(folders)) await fs.mkdir(dir, { recursive: true });
      const outFile = path.join(folders.out, "render.mp4");
      const levelled = path.join(folders.out, "levelled.mp4");

      const workers = renderWorkersAt(limits.limitsFor(jobId).renderWorkers, facts.resolution);
      say(
        `Rendering the final video at ${facts.resolution}p (${project.fps} fps, ` +
          `${workers} ${workers === 1 ? "worker" : "workers"})`,
      );
      publish({ percent: bar.percent, stage: bar.stage, secondsLeft: null }, bar.stage, true);

      // 3. A GPU slot, for the whole render. The SPEC says a job takes a slot for its whole
      // render, so the default is to wait for one (a stop ends the wait). Only when the slots
      // cannot be used at all (the folder cannot be written) the render goes on in software.
      const note = timers.setTimeout(() => {
        say("Waiting for a free GPU slot");
        publish(
          { percent: 0, stage: "Waiting for a free GPU slot", secondsLeft: null },
          "Waiting for a free GPU slot",
          true,
        );
      }, gpuNoteMs);
      try {
        slot = await limits.acquireGpuSlot(jobId, abort.signal);
      } catch (error) {
        if (stopped) throw new Stopped();
        log.warn(`No GPU slot for render ${jobId}; rendering without the GPU`, error);
        say("No GPU slot could be taken, so the video is encoded without the GPU");
      } finally {
        timers.clearTimeout(note);
      }
      if (stopped) throw new Stopped();
      const gpu = slot !== null;

      // 4. The renderer.
      const output = createRendererOutput({
        status: say,
        progress: (update, activity) => {
          bar = renderProgress(bar, update);
          publish(renderView(bar), activity);
        },
        stage: (_stage, activity) => {
          // Before capture: the stage changes, the percent stays.
          if (bar.step === -1)
            publish({ percent: bar.percent, stage: activity, secondsLeft: null }, activity, true);
        },
      });
      const args = renderArgs({
        projectDir: facts.projectDir,
        outFile,
        fps: project.fps,
        workers,
        resolution: facts.resolution,
        portrait: project.portrait,
        gpu,
      });
      const rendererEnv = renderEnv({
        base: baseEnv,
        limits: limits.envFor(jobId),
        workDir,
        browserPath: pathOf(deps.browserPath),
        ffmpeg,
        ffprobe,
      });
      say(gpu ? "Rendering with GPU encoding" : "Rendering with software encoding");
      const rendered = await child(nodePath, [hyperframesBin, ...args], {
        env: rendererEnv,
        counted: true,
        renderer: true,
        onLine: (line) => output.line(line),
      });
      if (rendered.startError !== null) {
        throw new Failure(`The renderer could not be started: ${rendered.startError.message}`);
      }
      if (rendered.code !== 0) {
        const lines = output.tail();
        throw new Failure(failureMessage(lines, rendered.code));
      }
      if (!(await exists(outFile))) {
        throw new Failure("The renderer finished but did not write a video file.");
      }
      slot?.release();
      slot = null;

      // 5. The file.
      stepTo("Checking the video");
      say("Checking the rendered file");
      const facts1 = await probe(ffprobe, outFile);
      if (!facts1.hasVideo) throw new Failure("The rendered file has no picture.");
      if (facts1.videoFrames !== null && Math.abs(facts1.videoFrames - project.frames) > 1) {
        throw new Failure(
          `The rendered video has ${facts1.videoFrames} frames but the project has ${project.frames}.`,
        );
      }

      // 6. The sound.
      let ready = outFile;
      if (!facts1.hasAudio) {
        say("The rendered file has no sound, so there is nothing to level");
      } else {
        stepTo("Levelling the sound");
        const measuring = await child(ffmpeg, measureArgs(outFile), {
          env: toolEnv,
          counted: true,
        });
        const measured = measuring.code === 0 ? parseMeasured(measuring.stderr) : null;
        if (measuring.code !== 0)
          throw new Failure("The sound of the rendered video could not be measured.");
        if (measured === null) {
          say("The sound is silent, so there is nothing to level");
        } else if (!needsLevelling(measured)) {
          say(
            `The sound is already at ${measured.input_i.toFixed(1)} LUFS (peak ${measured.input_tp.toFixed(1)} dBTP), left as it is`,
          );
        } else {
          say(
            `Levelling the sound from ${measured.input_i.toFixed(1)} to ${TARGET_LUFS} LUFS ` +
              `(peak ${measured.input_tp.toFixed(1)} dBTP)`,
          );
          const leveling = await child(ffmpeg, levelArgs(outFile, levelled, measured), {
            env: toolEnv,
            counted: true,
          });
          if (leveling.code !== 0 || !(await exists(levelled))) {
            throw new Failure("The sound of the rendered video could not be levelled.");
          }
          const again = await probe(ffprobe, levelled);
          if (!again.hasVideo || !again.hasAudio) {
            throw new Failure("The levelled video lost its picture or its sound.");
          }
          ready = levelled;
        }
      }

      // 7. The output folder. From here on a stop comes too late: the file is made, so it is
      // saved and the job completes.
      stepTo("Saving the video");
      let saved;
      try {
        saved = await publishFinal({
          file: ready,
          outputDir: path.join(facts.videoDir, "output"),
          folderName: facts.folderName,
          ops: fileOps,
        });
      } catch (error) {
        throw new Failure(
          `The final video could not be saved in the output folder: ${messageOf(error)}.`,
        );
      }
      return saved;
    }

    /** @param {string} file @returns {Promise<boolean>} */
    async function exists(file) {
      try {
        return (await fs.stat(file)).isFile();
      } catch {
        return false;
      }
    }

    async function cleanup() {
      try {
        slot?.release();
      } catch (error) {
        log.warn(`The GPU slot of render ${jobId} could not be given back`, error);
      }
      slot = null;
      try {
        limits.jobEnded(jobId);
      } catch (error) {
        log.warn(`Render ${jobId} could not be taken off the limits`, error);
      }
      if (JOB_ID.test(jobId)) {
        try {
          await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch (error) {
          log.warn(`The working folder of render ${jobId} could not be deleted`, error);
        }
      }
      active.delete(jobId);
    }

    /**
     * @param {"completed" | "stopped" | "failed"} state
     * @param {string | null} message
     * @param {string | null} deliverable
     * @returns {RenderOutcome}
     */
    const outcome = (state, message, deliverable) => ({
      state,
      error: message === null ? null : { code: "failed", message },
      sessionId: null,
      costUsd: null,
      activeMs: Math.max(clock.now() - startedAt, 0),
      deliverable,
    });

    active.add(jobId);
    const done = (async () => {
      /** @type {RenderOutcome} */
      let result;
      try {
        const saved = await pipeline();
        say(`Saved ${path.basename(saved)}`);
        bar = renderProgress(bar, { type: "completed" });
        publish(renderView(bar), `Saved ${path.basename(saved)}`, true);
        result = outcome("completed", null, saved);
      } catch (error) {
        if (error instanceof Stopped || stopped) {
          say("The render was stopped");
          result = outcome("stopped", null, null);
        } else if (error instanceof Failure) {
          complain(error.message);
          result = outcome("failed", error.message, null);
        } else {
          log.warn(`Render ${jobId} failed unexpectedly`, error);
          const message = `The render failed unexpectedly: ${messageOf(error)}.`;
          complain(message);
          result = outcome("failed", message, null);
        }
      }
      await cleanup();
      return result;
    })();

    return {
      done,
      stop() {
        if (stopped) return;
        stopped = true;
        abort.abort();
        void endCurrent();
      },
    };
  }

  /**
   * Deletes the working folders of jobs that are not running (a killed renderer leaves its work
   * files and its browsers' profiles behind). Call it once at the start of the server, before
   * any job runs.
   * @param {Iterable<string>} [running] Job ids that are running anyway.
   * @returns {Promise<number>} How many folders were deleted.
   */
  async function sweep(running = []) {
    const keep = new Set([...running, ...active]);
    /** @type {string[]} */
    let names;
    try {
      names = await fs.readdir(renderRoot);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (keep.has(name)) continue;
      try {
        await fs.rm(path.join(renderRoot, name), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
        removed += 1;
      } catch (error) {
        log.warn(`The old render folder ${name} could not be deleted`, error);
      }
    }
    return removed;
  }

  return { run, sweep, workDirOf };
}

/** @typedef {ReturnType<typeof createRenderRunner>} RenderRunner */

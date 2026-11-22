// The pictures of change requests (docs/SPEC.md section 11, Change requests): before a job starts,
// the server writes for each request the whole frame as it looks in the finished video at exactly
// that frame (`frame.png`), with a shape a close-up of the marked area (`closeup.png`) and the whole
// frame with the ellipse drawn on it (`frame-marked.png`), into the request's folder.
//
// How (measured with HyperFrames 0.9.80, see the report): ONE `hyperframes snapshot` run for all
// frames of the job, because the browser start and the page load are most of the time of a run
// (4 frames took 2.9 seconds, 1 frame 2.3). `--at` takes every wanted instant, `--zoom` crops the
// same region of every frame, so a different region per request would need a run each; instead,
// when any request has a shape, every frame is captured whole at double density
// (`--zoom 0,0,W,H --zoom-scale 2`) and ffmpeg makes the pictures from that: the whole frame
// reduced to 1280 on the long side, the close-up cropped at full density.
//
// Rules:
// - one capture at a time for the whole server (one instance of this module is shared): the browser
//   is heavy and the job is not started yet, so it runs under no job's limits;
// - a time limit per run, the child ended on `stop()`;
// - the project folder is left as it was (`.hyperframes/` is written there by the tool and deleted);
// - a capture that fails never fails the job: the request's pictures are `null` and the log says why.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { guardFolder } from "./noteGuard.js";
import { pictureArgs } from "./noteFilters.js";
import { frameMiddleText } from "./noteTimes.js";
import { startRun } from "./noteRun.js";

/** @typedef {import("./frames.js").Fps} Fps */
/** @typedef {import("../../../src/lib/wire/timeline.ts").NoteShape} NoteShape */

/** Names of the files written into a request's folder. */
export const PICTURE_FILES = Object.freeze({
  frame: "frame.png",
  closeup: "closeup.png",
  marked: "frame-marked.png",
});

/** The density the close-ups are cut from, as a long side in pixels: text of a 1080p frame stays sharp. */
const DENSITY_TARGET_LONG_SIDE = 3840;
const MAX_ZOOM_SCALE = 3;

/** The time the tool may wait for the page and for each still (`--timeout`). */
const STILL_TIMEOUT_MS = 45_000;
/** The limit of a whole run: the start of the browser and page, plus a share per frame. */
const RUN_BASE_MS = 90_000;
const RUN_PER_FRAME_MS = 15_000;
const RUN_MAX_MS = 600_000;
/** The limit of one ffmpeg run. */
const FFMPEG_TIMEOUT_MS = 60_000;

/**
 * @typedef {object} NotePicturesDeps
 * @property {string | null} cli The HyperFrames CLI script (`node_modules/hyperframes/bin/hyperframes.mjs`);
 *   null: not installed, every capture fails with that reason.
 * @property {string | null} ffmpeg The `ffmpeg` program (`findFfmpeg()`); null: the capture is used
 *   as it is (no reduction, no close-up, no outline).
 * @property {string} [workDir] Where a run's temporary folder is made (default: the system's).
 * @property {string} [node] The program that runs the script (default: this Node.js).
 * @property {Readonly<Record<string, string | undefined>>} [env] Base environment (default: this process's).
 * @property {string | null} [browserPath] The browser found by Prepare, as `HYPERFRAMES_BROWSER_PATH`.
 * @property {Pick<import("../log.js").Logger, "info" | "warn">} [log]
 * @property {import("./noteRun.js").StartRun} [start] Test seam: starts a program.
 */

/**
 * @typedef {object} CaptureRequest
 * @property {number} frame
 * @property {NoteShape | null} shape
 * @property {string} folder Absolute path of the request's folder (made if missing).
 */

/**
 * @typedef {object} CaptureInput
 * @property {string} projectDir
 * @property {Fps} fps
 * @property {number} width The project's frame size in pixels.
 * @property {number} height
 * @property {CaptureRequest[]} requests
 */

/**
 * @typedef {object} NotePictureFiles
 * @property {string | null} frame Absolute path of `frame.png`, or null.
 * @property {string | null} closeup Absolute path of `closeup.png`, or null (no shape, or failed).
 * @property {string | null} marked Absolute path of `frame-marked.png`, or null.
 */

/** @returns {NotePictureFiles} */
const none = () => ({ frame: null, closeup: null, marked: null });

/**
 * The density to capture at: the scale that brings the long side to about 3840 pixels, 1 to 3.
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
export function zoomScaleFor(width, height) {
  const scale = Math.round(DENSITY_TARGET_LONG_SIDE / Math.max(width, height));
  return Math.min(MAX_ZOOM_SCALE, Math.max(1, scale));
}

/**
 * The arguments of `hyperframes snapshot` for all frames of one run.
 * @param {object} input
 * @param {string} input.cli
 * @param {string} input.projectDir
 * @param {string} input.outDir
 * @param {string[]} input.times Seconds as text, ascending.
 * @param {{ width: number, height: number, scale: number } | null} input.zoom Whole-frame capture
 *   at this density, or null for the normal density.
 * @returns {string[]}
 */
export function snapshotArgs({ cli, projectDir, outDir, times, zoom }) {
  const args = [
    cli,
    "snapshot",
    projectDir,
    "--at",
    times.join(","),
    "--no-end",
    "-o",
    outDir,
    "--json",
    "--timeout",
    String(STILL_TIMEOUT_MS),
  ];
  if (zoom !== null) {
    args.push("--zoom", `0,0,${zoom.width},${zoom.height}`, "--zoom-scale", String(zoom.scale));
  }
  return args;
}

/**
 * The size of a PNG file, from its header.
 * @param {string} file
 * @returns {Promise<{ width: number, height: number } | null>}
 */
export async function pngSize(file) {
  let handle;
  try {
    handle = await fsp.open(file, "r");
    const head = Buffer.alloc(24);
    const { bytesRead } = await handle.read(head, 0, 24, 0);
    const signature = head.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
    if (bytesRead < 24 || !signature || head.subarray(12, 16).toString("latin1") !== "IHDR") {
      return null;
    }
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * The paths of the stills in the order of the times: from the tool's JSON answer, else (a tool that
 * printed no JSON) from the files `frame-NN-at-...png`.
 * @param {string} stdout
 * @param {string} outDir
 * @returns {string[]}
 */
export function stillPaths(stdout, outDir) {
  const open = stdout.indexOf("{");
  const close = stdout.lastIndexOf("}");
  if (open >= 0 && close > open) {
    try {
      const value = JSON.parse(stdout.slice(open, close + 1));
      if (value && Array.isArray(value.frames)) {
        const paths = value.frames
          .map((/** @type {{ path?: unknown }} */ f) => f?.path)
          .filter((/** @type {unknown} */ p) => typeof p === "string");
        if (paths.length > 0) return paths;
      }
    } catch {
      // Fall through to the folder.
    }
  }
  try {
    return fs
      .readdirSync(outDir)
      .filter((name) => /^frame-\d+-at-.*\.png$/.test(name))
      .sort()
      .map((name) => path.join(outDir, name));
  } catch {
    return [];
  }
}

/**
 * @param {NotePicturesDeps} deps
 */
export function createNotePictures({
  cli,
  ffmpeg,
  workDir = os.tmpdir(),
  node = process.execPath,
  env = process.env,
  browserPath = null,
  log = { info() {}, warn() {} },
  start = startRun,
}) {
  /** The run in progress (for `stop`). */
  /** @type {import("./noteRun.js").Run | null} */
  let current = null;
  let stopped = false;
  /** One capture at a time: each waits for the one before it. */
  let tail = Promise.resolve();

  /** @returns {Record<string, string | undefined>} */
  function toolEnv() {
    /** @type {Record<string, string | undefined>} */
    const e = { ...env, HYPERFRAMES_NO_TELEMETRY: "1", HYPERFRAMES_NO_UPDATE_CHECK: "1" };
    if (browserPath !== null) e.HYPERFRAMES_BROWSER_PATH = browserPath;
    return e;
  }

  /**
   * Runs one program through the seam and remembers it as the current run.
   * @param {import("./noteRun.js").RunOptions} options
   * @returns {Promise<import("./noteRun.js").RunResult>}
   */
  async function run(options) {
    const started = start(options);
    current = started;
    try {
      return await started.done;
    } finally {
      current = null;
    }
  }

  /**
   * Makes the pictures of one request from its capture.
   * @param {CaptureRequest} request
   * @param {string} still
   * @param {number} index
   * @returns {Promise<NotePictureFiles>}
   */
  async function makePictures(request, still, index) {
    const size = await pngSize(still);
    if (size === null) {
      log.warn(`Change request pictures: the capture ${path.basename(still)} is not a PNG.`);
      return none();
    }
    const folder = path.resolve(request.folder);
    await fsp.mkdir(folder, { recursive: true });
    const files = {
      frame: path.join(folder, PICTURE_FILES.frame),
      closeup: path.join(folder, PICTURE_FILES.closeup),
      marked: path.join(folder, PICTURE_FILES.marked),
    };
    // Pictures of an earlier attempt must not pass for these.
    for (const file of Object.values(files)) await fsp.rm(file, { force: true });
    if (ffmpeg === null) {
      await fsp.copyFile(still, files.frame);
      log.warn("Change request pictures: ffmpeg was not found, the full capture is used as it is.");
      return { frame: files.frame, closeup: null, marked: null };
    }
    const args = pictureArgs({
      input: still,
      inputWidth: size.width,
      inputHeight: size.height,
      shape: request.shape,
      frameFile: files.frame,
      markedFile: files.marked,
      closeupFile: files.closeup,
    });
    let result;
    try {
      result = await run({ command: ffmpeg, args, timeoutMs: FFMPEG_TIMEOUT_MS, env });
    } catch (error) {
      log.warn(`Change request pictures: ffmpeg could not be started (${describe(error)}).`);
      return none();
    }
    if (result.code !== 0 || result.timedOut || !fs.existsSync(files.frame)) {
      const why = result.timedOut ? "it did not finish in time" : lastLine(result.stderr);
      log.warn(`Change request pictures: ffmpeg failed for request ${index + 1} (${why}).`);
      for (const file of Object.values(files)) await fsp.rm(file, { force: true });
      return none();
    }
    const has = (/** @type {string} */ file) => fs.existsSync(file);
    return {
      frame: files.frame,
      closeup: request.shape !== null && has(files.closeup) ? files.closeup : null,
      marked: request.shape !== null && has(files.marked) ? files.marked : null,
    };
  }

  /**
   * @param {CaptureInput} input
   * @returns {Promise<NotePictureFiles[]>}
   */
  async function captureNow(input) {
    const { projectDir, fps, width, height, requests } = input;
    if (requests.length === 0) return [];
    const failAll = (/** @type {string} */ why) => {
      log.warn(`Change request pictures were not made: ${why}.`);
      return requests.map(none);
    };
    if (stopped) return failAll("the server is stopping");
    if (cli === null) return failAll("the hyperframes package is not installed");

    const frames = [...new Set(requests.map((r) => r.frame))].sort((a, b) => a - b);
    const times = frames.map((frame) => frameMiddleText(frame, fps));
    const anyShape = requests.some((r) => r.shape !== null);
    const scale = anyShape ? zoomScaleFor(width, height) : 1;
    const zoom = scale > 1 ? { width, height, scale } : null;

    await fsp.mkdir(workDir, { recursive: true });
    const outDir = await fsp.mkdtemp(path.join(workDir, "snapshot-"));
    const guard = await guardFolder(projectDir);
    try {
      let result;
      try {
        result = await run({
          command: node,
          args: snapshotArgs({ cli, projectDir, outDir, times, zoom }),
          cwd: outDir,
          env: toolEnv(),
          timeoutMs: Math.min(RUN_MAX_MS, RUN_BASE_MS + RUN_PER_FRAME_MS * frames.length),
        });
      } catch (error) {
        return failAll(`the capture program could not be started (${describe(error)})`);
      } finally {
        const removed = await guard.restore();
        if (removed.length > 0) {
          log.info(
            `Change request pictures: removed ${removed.join(", ")} from the project folder.`,
          );
        }
      }
      if (result.stopped) return failAll("the server is stopping");
      if (result.timedOut) return failAll("the capture did not finish in time");
      if (result.code !== 0) {
        return failAll(`the capture failed (${lastLine(result.stderr || result.stdout)})`);
      }
      const stills = stillPaths(result.stdout, outDir);
      if (stills.length < frames.length) {
        return failAll(`it made ${stills.length} pictures instead of ${frames.length}`);
      }
      /** @type {NotePictureFiles[]} */
      const answers = [];
      for (const [index, request] of requests.entries()) {
        const still = stills[frames.indexOf(request.frame)];
        if (stopped || still === undefined) {
          answers.push(none());
          continue;
        }
        try {
          answers.push(await makePictures(request, still, index));
        } catch (error) {
          log.warn(`Change request pictures: request ${index + 1} failed (${describe(error)}).`);
          answers.push(none());
        }
      }
      return answers;
    } finally {
      await fsp.rm(outDir, { recursive: true, force: true });
    }
  }

  return {
    /**
     * Makes the pictures of the requests of one job, in one run. Never rejects: a failure gives
     * `null` pictures and a line in the log.
     * @param {CaptureInput} input
     * @returns {Promise<NotePictureFiles[]>} One entry per request, in order.
     */
    capture(input) {
      const next = tail.then(() => captureNow(input));
      const guarded = next.catch((error) => {
        log.warn(`Change request pictures were not made: ${describe(error)}.`);
        return input.requests.map(none);
      });
      tail = guarded.then(() => {});
      return guarded;
    },

    /**
     * Ends the run in progress and refuses new ones.
     * @returns {Promise<void>}
     */
    async stop() {
      stopped = true;
      await current?.stop();
      await tail;
    },
  };
}

/** @param {unknown} error */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {string} text @returns {string} The last non-empty line, short. */
function lastLine(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const last = lines[lines.length - 1] ?? "no message";
  return last.length > 200 ? `${last.slice(0, 200)}...` : last;
}

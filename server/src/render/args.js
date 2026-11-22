// The command line and environment of one `hyperframes render` (docs/SPEC.md section 12), built
// as pure functions so every case is tested without running anything.

import path from "node:path";

/** The video bitrate of each resolution (SPEC section 12). */
export const VIDEO_BITRATE = Object.freeze({ 1080: "12M", 2160: "40M" });

/** @typedef {1080 | 2160} RenderResolution */

/**
 * The renderer's own name for the 4K size of a project: its presets are named by shape.
 * @param {boolean} portrait
 * @returns {string}
 */
export function resolutionPreset(portrait) {
  return portrait ? "portrait-4k" : "landscape-4k";
}

/**
 * @typedef {object} RenderArgsInput
 * @property {string} projectDir
 * @property {string} outFile Where the renderer writes.
 * @property {string} fps From `readProjectFacts` (`30`, `25`, `30000/1001`).
 * @property {number} workers
 * @property {RenderResolution} resolution
 * @property {boolean} portrait The project is a Short (matters for 4K only).
 * @property {boolean} gpu Whether the job holds a GPU slot: then, and only then, `--gpu`.
 */

/**
 * The arguments after the script: `render <project> -o <file> --fps <fps> --workers <n>`, the
 * bitrate, `--resolution` at 2160 and `--gpu` while a GPU slot is held. `--start` and `--end` are
 * never used (they fail on videos longer than about 12 minutes, `PLAN_TOO_LARGE`).
 * @param {RenderArgsInput} input
 * @returns {string[]}
 */
export function renderArgs({ projectDir, outFile, fps, workers, resolution, portrait, gpu }) {
  const args = [
    "render",
    projectDir,
    "-o",
    outFile,
    "--fps",
    fps,
    "--workers",
    String(Math.max(1, Math.floor(workers))),
    "--video-bitrate",
    VIDEO_BITRATE[resolution],
  ];
  if (resolution === 2160) args.push("--resolution", resolutionPreset(portrait));
  if (gpu) args.push("--gpu");
  return args;
}

/**
 * @typedef {object} RenderEnvInput
 * @property {Readonly<Record<string, string | undefined>>} base The server's environment.
 * @property {Readonly<Record<string, string>>} limits `limits.envFor(jobId)` (`VE_*`).
 * @property {string} workDir `<data dir>/cache/render/<jobId>`.
 * @property {string | null} browserPath The browser Prepare found.
 * @property {string | null} [ffmpeg]
 * @property {string | null} [ffprobe]
 */

/** The folders of the working directory. @param {string} workDir */
export function workFolders(workDir) {
  return {
    tmp: path.join(workDir, "tmp"),
    extract: path.join(workDir, "extract"),
    out: path.join(workDir, "out"),
  };
}

/**
 * The renderer's environment: no telemetry or update check, no render lock (the queue is
 * VidAI's), its extraction cache and temporary files inside the job's working directory (a
 * killed renderer leaves them behind, and they are deleted with it), the browser Prepare found,
 * and the server's own `ffmpeg` and `ffprobe` when known.
 * @param {RenderEnvInput} input
 * @returns {Record<string, string | undefined>}
 */
export function renderEnv({ base, limits, workDir, browserPath, ffmpeg = null, ffprobe = null }) {
  const folders = workFolders(workDir);
  /** @type {Record<string, string | undefined>} */
  const env = {
    ...base,
    ...limits,
    HYPERFRAMES_NO_TELEMETRY: "1",
    HYPERFRAMES_NO_UPDATE_CHECK: "1",
    HYPERFRAMES_RENDER_LOCK: "off",
    HYPERFRAMES_EXTRACT_CACHE_DIR: folders.extract,
    // Several workers pipe their frames, in order, straight into the one H.264 encoder instead of
    // writing every frame to disk first: same time and memory, about 3.6 GB less temporary disk
    // per minute at 2160 (measured 2026-11-22, HyperFrames 0.9.80). Should the encoder not start,
    // HyperFrames falls back to frames on disk, which the disk rule (`diskSpace.js`) still covers.
    HF_DE_PARALLEL_STREAM: "true",
    // Unix reads TMPDIR, Windows TEMP and TMP; setting all three is harmless everywhere.
    TMPDIR: folders.tmp,
    TEMP: folders.tmp,
    TMP: folders.tmp,
  };
  if (browserPath !== null) env.HYPERFRAMES_BROWSER_PATH = browserPath;
  if (ffmpeg !== null) env.HYPERFRAMES_FFMPEG_PATH = ffmpeg;
  if (ffprobe !== null) env.HYPERFRAMES_FFPROBE_PATH = ffprobe;
  return env;
}

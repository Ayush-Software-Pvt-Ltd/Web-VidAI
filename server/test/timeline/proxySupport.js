// Shared test helpers for the preview copy tests (not a test file itself): ffprobe JSON as the
// real program prints it for the cases that matter, a fake ffprobe, a fake ffmpeg and a project.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ffprobe's JSON for one file; every field has the value of a light camera-free MP4 unless given.
 * @param {Record<string, any>} [over]
 */
export function probeJson(over = {}) {
  const s = {
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    vcodec: "h264",
    pix: "yuv420p",
    w: 1280,
    h: 720,
    fps: "30/1",
    acodec: /** @type {string | null} */ ("aac"),
    bitrate: /** @type {string | null} */ ("4000000"),
    duration: "30.0",
    keyGap: 1,
    rotation: 0,
    transfer: /** @type {string | undefined} */ (undefined),
    space: /** @type {string | undefined} */ (undefined),
    field: "progressive",
    sar: "1:1",
    cover: false,
    ...over,
  };
  const streams = [];
  /** @type {Record<string, any>} */
  const video = {
    index: 0,
    codec_name: s.vcodec,
    codec_type: "video",
    width: s.w,
    height: s.h,
    sample_aspect_ratio: s.sar,
    pix_fmt: s.pix,
    field_order: s.field,
    r_frame_rate: s.fps,
    avg_frame_rate: s.fps,
    disposition: { attached_pic: 0 },
    tags: {},
  };
  if (s.transfer) video["color_transfer"] = s.transfer;
  if (s.space) video["color_space"] = s.space;
  if (s.rotation !== 0) {
    video["side_data_list"] = [{ side_data_type: "Display Matrix", rotation: s.rotation }];
  }
  streams.push(video);
  if (s.acodec) {
    streams.push({
      index: 1,
      codec_name: s.acodec,
      codec_type: "audio",
      r_frame_rate: "0/0",
      avg_frame_rate: "0/0",
      disposition: { attached_pic: 0 },
      tags: {},
    });
  }
  if (s.cover) {
    streams.push({
      index: 2,
      codec_name: "mjpeg",
      codec_type: "video",
      width: 600,
      height: 600,
      disposition: { attached_pic: 1 },
    });
  }
  const [n = 30, d = 1] = s.fps.split("/").map(Number);
  const step = d / n;
  const window = Math.min(10, Number(s.duration));
  const packets = [];
  for (let i = 0; i * step < window; i += 1) {
    const t = i * step;
    const key = Math.abs(t / s.keyGap - Math.round(t / s.keyGap)) < step / s.keyGap / 2;
    packets.push({
      stream_index: 0,
      pts_time: t.toFixed(6),
      dts_time: (t - step).toFixed(6),
      flags: key ? "K__" : "___",
    });
    // Sound packets are all key frames; they must not count.
    packets.push({ stream_index: 1, pts_time: t.toFixed(6), dts_time: t.toFixed(6), flags: "K__" });
  }
  return {
    packets,
    streams,
    format: {
      format_name: s.container,
      duration: s.duration,
      ...(s.bitrate === null ? {} : { bit_rate: s.bitrate }),
    },
  };
}

/**
 * A fake `helper` (runs ffprobe): answers by the file it is asked about.
 * @param {Record<string, unknown | (() => unknown)>} answers The JSON per file path.
 * @returns {((options: { command: string, args: readonly string[], timeoutMs: number }) => Promise<{ code: number | null, signal: null, stdout: string, stderr: string, timedOut: boolean }>) & { calls: string[] }}
 */
export function fakeProbe(answers) {
  /** @type {string[]} */
  const calls = [];
  const fn = async (
    /** @type {{ command: string, args: readonly string[], timeoutMs: number }} */ { args },
  ) => {
    const file = /** @type {string} */ (args[args.length - 1]);
    calls.push(file);
    const answer = answers[file];
    if (answer === undefined) {
      return { code: 1, signal: null, stdout: "", stderr: "no such file", timedOut: false };
    }
    const json = typeof answer === "function" ? answer() : answer;
    return { code: 0, signal: null, stdout: JSON.stringify(json), stderr: "", timedOut: false };
  };
  return Object.assign(fn, { calls });
}

/**
 * A fake ffmpeg for the copies: writes its output file when released, or fails.
 * @param {{ hold?: boolean }} [options] `hold`: copies wait until `release(i)` is called.
 */
export function fakeFfmpeg(options = {}) {
  /** @type {{ args: string[], output: string, release: (code?: number) => void, stopped: boolean }[]} */
  const runs = [];
  /** @type {import("../../src/timeline/proxyRun.js").StartCopy} */
  const start = ({ args }) => {
    const output = /** @type {string} */ (args[args.length - 1]);
    /** @type {(value: { code: number | null, stderr: string }) => void} */
    let finish = () => {};
    const done = new Promise((resolve) => {
      finish = resolve;
    });
    /** @type {{ args: string[], output: string, release: (code?: number) => void, stopped: boolean }} */
    const run = {
      args: [...args],
      output,
      stopped: false,
      release(code = 0) {
        if (code === 0) fs.writeFileSync(output, "copy");
        finish({ code, stderr: code === 0 ? "" : "boom" });
      },
    };
    runs.push(run);
    if (!options.hold) queueMicrotask(() => run.release(0));
    return {
      pid: 4000 + runs.length,
      done,
      stop: async () => {
        run.stopped = true;
        finish({ code: null, stderr: "" });
      },
    };
  };
  return { start, runs };
}

/** A temporary data directory and project for the factory tests. */
export function makeWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-proxy-"));
  const real = fs.realpathSync(root);
  const channel = path.join(real, "channel");
  const video = path.join(channel, "video");
  const projectDir = path.join(video, "output", "p.hf");
  fs.mkdirSync(path.join(projectDir, "assets", "media"), { recursive: true });
  return {
    root: real,
    dataDir: path.join(real, "data"),
    channel,
    video,
    projectDir,
    scope: { videoDir: video, channelDir: channel, videoId: "chan/video", userId: "user-1" },
    /**
     * Makes an original of `bytes` bytes and links it into the project under `name`.
     * @param {string} name
     * @param {number} [bytes]
     * @returns {string} The real path of the original.
     */
    addMedia(name, bytes = 100) {
      const file = path.join(video, name);
      fs.writeFileSync(file, Buffer.alloc(bytes, 1));
      fs.symlinkSync(file, path.join(projectDir, "assets", "media", name));
      return file;
    },
    cleanup: () => fs.rmSync(real, { recursive: true, force: true }),
  };
}

/** Limits that count calls. */
export function fakeLimits() {
  /** @type {string[]} */
  const log = [];
  let gpu = true;
  return {
    log,
    /** @param {boolean} free */
    setGpuFree(free) {
      gpu = free;
    },
    api: {
      envFor: (/** @type {string} */ key) => {
        log.push(`env ${key}`);
        return { VE_CPU_CORES: "3", VE_GPU_SLOTS_DIR: "/gpu", VE_JOB_ID: key };
      },
      jobStarted: (
        /** @type {string} */ key,
        /** @type {{ rootPid: number | null, kind: string }} */ job,
      ) => {
        log.push(`started ${key} ${job.kind} ${job.rootPid}`);
        return { budget: 3, cpuCores: 3, renderWorkers: 1 };
      },
      jobEnded: (/** @type {string} */ key) => {
        log.push(`ended ${key}`);
      },
      acquireGpuSlot: async (/** @type {string} */ key) => {
        if (!gpu) throw new Error("aborted");
        log.push(`gpu ${key}`);
        return { index: 0, release: () => log.push(`gpu released ${key}`) };
      },
    },
  };
}

/**
 * Lets the event loop run (file system calls included) until the condition holds.
 * @param {() => boolean} condition
 * @param {string} [what]
 */
export async function until(condition, what = "the condition") {
  for (let i = 0; i < 2000; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`gave up waiting for ${what}`);
}

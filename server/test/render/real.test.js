// The one test that runs the real renderer: the pinned HyperFrames CLI, real ffmpeg and ffprobe,
// a 3 second project at 1080 with one worker. It is slow and needs the renderer's browser, so it
// runs only when `VIDAI_TEST_REAL_RENDER=1`:
//
//   VIDAI_TEST_REAL_RENDER=1 node --test server/test/render/real.test.js

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { freeBytes } from "../../src/platform/disk.js";
import { listTree, runHelper } from "../../src/platform/process.js";
import { findFfmpeg, findFfprobe } from "../../src/platform/tools.js";
import { createRenderRunner } from "../../src/render/runner.js";
import { findHyperframesCli } from "../../src/timeline/lint.js";
import { alive, fakeLimits, memoryLog, waitFor } from "./helpers.js";
import { buildTinyProject } from "./realProject.js";

const enabled = process.env.VIDAI_TEST_REAL_RENDER === "1";

/** @type {string[]} */
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function setup() {
  const ffmpeg = findFfmpeg();
  const ffprobe = findFfprobe();
  const bin = findHyperframesCli();
  assert.ok(ffmpeg && ffprobe && bin, "ffmpeg, ffprobe and the hyperframes package are needed");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-real-render-"));
  dirs.push(root);
  const dataDir = path.join(root, "data");
  const videoDir = path.join(root, "channel", "Real Video");
  const projectDir = path.join(videoDir, "output", "Real Video.hf");
  fs.mkdirSync(dataDir, { recursive: true });
  const { frames } = await buildTinyProject(projectDir, ffmpeg);
  /** @type {string[]} */
  const lines = [];
  const limits = fakeLimits({ workers: 1 });
  const runner = createRenderRunner({
    limits: limits.api,
    sink: { push: (_k, _j, drafts) => void lines.push(...drafts.map((d) => d.text)) },
    dataDir,
    clock: { now: () => Date.now() },
    log: memoryLog(),
    hyperframesBin: bin,
    ffmpeg,
    ffprobe,
    browserPath: null,
    freeBytes,
  });
  /** @type {import("../../src/render/runner.js").RenderFacts} */
  const facts = {
    videoKey: "k".repeat(32),
    projectDir,
    videoDir,
    folderName: "Real Video",
    resolution: 1080,
    userId: "u1",
  };
  return { ffmpeg, ffprobe, runner, facts, frames, lines, dataDir, videoDir };
}

/** @param {string} ffmpeg @param {string} file @returns {Promise<number>} Integrated LUFS. */
async function loudness(ffmpeg, file) {
  const result = await runHelper({
    command: ffmpeg,
    args: [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-af",
      "ebur128=peak=true",
      "-vn",
      "-f",
      "null",
      "-",
    ],
    timeoutMs: 60_000,
  });
  const summary = result.stderr.slice(result.stderr.lastIndexOf("Summary:"));
  return Number(/I:\s+(-?[\d.]+) LUFS/u.exec(summary)?.[1]);
}

describe("real renderer", { skip: !enabled && "set VIDAI_TEST_REAL_RENDER=1 to run" }, () => {
  it(
    "renders, levels to -14 LUFS, names the file and cleans up",
    { timeout: 180_000 },
    async () => {
      const t = await setup();
      const outcome = await t.runner.run({ id: "real1" }, t.facts).done;
      assert.equal(outcome.state, "completed", outcome.error?.message ?? "");
      const file = outcome.deliverable ?? "";
      assert.equal(path.basename(file), "Real Video_final_v1.mp4");

      const probe = await runHelper({
        command: t.ffprobe,
        args: [
          "-v",
          "error",
          "-count_packets",
          "-show_entries",
          "stream=codec_type,codec_name,sample_rate,nb_read_packets",
          "-of",
          "json",
          file,
        ],
        timeoutMs: 30_000,
      });
      const streams = JSON.parse(probe.stdout).streams;
      const video = streams.find(
        (/** @type {{ codec_type: string }} */ s) => s.codec_type === "video",
      );
      const audio = streams.find(
        (/** @type {{ codec_type: string }} */ s) => s.codec_type === "audio",
      );
      assert.ok(Math.abs(Number(video.nb_read_packets) - t.frames) <= 1);
      assert.equal(audio.codec_name, "aac");
      assert.equal(audio.sample_rate, "48000");
      assert.ok(Math.abs((await loudness(t.ffmpeg, file)) + 14) <= 0.5);

      assert.deepEqual(fs.readdirSync(path.join(t.dataDir, "cache", "render")), []);
      assert.ok(t.lines.some((l) => l.startsWith("Levelling the sound")));
    },
  );

  it(
    "stop ends the renderer and its browsers and deletes the work folder",
    { timeout: 180_000 },
    async () => {
      const t = await setup();
      const run = t.runner.run({ id: "real2" }, t.facts);
      await waitFor(
        () => t.lines.some((l) => l.startsWith("Capturing frames")),
        "the capture",
        120_000,
      );
      /** @type {number[]} */
      let seen = [];
      const rootPid = await (async () => {
        const found = await runHelper({
          command: "pgrep",
          args: ["-f", path.join(t.dataDir, "cache", "render", "real2")],
          timeoutMs: 5000,
        }).catch(() => null);
        return (
          found?.stdout
            .split("\n")
            .map(Number)
            .find((n) => n > 0) ?? 0
        );
      })();
      if (rootPid > 0) seen = await listTree(rootPid).catch(() => []);
      run.stop();
      const outcome = await run.done;
      assert.equal(outcome.state, "stopped");
      for (const pid of seen) assert.equal(alive(pid), false, `process ${pid} is still running`);
      assert.equal(fs.existsSync(path.join(t.dataDir, "cache", "render", "real2")), false);
      assert.deepEqual(fs.readdirSync(path.join(t.videoDir, "output")), ["Real Video.hf"]);
    },
  );
});

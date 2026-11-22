import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { renderWorkers } from "../../src/limits/budget.js";
import { renderArgs, renderEnv, resolutionPreset, workFolders } from "../../src/render/args.js";

const base = {
  projectDir: "/v/output/V.hf",
  outFile: "/c/render/j/out/render.mp4",
  fps: "30",
  workers: 1,
  resolution: /** @type {const} */ (1080),
  portrait: false,
  gpu: false,
};

describe("renderArgs", () => {
  it("builds the SPEC command at 1080 without the GPU", () => {
    assert.deepEqual(renderArgs(base), [
      "render",
      "/v/output/V.hf",
      "-o",
      "/c/render/j/out/render.mp4",
      "--fps",
      "30",
      "--workers",
      "1",
      "--video-bitrate",
      "12M",
    ]);
  });

  for (const fps of ["30", "25", "30000/1001"]) {
    it(`passes the frame rate ${fps} as it is`, () => {
      const args = renderArgs({ ...base, fps });
      assert.equal(args[args.indexOf("--fps") + 1], fps);
    });
  }

  for (const [budget, workers] of /** @type {const} */ ([
    [1, 1],
    [3, 1],
    [4, 4],
    [8, 8],
    [12, 8],
  ])) {
    for (const gpu of [false, true]) {
      it(`budget ${budget} gives ${workers} workers (${gpu ? "with" : "without"} GPU)`, () => {
        const args = renderArgs({ ...base, workers: renderWorkers(budget), gpu });
        assert.equal(args[args.indexOf("--workers") + 1], String(workers));
        assert.equal(args.includes("--gpu"), gpu);
      });
    }
  }

  it("asks for the 4K preset of the project's shape at 2160 with 40M", () => {
    const wide = renderArgs({ ...base, resolution: 2160 });
    assert.deepEqual(wide.slice(-4), ["--video-bitrate", "40M", "--resolution", "landscape-4k"]);
    const tall = renderArgs({ ...base, resolution: 2160, portrait: true, gpu: true });
    assert.deepEqual(tall.slice(-5), [
      "--video-bitrate",
      "40M",
      "--resolution",
      "portrait-4k",
      "--gpu",
    ]);
    assert.equal(resolutionPreset(true), "portrait-4k");
  });

  it("never uses --start or --end, and never fewer than one worker", () => {
    const args = renderArgs({ ...base, workers: 0 });
    assert.ok(!args.includes("--start") && !args.includes("--end"));
    assert.equal(args[args.indexOf("--workers") + 1], "1");
  });
});

describe("renderEnv", () => {
  it("sets the SPEC environment inside the job's folder", () => {
    const work = path.join("/c", "render", "j");
    const env = renderEnv({
      base: { PATH: "/bin", KEEP: "1" },
      limits: { OMP_NUM_THREADS: "2" },
      workDir: work,
      browserPath: "/b/chrome",
      ffmpeg: "/f/ffmpeg",
      ffprobe: "/f/ffprobe",
    });
    assert.equal(env.PATH, "/bin");
    assert.equal(env.KEEP, "1");
    assert.equal(env.OMP_NUM_THREADS, "2");
    assert.equal(env.HYPERFRAMES_NO_TELEMETRY, "1");
    assert.equal(env.HYPERFRAMES_NO_UPDATE_CHECK, "1");
    assert.equal(env.HYPERFRAMES_RENDER_LOCK, "off");
    assert.equal(env.HYPERFRAMES_BROWSER_PATH, "/b/chrome");
    assert.equal(env.HYPERFRAMES_EXTRACT_CACHE_DIR, workFolders(work).extract);
    for (const name of ["TMPDIR", "TEMP", "TMP"]) assert.equal(env[name], workFolders(work).tmp);
    assert.equal(env.HYPERFRAMES_FFMPEG_PATH, "/f/ffmpeg");
    assert.equal(env.HYPERFRAMES_FFPROBE_PATH, "/f/ffprobe");
  });

  it("leaves the browser and tools out when they are unknown", () => {
    const env = renderEnv({ base: {}, limits: {}, workDir: "/w", browserPath: null });
    assert.equal("HYPERFRAMES_BROWSER_PATH" in env, false);
    assert.equal("HYPERFRAMES_FFMPEG_PATH" in env, false);
    assert.equal("HYPERFRAMES_FFPROBE_PATH" in env, false);
  });
});

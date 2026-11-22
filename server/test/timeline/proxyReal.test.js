// Preview copies with the real ffmpeg and ffprobe (skipped when they are not installed).
// Three tiny sources: a camera-like HEVC MOV, H.264 with a 10 second key frame distance, and a
// light H.264/AAC MP4. The first two get copies, the third does not.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runHelper } from "../../src/platform/process.js";
import { findFfmpeg, findFfprobe } from "../../src/platform/tools.js";
import { createPreviewCopies } from "../../src/timeline/proxy.js";
import { heavyReasons, probeFile } from "../../src/timeline/proxyProbe.js";
import { fakeLimits, makeWorld } from "./proxySupport.js";

const ffmpeg = findFfmpeg();
const ffprobe = findFfprobe();
const missing = ffmpeg === null || ffprobe === null;
const log = { info() {}, warn() {}, error() {}, debug() {} };

/** @param {string[]} args */
function run(args) {
  const result = spawnSync(/** @type {string} */ (ffmpeg), ["-v", "error", "-y", ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

/** @param {string} file */
const probe = (file) =>
  probeFile({ command: /** @type {string} */ (ffprobe), file, helper: runHelper });

const hasX265 = () =>
  spawnSync(/** @type {string} */ (ffmpeg), ["-hide_banner", "-encoders"], {
    encoding: "utf8",
  }).stdout.includes("libx265");

test(
  "real ffmpeg: heavy files get a light copy of the same length and pictures",
  { skip: missing },
  async () => {
    const world = makeWorld();
    try {
      const sources = path.join(world.video, "src");
      fs.mkdirSync(sources);
      const sound = ["-f", "lavfi", "-i", "sine=f=440:d=3", "-shortest"];
      const picture = (/** @type {number} */ rate) => [
        "-f",
        "lavfi",
        "-i",
        `testsrc2=s=320x180:r=${rate}:d=3`,
      ];
      const hevc = path.join(sources, "camera.mov");
      run([
        ...picture(30),
        ...sound,
        ...(hasX265()
          ? ["-c:v", "libx265", "-tag:v", "hvc1", "-x265-params", "log-level=error"]
          : ["-c:v", "mpeg4"]),
        "-c:a",
        "aac",
        hevc,
      ]);
      const longGop = path.join(sources, "long-gop.mp4");
      run([
        ...picture(25),
        ...sound,
        ...["-c:v", "libx264", "-g", "250", "-keyint_min", "250", "-sc_threshold", "0"],
        ...["-pix_fmt", "yuv420p", "-c:a", "aac", longGop],
      ]);
      const light = path.join(sources, "light.mp4");
      run([
        ...picture(30),
        ...sound,
        ...["-c:v", "libx264", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", light],
      ]);
      for (const file of [hevc, longGop, light]) {
        fs.symlinkSync(file, path.join(world.projectDir, "assets", "media", path.basename(file)));
      }
      const limits = fakeLimits();
      const copies = createPreviewCopies({
        dataDir: world.dataDir,
        limits: limits.api,
        registry: { add: async () => {}, remove: async () => {} },
        events: { emit() {} },
        clock: { now: () => Date.now() },
        log,
        encoders: { h264: async () => null, toneMapping: async () => false },
      });
      const state = await copies.ensureFor("k1", world.projectDir, {
        ...world.scope,
        videoDir: sources,
      });
      assert.deepEqual(state, { total: 2, done: 0, running: true });
      await copies.idle();
      assert.deepEqual(copies.state("k1"), { total: 2, done: 2, running: false });
      assert.equal(copies.proxyFor(fs.realpathSync(light)), null, "the light file has no copy");

      for (const original of [hevc, longGop]) {
        const copy = copies.proxyFor(fs.realpathSync(original));
        assert.ok(copy, `${original} has a copy`);
        const before = await probe(original);
        const after = await probe(copy);
        assert.ok(before && after);
        assert.equal(after.videoCodec, "h264");
        assert.equal(after.pixFmt, "yuv420p");
        assert.equal(after.fps, before.fps, "the same frame rate");
        assert.ok(
          (after.keyframeGap ?? 99) <= 1.05,
          `key frames every second: ${after.keyframeGap}`,
        );
        assert.deepEqual(after.audioCodecs, ["aac"]);
        assert.ok(after.width <= 1280 && after.width % 2 === 0 && after.height % 2 === 0);
        const [fn = 30, fd = 1] = before.fps.split("/").map(Number);
        assert.ok(
          Math.abs((after.duration ?? 0) - (before.duration ?? 0)) <= fd / fn + 0.02,
          `duration ${after.duration} against ${before.duration}`,
        );
        assert.deepEqual(heavyReasons(after), [], "a copy is not heavy itself");
        assert.ok(fs.existsSync(copy));
        // The same time shows the same picture: compare a frame at one second.
        const a = path.join(world.root, "a.png");
        const b = path.join(world.root, "b.png");
        run(["-ss", "1", "-i", original, "-frames:v", "1", "-vf", "format=yuv420p", a]);
        run(["-ss", "1", "-i", copy, "-frames:v", "1", "-vf", "format=yuv420p", b]);
        const psnr = spawnSync(
          /** @type {string} */ (ffmpeg),
          ["-hide_banner", "-i", a, "-i", b, "-lavfi", "psnr", "-f", "null", "-"],
          { encoding: "utf8" },
        ).stderr;
        const value = Number(/average:([0-9.]+)/.exec(psnr)?.[1]);
        assert.ok(value > 30, `the picture at 1 s matches (PSNR ${value})`);
      }
      await copies.stop();
    } finally {
      world.cleanup();
    }
  },
);

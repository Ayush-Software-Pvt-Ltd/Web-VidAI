import { test } from "node:test";
import assert from "node:assert/strict";
import { createHardwareProbe, hardwareView, parseHardwareLines } from "../../src/toolkit/hardware.js";
import { toolkitPaths } from "../../src/toolkit/paths.js";

const RTX = "NVIDIA GeForce RTX 5060 Ti";
const gpuAnswer = {
  speech: { backend: "faster", device: "gpu", summary: `GPU (CUDA) (${RTX})`, problem: null },
  video: { encoder: "h264_nvenc", hevc: "hevc_nvenc", decoder: "cuda", hardware: true, failed: [] },
};

test("the last JSON line of ve.py hardware is the answer", () => {
  assert.deepEqual(parseHardwareLines(["warning: x", '{"a":1}', "", "trailing"]), { a: 1 });
  assert.equal(parseHardwareLines(["nothing", "{broken"]), null);
});

test("an NVIDIA machine that uses CUDA and NVENC shows GPU lines and no problem", () => {
  const view = hardwareView(gpuAnswer, RTX);
  assert.equal(view.nvidia, RTX);
  assert.deepEqual(view.speech, { using: "gpu", summary: `GPU (CUDA) (${RTX})`, problem: null });
  assert.deepEqual(view.video, {
    using: "gpu",
    summary: "h264_nvenc and hevc_nvenc, decoding with cuda",
    problem: null,
  });
});

test("an NVIDIA GPU that CUDA cannot use is a problem with its fix", () => {
  const view = hardwareView(
    {
      ...gpuAnswer,
      speech: {
        device: "gpu",
        summary: `GPU (CUDA) (${RTX}), not usable yet`,
        problem: "these CUDA libraries were not found: cublas64_12.dll. Press Prepare to install what is missing.",
      },
    },
    RTX,
  );
  assert.equal(view.speech.using, "gpu");
  assert.match(view.speech.problem ?? "", /cublas64_12\.dll.*Prepare/);
});

test("software video on an NVIDIA machine names why NVENC did not start", () => {
  const answer = {
    ...gpuAnswer,
    video: {
      encoder: "libx264",
      hevc: "libx265",
      decoder: "software",
      hardware: false,
      failed: [{ encoder: "h264_nvenc", error: "Driver does not support the required nvenc API version." }],
    },
  };
  const view = hardwareView(answer, RTX);
  assert.equal(view.video.using, "cpu");
  assert.equal(view.video.summary, "libx264 and libx265 (software), decoding in software");
  assert.match(view.video.problem ?? "", /could not start h264_nvenc: Driver does not support/);
  const noNvenc = hardwareView({ ...answer, video: { ...answer.video, failed: [] } }, RTX);
  assert.match(noNvenc.video.problem ?? "", /no NVENC encoder/);
  assert.equal(hardwareView(answer, null).video.problem, null);
});

test("an unreadable answer is 'not checked yet'", () => {
  assert.equal(hardwareView(null, null).speech.using, "unknown");
});

test("the probe runs ve.py hardware once per Prepare and per 30 seconds", async () => {
  const paths = toolkitPaths("/data", "darwin");
  let now = 0;
  let generation = "a";
  let runs = 0;
  const probe = createHardwareProbe({
    paths,
    clock: { now: () => now },
    exists: () => true,
    nvidia: () => RTX,
    generation: () => generation,
    env: () => ({ VE_FFMPEG: "/f" }),
    runner: async (request) => {
      runs += 1;
      assert.deepEqual(request.args, [paths.driver, "hardware"]);
      assert.equal(request.env?.VE_FFMPEG, "/f");
      return { started: true, code: 0, timedOut: false, aborted: false, tail: [JSON.stringify(gpuAnswer)], error: null };
    },
  });
  const first = await probe();
  assert.equal(first.speech.using, "gpu");
  await probe();
  assert.equal(runs, 1);
  now = 31_000;
  await probe();
  assert.equal(runs, 2);
  generation = "b";
  await probe();
  assert.equal(runs, 3);
});

test("a toolkit that is not installed or fails gives 'not checked yet' with the GPU name", async () => {
  const paths = toolkitPaths("/data", "darwin");
  const base = {
    paths,
    clock: { now: () => 0 },
    nvidia: () => RTX,
    generation: () => "a",
    env: () => ({}),
  };
  const missing = await createHardwareProbe({
    ...base,
    exists: () => false,
    runner: async () => {
      throw new Error("must not run");
    },
  })();
  assert.equal(missing.speech.using, "unknown");
  assert.equal(missing.nvidia, RTX);
  const failing = await createHardwareProbe({
    ...base,
    exists: () => true,
    runner: async () => ({ started: true, code: 1, timedOut: false, aborted: false, tail: ["Traceback"], error: null }),
  })();
  assert.equal(failing.video.using, "unknown");
});

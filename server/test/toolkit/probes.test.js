import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolProbes, parseFfVersion, parseHardware } from "../../src/toolkit/probes.js";
import { toolkitPaths } from "../../src/toolkit/paths.js";

const paths = toolkitPaths("/data", "darwin");

test("ffmpeg's version and hardware encoders are read from its own output", () => {
  assert.equal(parseFfVersion("ffmpeg version 7.1.1 Copyright (c) 2000-2025\nbuilt with"), "7.1.1");
  assert.equal(parseFfVersion("ffmpeg version n6.0-12-g1 Copyright"), "n6.0-12-g1");
  assert.equal(parseFfVersion("nothing"), null);
  assert.deepEqual(
    parseHardware(" V....D h264_videotoolbox  VideoToolbox\n V....D hevc_nvenc NVENC\n V..... libx264 x\n"),
    ["videotoolbox", "nvenc"],
  );
  assert.deepEqual(parseHardware(" V..... libx264 x\n"), []);
});

/** @param {Record<string, string | null>} answers by "command args" */
const outputs = (answers) => async (/** @type {string} */ command, /** @type {readonly string[]} */ args) =>
  answers[`${command} ${args.join(" ")}`] ?? null;

test("the ffmpeg, ffprobe and Python probes", async () => {
  const probes = createToolProbes({
    paths,
    platform: "darwin",
    exists: () => false,
    findFfmpeg: () => "/b/ffmpeg",
    findFfprobe: () => null,
    pythonCandidates: () => [
      { command: "/p/python3.9", args: [], label: "/p/python3.9" },
      { command: "/p/python3.12", args: [], label: "/p/python3.12" },
    ],
    output: outputs({
      "/b/ffmpeg -version": "ffmpeg version 7.1 Copyright",
      "/b/ffmpeg -hide_banner -encoders": " V....D h264_videotoolbox x\n",
      "/p/python3.9 -c import sys; print('%d.%d.%d' % sys.version_info[:3])": "3.9.6\n",
      "/p/python3.12 -c import sys; print('%d.%d.%d' % sys.version_info[:3])": "3.12.4\n",
    }),
  });
  assert.deepEqual(await probes.ffmpeg(), {
    found: true,
    path: "/b/ffmpeg",
    version: "7.1",
    note: "Hardware encoders found: videotoolbox.",
  });
  const missing = await probes.ffprobe();
  assert.equal(missing.found, false);
  assert.match(missing.note ?? "", /ffprobe was not found/);
  assert.deepEqual(await probes.python(), {
    found: true,
    path: "/p/python3.12",
    version: "3.12.4",
    note: null,
  });
});

test("the Python probe prefers the toolkit's own environment and says what to install when none works", async () => {
  const inEnv = createToolProbes({
    paths,
    platform: "darwin",
    exists: (file) => file === paths.python,
    pythonCandidates: () => [],
    output: outputs({
      [`${paths.python} -c import sys; print('%d.%d.%d' % sys.version_info[:3])`]: "3.11.9",
    }),
  });
  const found = await inEnv.python();
  assert.equal(found.path, paths.python);
  assert.equal(found.note, "The toolkit's environment.");

  const none = createToolProbes({
    paths,
    platform: "darwin",
    exists: () => false,
    pythonCandidates: () => [],
    output: outputs({}),
  });
  const result = await none.python();
  assert.equal(result.found, false);
  assert.match(result.note ?? "", /brew install python@3\.12/);
});

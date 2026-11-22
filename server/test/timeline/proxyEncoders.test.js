// Which H.264 encoder to use (docs/SPEC.md section 11, Preview copies; the toolkit's choice).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyForced,
  candidateBackends,
  createEncoders,
  hardwareChoice,
  parseEncoderNames,
  parseFilterNames,
  probeArgs,
} from "../../src/platform/encoders.js";

const ENCODERS_TEXT = `Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 A....D aac                  AAC (Advanced Audio Coding)
`;

const FILTERS_TEXT = `Filters:
  T.. = Timeline support
 ... scale             V->V       Scale the input video size.
 TSC zscale            V->V       Apply resizing, colorspace and bit depth conversion.
 .S. tonemap           V->V       Conversion to/from different dynamic ranges.
`;

test("encoder names are read from ffmpeg's list", () => {
  const names = parseEncoderNames(ENCODERS_TEXT);
  assert.ok(names.has("libx264"));
  assert.ok(names.has("h264_videotoolbox"));
  assert.ok(names.has("aac"));
  assert.ok(!names.has("Video"));
  assert.ok(!names.has("="));
});

test("filter names are read from ffmpeg's list", () => {
  const names = parseFilterNames(FILTERS_TEXT);
  assert.deepEqual([...names].sort(), ["scale", "tonemap", "zscale"]);
});

test("the order of backends: a Mac has VideoToolbox, Windows tries NVENC, QSV, AMF", () => {
  assert.deepEqual(candidateBackends("darwin"), ["videotoolbox"]);
  assert.deepEqual(candidateBackends("win32"), ["nvenc", "qsv", "amf"]);
  assert.deepEqual(candidateBackends("linux"), ["nvenc", "qsv"]);
});

test("VE_HW narrows or switches hardware off, as in the toolkit", () => {
  const win = candidateBackends("win32");
  assert.deepEqual(applyForced(win, undefined), win);
  assert.deepEqual(applyForced(win, ""), win);
  assert.deepEqual(applyForced(win, "none"), []);
  assert.deepEqual(applyForced(win, "Software"), []);
  assert.deepEqual(applyForced(win, "off"), []);
  assert.deepEqual(applyForced(win, "qsv"), ["qsv"]);
  assert.deepEqual(applyForced(win, "videotoolbox"), win);
  assert.deepEqual(applyForced(win, "auto"), win);
});

test("each hardware encoder's name and pixel format", () => {
  assert.deepEqual(hardwareChoice("videotoolbox"), {
    backend: "videotoolbox",
    name: "h264_videotoolbox",
    pixFmt: "nv12",
  });
  assert.equal(hardwareChoice("nvenc").pixFmt, "yuv420p");
  assert.equal(hardwareChoice("qsv").pixFmt, "nv12");
  assert.equal(hardwareChoice("amf").name, "h264_amf");
});

test("the test encode is two frames to the null muxer in the encoder's format", () => {
  const args = probeArgs(hardwareChoice("qsv"));
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_qsv");
  assert.equal(args[args.indexOf("-pix_fmt") + 1], "nv12");
  assert.equal(args[args.indexOf("-frames:v") + 1], "2");
  assert.deepEqual(args.slice(-3), ["-f", "null", "-"]);
});

/**
 * @param {{ platform: string, listed: string, works: string[], forced?: string, filters?: string, program?: string | null }} options
 */
function encodersFor({
  platform,
  listed,
  works,
  forced,
  filters = FILTERS_TEXT,
  program = "ffmpeg",
}) {
  /** @type {string[][]} */
  const calls = [];
  const encoders = createEncoders({
    ffmpeg: () => program,
    platform,
    ...(forced === undefined ? {} : { forced }),
    helper: async ({ args }) => {
      calls.push([...args]);
      if (args.includes("-encoders")) return { code: 0, stdout: listed };
      if (args.includes("-filters")) return { code: 0, stdout: filters };
      const name = args[args.indexOf("-c:v") + 1] ?? "";
      return { code: works.includes(name) ? 0 : 1, stdout: "" };
    },
  });
  return { encoders, calls };
}

test("a Mac with VideoToolbox gets it, probed once and kept", async () => {
  const { encoders, calls } = encodersFor({
    platform: "darwin",
    listed: ENCODERS_TEXT,
    works: ["h264_videotoolbox"],
  });
  assert.equal((await encoders.h264())?.backend, "videotoolbox");
  assert.equal((await encoders.h264())?.name, "h264_videotoolbox");
  assert.equal(calls.length, 2, "one list and one test encode, not repeated");
});

test("a listed encoder that does not start here is not used (no such GPU)", async () => {
  const { encoders } = encodersFor({ platform: "win32", listed: ENCODERS_TEXT, works: [] });
  assert.equal(await encoders.h264(), null);
});

test("Windows takes the first backend that works, in order", async () => {
  const listed = `${ENCODERS_TEXT} V....D h264_qsv   Intel Quick Sync (codec h264)\n V....D h264_amf  AMD (codec h264)\n`;
  const { encoders } = encodersFor({
    platform: "win32",
    listed,
    works: ["h264_qsv", "h264_amf"],
  });
  assert.equal((await encoders.h264())?.backend, "qsv");
});

test("an encoder ffmpeg does not list is not even tried", async () => {
  const { encoders, calls } = encodersFor({
    platform: "darwin",
    listed: " V....D libx264  x\n",
    works: ["h264_videotoolbox"],
  });
  assert.equal(await encoders.h264(), null);
  assert.equal(calls.length, 1);
});

test("VE_HW=none means software without asking ffmpeg anything", async () => {
  const { encoders, calls } = encodersFor({
    platform: "darwin",
    listed: ENCODERS_TEXT,
    works: ["h264_videotoolbox"],
    forced: "none",
  });
  assert.equal(await encoders.h264(), null);
  assert.equal(calls.length, 0);
});

test("without ffmpeg there is no hardware and no tone mapping", async () => {
  const { encoders } = encodersFor({
    platform: "darwin",
    listed: ENCODERS_TEXT,
    works: ["h264_videotoolbox"],
    program: null,
  });
  assert.equal(await encoders.h264(), null);
  assert.equal(await encoders.toneMapping(), false);
});

test("a program that cannot be started counts as no hardware", async () => {
  const encoders = createEncoders({
    ffmpeg: () => "ffmpeg",
    platform: "darwin",
    helper: async () => {
      throw new Error("spawn ENOENT");
    },
  });
  assert.equal(await encoders.h264(), null);
});

test("tone mapping needs both zscale and tonemap", async () => {
  const yes = encodersFor({ platform: "darwin", listed: "", works: [] });
  assert.equal(await yes.encoders.toneMapping(), true);
  const no = encodersFor({
    platform: "darwin",
    listed: "",
    works: [],
    filters: " .S. tonemap  V->V  x\n",
  });
  assert.equal(await no.encoders.toneMapping(), false);
});

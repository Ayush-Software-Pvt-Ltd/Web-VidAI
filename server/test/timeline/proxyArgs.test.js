// The names and ffmpeg arguments of preview copies (docs/SPEC.md section 11, Preview copies).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SOFTWARE_ENCODER, hardwareChoice } from "../../src/platform/encoders.js";
import { copyArgs, copySize, gopFrames, videoFilter } from "../../src/timeline/proxyArgs.js";
import { nameOfCopy, nameOfFacts, proxyName } from "../../src/timeline/proxyName.js";
import { parseProbe } from "../../src/timeline/proxyProbe.js";
import { probeJson } from "./proxySupport.js";

/** @param {Record<string, any>} over */
const factsOf = (over) => {
  const facts = parseProbe(probeJson(over));
  assert.ok(facts);
  return facts;
};

test("a name is 64 hex characters and depends on path, size and time", () => {
  const name = proxyName("/a/b.mov", 10, 1000.5);
  assert.match(name, /^[0-9a-f]{64}$/);
  assert.equal(name, proxyName("/a/b.mov", 10, 1000.5));
  assert.notEqual(name, proxyName("/a/c.mov", 10, 1000.5));
  assert.notEqual(name, proxyName("/a/b.mov", 11, 1000.5));
  assert.notEqual(name, proxyName("/a/b.mov", 10, 1001.5));
  // The separator keeps "ab" + "c" apart from "a" + "bc".
  assert.notEqual(proxyName("/a", 12, 3), proxyName("/a1", 2, 3));
});

test("copy and facts files are told apart from everything else", () => {
  const name = proxyName("/x", 1, 1);
  assert.equal(nameOfCopy(`${name}.mp4`), name);
  assert.equal(nameOfCopy(`${name}.part`), null);
  assert.equal(nameOfCopy("notes.mp4"), null);
  assert.equal(nameOfFacts(`${name}.json`), name);
  assert.equal(nameOfFacts(`${name}.json.part`), null);
});

for (const [
  w,
  h,
  sar,
  rotation,
  expected,
] of /** @type {[number, number, number, number, [number, number]][]} */ ([
  [3840, 2160, 1, 0, [1280, 720]],
  [2160, 3840, 1, 0, [720, 1280]],
  [1920, 1080, 1, 0, [1280, 720]],
  [1280, 720, 1, 0, [1280, 720]],
  [640, 360, 1, 0, [640, 360]],
  // Never upscaled, and sizes are even.
  [641, 361, 1, 0, [642, 362]],
  [1281, 721, 1, 0, [1280, 720]],
  // Odd results are made even: 1000 / 3 * 1280 / 1000 style cases.
  [1999, 1001, 1, 0, [1280, 640]],
  // Rotated files: the displayed size is the turned one.
  [3840, 2160, 1, 90, [720, 1280]],
  [3840, 2160, 1, -90, [720, 1280]],
  [3840, 2160, 1, 180, [1280, 720]],
  // A pixel shape of 4:3 widens the picture (1440x1080 anamorphic is 1920x1080).
  [1440, 1080, 4 / 3, 0, [1280, 720]],
  [720, 480, 32 / 27, 0, [854, 480]],
  // Tiny and extreme files stay valid.
  [2, 2, 1, 0, [2, 2]],
  [5000, 100, 1, 0, [1280, 26]],
])) {
  test(`size ${w}x${h} sar ${sar.toFixed(3)} rotation ${rotation}`, () => {
    const got = copySize({ width: w, height: h, sar, rotation });
    assert.deepEqual([got.width, got.height], expected);
    assert.equal(got.width % 2, 0);
    assert.equal(got.height % 2, 0);
    assert.ok(Math.max(got.width, got.height) <= 1280 || Math.max(w, h) < 1280);
  });
}

test("one key frame per second whatever the frame rate", () => {
  assert.equal(gopFrames("30/1"), 30);
  assert.equal(gopFrames("30000/1001"), 30);
  assert.equal(gopFrames("25/1"), 25);
  assert.equal(gopFrames("60000/1001"), 60);
  assert.equal(gopFrames("24000/1001"), 24);
  assert.equal(gopFrames("0/0"), 30);
});

test("the picture filter: constant rate, the size, square pixels, the encoder's format", () => {
  const filter = videoFilter(factsOf({ w: 3840, h: 2160, fps: "30000/1001" }), {
    pixFmt: "nv12",
    toneMapping: false,
  });
  assert.equal(filter, "fps=30000/1001,scale=1280:720:flags=bicubic,setsar=1,format=nv12");
});

test("interlaced pictures are deinterlaced first", () => {
  const filter = videoFilter(factsOf({ field: "tb" }), { pixFmt: "yuv420p", toneMapping: false });
  assert.ok(filter.startsWith("yadif=deint=interlaced,fps=30/1,"));
});

test("HDR is tone-mapped to SDR with zscale and tonemap when ffmpeg has them", () => {
  const filter = videoFilter(
    factsOf({ transfer: "smpte2084", vcodec: "hevc", pix: "yuv420p10le" }),
    {
      pixFmt: "yuv420p",
      toneMapping: true,
    },
  );
  for (const part of [
    "zscale=t=linear:npl=100",
    "format=gbrpf32le",
    "zscale=p=bt709",
    "tonemap=tonemap=hable:desat=0",
    "zscale=t=bt709:m=bt709:r=tv",
  ]) {
    assert.ok(filter.includes(part), part);
  }
  assert.ok(filter.indexOf("scale=") < filter.indexOf("zscale=t=linear"), "scaled first");
  assert.ok(filter.endsWith("setsar=1,format=yuv420p"));
});

test("HDR without zscale is converted to BT.709 only", () => {
  const filter = videoFilter(factsOf({ transfer: "arib-std-b67", vcodec: "hevc" }), {
    pixFmt: "yuv420p",
    toneMapping: false,
  });
  assert.ok(filter.includes("in_color_matrix=bt2020:out_color_matrix=bt709"));
  assert.ok(!filter.includes("zscale"));
});

test("standard-definition colors are converted to BT.709", () => {
  const filter = videoFilter(factsOf({ space: "smpte170m" }), {
    pixFmt: "yuv420p",
    toneMapping: false,
  });
  assert.ok(filter.includes("in_color_matrix=bt601:out_color_matrix=bt709"));
  const plain = videoFilter(factsOf({ space: "bt709" }), { pixFmt: "yuv420p", toneMapping: false });
  assert.ok(!plain.includes("color_matrix"));
});

/**
 * @param {Record<string, any>} over
 * @param {import("../../src/platform/encoders.js").EncoderChoice} encoder
 */
const argsFor = (over, encoder) =>
  copyArgs({
    input: "/in/clip.mov",
    output: "/out/x.part",
    facts: factsOf(over),
    encoder,
    threads: 3,
    toneMapping: false,
  });

/** @param {string[]} args @param {string} flag */
const after = (args, flag) => args[args.indexOf(flag) + 1];

test("software arguments: libx264 veryfast, key frames, AAC, fast start, explicit format", () => {
  const args = argsFor({ vcodec: "hevc", w: 3840, h: 2160, fps: "25/1" }, SOFTWARE_ENCODER);
  assert.equal(after(args, "-i"), "/in/clip.mov");
  assert.equal(args.at(-1), "/out/x.part");
  assert.equal(after(args, "-f"), "mp4");
  assert.equal(after(args, "-c:v"), "libx264");
  assert.equal(after(args, "-preset"), "veryfast");
  assert.equal(after(args, "-pix_fmt"), "yuv420p");
  assert.equal(after(args, "-profile:v"), "high");
  assert.equal(after(args, "-g"), "25");
  assert.equal(after(args, "-sc_threshold"), "0");
  assert.equal(after(args, "-threads"), "3");
  assert.equal(after(args, "-fps_mode"), "cfr");
  assert.equal(after(args, "-force_key_frames"), "expr:gte(t,n_forced*1)");
  assert.equal(after(args, "-c:a"), "aac");
  assert.equal(after(args, "-b:a"), "160k");
  assert.equal(after(args, "-ac"), "2");
  assert.equal(after(args, "-ar"), "48000");
  assert.equal(after(args, "-movflags"), "+faststart");
  assert.equal(after(args, "-vf"), "fps=25/1,scale=1280:720:flags=bicubic,setsar=1,format=yuv420p");
  assert.ok(!args.includes("-ss"), "no seeking: the copy starts where the original does");
});

test("the copy keeps only the picture and the first sound; no metadata, data or subtitles", () => {
  const args = argsFor({}, SOFTWARE_ENCODER);
  assert.deepEqual(
    args.filter((_, i) => args[i - 1] === "-map"),
    ["0:0", "0:1"],
  );
  for (const flag of ["-dn", "-sn"]) assert.ok(args.includes(flag));
  assert.equal(after(args, "-map_metadata"), "-1");
});

test("a file without sound gets no sound options", () => {
  const args = argsFor({ acodec: null }, SOFTWARE_ENCODER);
  assert.ok(!args.includes("-c:a"));
  assert.deepEqual(
    args.filter((_, i) => args[i - 1] === "-map"),
    ["0:0"],
  );
});

test("the VideoToolbox arguments (Mac)", () => {
  const args = argsFor({}, hardwareChoice("videotoolbox"));
  assert.equal(after(args, "-c:v"), "h264_videotoolbox");
  assert.equal(after(args, "-allow_sw"), "0");
  assert.equal(after(args, "-q:v"), "60");
  assert.equal(after(args, "-pix_fmt"), "nv12");
  assert.ok(after(args, "-vf")?.endsWith("format=nv12"));
  assert.ok(!args.includes("-preset"));
});

test("the NVENC arguments (Windows)", () => {
  const args = argsFor({}, hardwareChoice("nvenc"));
  assert.equal(after(args, "-c:v"), "h264_nvenc");
  assert.equal(after(args, "-rc"), "vbr");
  assert.equal(after(args, "-cq"), "24");
  assert.equal(after(args, "-b:v"), "0");
  assert.equal(after(args, "-no-scenecut"), "1");
  assert.equal(after(args, "-pix_fmt"), "yuv420p");
});

test("the Quick Sync arguments (Windows)", () => {
  const args = argsFor({}, hardwareChoice("qsv"));
  assert.equal(after(args, "-c:v"), "h264_qsv");
  assert.equal(after(args, "-global_quality"), "24");
  assert.equal(after(args, "-pix_fmt"), "nv12");
});

test("the AMF arguments (Windows)", () => {
  const args = argsFor({}, hardwareChoice("amf"));
  assert.equal(after(args, "-c:v"), "h264_amf");
  assert.equal(after(args, "-rc"), "cqp");
  assert.equal(after(args, "-qp_i"), "24");
  assert.equal(after(args, "-pix_fmt"), "yuv420p");
});

test("every encoder gets a key frame distance of one second and the same -g", () => {
  for (const encoder of [
    SOFTWARE_ENCODER,
    hardwareChoice("videotoolbox"),
    hardwareChoice("nvenc"),
    hardwareChoice("qsv"),
    hardwareChoice("amf"),
  ]) {
    assert.equal(after(argsFor({ fps: "24000/1001" }, encoder), "-g"), "24", encoder.name);
  }
});

test("HDR and standard-definition copies are tagged BT.709", () => {
  const hdr = argsFor({ transfer: "smpte2084", vcodec: "hevc" }, SOFTWARE_ENCODER);
  assert.equal(after(hdr, "-colorspace"), "bt709");
  assert.equal(after(hdr, "-color_trc"), "bt709");
  assert.ok(!argsFor({}, SOFTWARE_ENCODER).includes("-colorspace"));
});

test("the thread count is at least one and a whole number", () => {
  const facts = factsOf({});
  const args = copyArgs({
    input: "/i",
    output: "/o",
    facts,
    encoder: SOFTWARE_ENCODER,
    threads: 0.4,
    toneMapping: false,
  });
  assert.equal(after(args, "-threads"), "1");
  assert.equal(after(args, "-filter_threads"), "1");
});

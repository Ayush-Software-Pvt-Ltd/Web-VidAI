// The heavy rule and the reading of ffprobe (docs/SPEC.md section 11, Preview copies).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  heavyReasons,
  isNotVideoName,
  keyframeGapOf,
  parseProbe,
  probeArgs,
  probeFile,
} from "../../src/timeline/proxyProbe.js";
import { fakeProbe, probeJson } from "./proxySupport.js";

/** @param {Record<string, any>} over */
const reasonsOf = (over) => {
  const facts = parseProbe(probeJson(over));
  assert.ok(facts, "a video");
  return heavyReasons(facts);
};

test("a light H.264 AAC MP4 is not heavy", () => {
  assert.deepEqual(reasonsOf({}), []);
});

for (const [title, over, reason] of /** @type {[string, Record<string, any>, string][]} */ ([
  ["HEVC", { vcodec: "hevc" }, "codec"],
  ["ProRes", { vcodec: "prores", pix: "yuv422p10le" }, "codec"],
  ["Matroska", { container: "matroska,webm" }, "container"],
  ["AVI", { container: "avi" }, "container"],
  ["10-bit H.264", { pix: "yuv420p10le" }, "pixel format"],
  ["4:2:2 H.264", { pix: "yuv422p" }, "pixel format"],
  ["4:4:4 H.264", { pix: "yuv444p" }, "pixel format"],
  ["MP3 sound", { acodec: "mp3" }, "audio codec"],
  ["PCM sound", { acodec: "pcm_s16le" }, "audio codec"],
  ["wider than 1920", { w: 3840, h: 2160 }, "size"],
  ["taller than 1920", { w: 1080, h: 2160 }, "size"],
  ["a key frame every 10 seconds", { keyGap: 10 }, "key frame distance"],
  ["a key frame every 2.5 seconds", { keyGap: 2.5 }, "key frame distance"],
  ["more than 12 Mbit/s", { bitrate: "12000001" }, "bit rate"],
  ["a rotated file", { rotation: -90 }, "rotation"],
  ["a rotated file (upside down)", { rotation: 180 }, "rotation"],
  ["HDR PQ", { transfer: "smpte2084" }, "hdr"],
  ["HDR HLG", { transfer: "arib-std-b67" }, "hdr"],
  ["interlaced", { field: "tt" }, "interlaced"],
])) {
  test(`heavy: ${title}`, () => {
    assert.ok(reasonsOf(over).includes(reason), `${title} -> ${reason}`);
  });
}

for (const [title, over] of /** @type {[string, Record<string, any>][]} */ ([
  ["exactly 1920 wide", { w: 1920, h: 1080 }],
  ["a portrait 1080 by 1920", { w: 1080, h: 1920 }],
  ["exactly 12 Mbit/s", { bitrate: "12000000" }],
  ["a key frame every 2 seconds", { keyGap: 2 }],
  ["no sound", { acodec: null }],
  ["a MOV (same family as MP4)", { container: "mov,mp4,m4a,3gp,3g2,mj2" }],
  ["full range 4:2:0 (yuvj420p)", { pix: "yuvj420p" }],
  ["rotation 0 spelled out", { rotation: 0 }],
  ["cover art next to the picture", { cover: true }],
  ["a pixel shape of exactly 1", { sar: "1:1" }],
])) {
  test(`not heavy: ${title}`, () => {
    assert.deepEqual(reasonsOf(over), []);
  });
}

test("a file with no bit rate at all is judged by the other rules", () => {
  assert.deepEqual(reasonsOf({ bitrate: null }), []);
});

test("one picture file or a sound-only file is never a video", () => {
  assert.equal(parseProbe({ streams: [], format: { format_name: "mp3" } }), null);
  const sound = probeJson({ acodec: "aac" });
  sound.streams.shift();
  assert.equal(parseProbe(sound), null);
  assert.equal(parseProbe(probeJson({ container: "image2", vcodec: "mjpeg" })), null);
  assert.equal(parseProbe(probeJson({ container: "png_pipe", vcodec: "png" })), null);
  assert.equal(parseProbe(probeJson({ container: "gif", vcodec: "gif" })), null);
  assert.equal(parseProbe({}), null);
  assert.equal(parseProbe(null), null);
});

test("cover art is not the picture that is copied", () => {
  const json = probeJson({ cover: true, vcodec: "hevc" });
  json.streams = [json.streams[2], json.streams[0], json.streams[1]].filter((s) => s !== undefined);
  const facts = parseProbe(json);
  assert.equal(facts?.videoIndex, 0);
  assert.equal(facts?.audioIndex, 1);
});

test("the facts: size, pixel shape, rotation, frame rate, sound", () => {
  const facts = parseProbe(
    probeJson({ w: 1440, h: 1080, sar: "4:3", fps: "30000/1001", rotation: 90, space: "bt709" }),
  );
  assert.ok(facts);
  assert.equal(facts.width, 1440);
  assert.ok(Math.abs(facts.sar - 4 / 3) < 1e-9);
  assert.equal(facts.rotation, 90);
  assert.equal(facts.fps, "30000/1001");
  assert.equal(facts.audioIndex, 1);
  assert.equal(facts.colorSpace, "bt709");
  assert.equal(facts.bitRate, 4_000_000);
});

test("an unusable frame rate falls back to the other one, then to 30", () => {
  const json = probeJson({ fps: "0/0" });
  /** @type {Record<string, any>} */ (json.streams[0])["r_frame_rate"] = "25/1";
  assert.equal(parseProbe(json)?.fps, "25/1");
  assert.equal(parseProbe(probeJson({ fps: "0/0" }))?.fps, "30/1");
});

test("the old rotate tag counts as a rotation", () => {
  const json = probeJson({});
  /** @type {Record<string, any>} */ (json.streams[0])["tags"] = { rotate: "270" };
  assert.equal(parseProbe(json)?.rotation, 270);
});

test("key frame distance: gaps, the tail, and sound never counts", () => {
  const at = (/** @type {number[]} */ keys, /** @type {number} */ last) => {
    const packets = [];
    for (let t = 0; t <= last + 1e-9; t += 0.5) {
      packets.push({
        stream_index: 0,
        pts_time: String(t),
        flags: keys.includes(t) ? "K__" : "___",
      });
      packets.push({ stream_index: 1, pts_time: String(t), flags: "K__" });
    }
    return packets;
  };
  assert.equal(keyframeGapOf(at([0, 1, 2, 3], 3.5), 0), 1);
  assert.equal(keyframeGapOf(at([0, 2.5], 3), 0), 2.5);
  // One key frame in a 3 second clip: the whole clip is the distance.
  assert.equal(keyframeGapOf(at([0], 3), 0), 3);
  // The tail after the last key frame counts.
  assert.equal(keyframeGapOf(at([0, 1], 9.5), 0), 8.5);
  assert.equal(keyframeGapOf([], 0), null);
  // No key flag at all in the window: the window itself.
  assert.equal(keyframeGapOf(at([], 3), 0), 10);
  // B-frames: decode order is not time order.
  assert.equal(
    keyframeGapOf(
      [
        { stream_index: 0, pts_time: "1.0", flags: "K__" },
        { stream_index: 0, pts_time: "0.0", flags: "K__" },
        { stream_index: 0, pts_time: "0.5", flags: "___" },
      ],
      0,
    ),
    1,
  );
});

test("a clip shorter than the limit is not made heavy by its own length", () => {
  assert.deepEqual(reasonsOf({ duration: "1.5", keyGap: 10 }), []);
});

test("file names of pictures and sound are skipped without a probe", () => {
  for (const name of ["a.JPG", "b.png", "c.wav", "d.m4a", "e.heic", "f.MP3"]) {
    assert.equal(isNotVideoName(name), true, name);
  }
  for (const name of ["a.mp4", "b.MOV", "c.mkv", "noextension", "d.mxf", "e.webm"]) {
    assert.equal(isNotVideoName(name), false, name);
  }
});

test("ffprobe is asked once, for the first 10 seconds only", () => {
  const args = probeArgs("/x/y.mov");
  assert.equal(args[args.indexOf("-read_intervals") + 1], "%+10");
  assert.equal(args.at(-1), "/x/y.mov");
  assert.ok(!args.includes("-count_frames"));
  assert.ok(!args.includes("-skip_frame"));
});

test("probeFile: reads the answer, tells a non-video from a failure", async () => {
  const helper = fakeProbe({ "/ok": probeJson({}), "/junk": () => "not json" });
  const facts = await probeFile({ command: "ffprobe", file: "/ok", helper });
  assert.equal(facts?.videoCodec, "h264");
  // ffprobe fails on a file it cannot read: it is not a video.
  assert.equal(await probeFile({ command: "ffprobe", file: "/missing", helper }), null);
  const timedOut = async () => ({ code: null, stdout: "", timedOut: true });
  await assert.rejects(probeFile({ command: "ffprobe", file: "/slow", helper: timedOut }));
  const garbage = async () => ({ code: 0, stdout: "garbage", timedOut: false });
  await assert.rejects(probeFile({ command: "ffprobe", file: "/g", helper: garbage }));
});

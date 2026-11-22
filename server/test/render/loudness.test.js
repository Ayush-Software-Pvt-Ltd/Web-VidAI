import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  levelArgs,
  measureArgs,
  needsLevelling,
  parseMeasured,
  parseProbe,
  probeArgs,
} from "../../src/render/loudness.js";

const measured = {
  input_i: -20.4,
  input_tp: -3.2,
  input_lra: 4.1,
  input_thresh: -30.6,
  target_offset: 0.4,
};

describe("levelling decision", () => {
  it("skips a file within 0.5 LU whose peak is fine", () => {
    assert.equal(needsLevelling({ ...measured, input_i: -14, input_tp: -1.5 }), false);
    assert.equal(needsLevelling({ ...measured, input_i: -14.5, input_tp: -1 }), false);
    assert.equal(needsLevelling({ ...measured, input_i: -13.5, input_tp: -2 }), false);
  });
  it("levels a file outside 0.5 LU or with a peak over -1", () => {
    assert.equal(needsLevelling({ ...measured, input_i: -14.6, input_tp: -3 }), true);
    assert.equal(needsLevelling({ ...measured, input_i: -13.4, input_tp: -3 }), true);
    assert.equal(needsLevelling({ ...measured, input_i: -14, input_tp: -0.9 }), true);
  });
});

describe("loudnorm measuring", () => {
  it("asks for the first pass as JSON on the audio only", () => {
    const args = measureArgs("/w/render.mp4");
    assert.deepEqual(args.slice(0, 4), ["-hide_banner", "-nostdin", "-i", "/w/render.mp4"]);
    assert.ok(args.includes("-vn"));
    assert.ok(args.includes("loudnorm=I=-14:TP=-1:LRA=11:print_format=json"));
    assert.deepEqual(args.slice(-3), ["-f", "null", "-"]);
  });

  it("reads the JSON block out of ffmpeg's log", () => {
    const stderr = `size=N/A\n[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-20.40",\n\t"input_tp" : "-3.20",\n\t"input_lra" : "4.10",\n\t"input_thresh" : "-30.60",\n\t"output_i" : "-14.1",\n\t"target_offset" : "0.40"\n}\n`;
    assert.deepEqual(parseMeasured(stderr), measured);
  });

  it("returns null for silence, an unreadable block or no block", () => {
    const silent =
      '{ "input_i" : "-inf", "input_tp" : "-inf", "input_lra" : "0.00", "input_thresh" : "-70.00", "target_offset" : "inf" }';
    assert.equal(parseMeasured(silent), null);
    assert.equal(parseMeasured("{ not json }"), null);
    assert.equal(parseMeasured("nothing here"), null);
    assert.equal(parseMeasured('{ "input_i": "-20" }'), null);
  });
});

describe("the levelling pass", () => {
  it("copies the picture, levels with the measured values, and writes AAC 320k at 48 kHz with faststart", () => {
    const args = levelArgs("/in.mp4", "/out.mp4", measured);
    const text = args.join(" ");
    assert.ok(text.includes("-map 0:v:0 -map 0:a:0 -c:v copy"));
    assert.ok(
      text.includes(
        "loudnorm=I=-14:TP=-1:LRA=11:measured_I=-20.4:measured_TP=-3.2:measured_LRA=4.1:measured_thresh=-30.6:offset=0.4:linear=true",
      ),
    );
    assert.ok(text.includes("-c:a aac -b:a 320k -ar 48000 -movflags +faststart /out.mp4"));
    assert.ok(args.includes("-y"));
    assert.equal(args.at(-1), "/out.mp4");
  });
});

describe("probe", () => {
  it("counts packets of the video stream and finds sound", () => {
    assert.ok(probeArgs("/f.mp4").includes("-count_packets"));
    const out = JSON.stringify({
      streams: [
        { codec_type: "video", width: 1920, height: 1080, nb_read_packets: "60" },
        { codec_type: "audio" },
      ],
    });
    assert.deepEqual(parseProbe(out), {
      hasVideo: true,
      hasAudio: true,
      videoFrames: 60,
      width: 1920,
      height: 1080,
    });
  });
  it("reports a file without sound or picture, and garbage as null", () => {
    assert.equal(
      parseProbe('{"streams":[{"codec_type":"video","nb_read_packets":"3"}]}')?.hasAudio,
      false,
    );
    assert.equal(parseProbe('{"streams":[{"codec_type":"audio"}]}')?.hasVideo, false);
    assert.equal(parseProbe('{"streams":[{"codec_type":"audio"}]}')?.videoFrames, null);
    assert.equal(parseProbe("nope"), null);
    assert.equal(parseProbe("{}"), null);
  });
});

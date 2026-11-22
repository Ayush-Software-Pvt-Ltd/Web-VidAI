// A stand-in for three programs of a render (docs/SPEC.md section 12): the HyperFrames CLI, ffprobe
// and ffmpeg. Tests run it as `node fake-hyperframes.mjs render <dir> -o <file> ...` (the CLI) or
// through small wrapper scripts made by `test/render/helpers.js` that put `ffprobe` or `ffmpeg` as
// the first argument.
//
// It is steered by a JSON file named by `FAKE_RENDER_CONFIG`:
//   hf:      { mode, frames, progressDelayMs, fixture }       mode: ok | fail-source | fail-graphic |
//                                                          fail-plain | hang | slow | no-output
//   probe:   { video, audio, frames }                 what ffprobe says about the render
//   levelled:{ video, audio, frames }                 ... about the levelled file (default: probe)
//   loud:    { input_i, input_tp, ... } | "silent"    what the measuring pass finds
//   ffmpeg:  { failMeasure, failLevel, hangLevel }
// Every call appends one JSON line to `FAKE_RENDER_RECORD`: tool, argv, a few environment values
// and the pid. The renderer's lines come from `fixtures/hyperframes-render/`: they are the real
// output of `hyperframes render` 0.9.80, recorded by hand.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures", "hyperframes-render");
const configFile = process.env.FAKE_RENDER_CONFIG;
const config = configFile ? JSON.parse(fs.readFileSync(configFile, "utf8")) : {};

const args = process.argv.slice(2);
const tool = args[0] === "ffprobe" || args[0] === "ffmpeg" ? args.shift() : "hyperframes";

const WATCHED = [
  "HYPERFRAMES_BROWSER_PATH",
  "HYPERFRAMES_EXTRACT_CACHE_DIR",
  "HYPERFRAMES_RENDER_LOCK",
  "HYPERFRAMES_NO_TELEMETRY",
  "HYPERFRAMES_NO_UPDATE_CHECK",
  "HYPERFRAMES_FFMPEG_PATH",
  "HYPERFRAMES_FFPROBE_PATH",
  "TMPDIR",
  "VIDAI_LIMIT_TEST",
];
if (process.env.FAKE_RENDER_RECORD) {
  const env = Object.fromEntries(WATCHED.map((k) => [k, process.env[k] ?? null]));
  fs.appendFileSync(
    process.env.FAKE_RENDER_RECORD,
    `${JSON.stringify({ tool, argv: args, env, pid: process.pid, cwd: process.cwd() })}\n`,
  );
}

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flag = (/** @type {string} */ name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : (args[at + 1] ?? null);
};

async function hyperframes() {
  const mode = config.hf?.mode ?? "ok";
  const out = flag("-o");
  const name =
    config.hf?.fixture ??
    (mode === "fail-source" ? "fail-source" : mode === "fail-graphic" ? "fail-graphic" : "success");
  const lines = fs.readFileSync(path.join(fixtures, `${name}.log`), "utf8").split("\n");
  if (mode === "fail-plain") {
    console.log("@hf-progress " + JSON.stringify({ code: "compile", pct: 5 }));
    console.error("Error: something odd happened in the renderer");
    console.error("   at line two of the detail");
    process.exit(1);
  }
  const delay = config.hf?.progressDelayMs ?? 0;
  const failing = mode === "fail-source" || mode === "fail-graphic";
  for (const [index, line] of lines.entries()) {
    console.log(line);
    if (mode === "hang" && line.startsWith("@hf-progress") && line.includes('"capture"')) {
      await new Promise(() => setInterval(() => {}, 1000));
    }
    if (delay > 0 && index % 10 === 0) await sleep(delay);
  }
  if (mode === "slow") await sleep(config.hf?.slowMs ?? 100);
  if (failing) process.exit(1);
  if (mode !== "no-output" && out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, "FAKE-MP4:render");
  }
  process.exit(0);
}

function ffprobe() {
  const file = args.at(-1) ?? "";
  const levelled = path.basename(file) === "levelled.mp4";
  const facts = (levelled ? config.levelled : null) ?? config.probe ?? {};
  const streams = [];
  if (facts.video !== false) {
    streams.push({
      codec_type: "video",
      codec_name: "h264",
      width: 1920,
      height: 1080,
      r_frame_rate: "30/1",
      nb_read_packets: String(facts.frames ?? config.hf?.frames ?? 60),
    });
  }
  if (facts.audio !== false) streams.push({ codec_type: "audio", codec_name: "aac" });
  console.log(JSON.stringify({ streams }));
}

async function ffmpeg() {
  const filter = flag("-af") ?? "";
  if (filter.includes("print_format=json")) {
    if (config.ffmpeg?.failMeasure) process.exit(1);
    const loud = config.loud ?? {};
    const body =
      loud === "silent"
        ? {
            input_i: "-inf",
            input_tp: "-inf",
            input_lra: "0.00",
            input_thresh: "-70.00",
            target_offset: "inf",
          }
        : {
            input_i: String(loud.input_i ?? -20.4),
            input_tp: String(loud.input_tp ?? -3.2),
            input_lra: String(loud.input_lra ?? 4.1),
            input_thresh: String(loud.input_thresh ?? -30.6),
            target_offset: String(loud.target_offset ?? 0.4),
          };
    console.error("[Parsed_loudnorm_0 @ 0x0]");
    console.error(JSON.stringify(body, null, 2));
    return;
  }
  if (config.ffmpeg?.hangLevel) await new Promise(() => setInterval(() => {}, 1000));
  if (config.ffmpeg?.failLevel) process.exit(1);
  const out = args.at(-1) ?? "";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, "FAKE-MP4:levelled");
}

if (tool === "ffprobe") ffprobe();
else if (tool === "ffmpeg") await ffmpeg();
else await hyperframes();

// A real, tiny project for the one test that runs the real renderer: the `long` fixture's page
// cut down to 3 seconds at 30 fps (1920x1080), with generated media. It needs a real `ffmpeg`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHelper } from "../../src/platform/process.js";
import { findFfmpeg } from "../../src/platform/tools.js";
import { findHyperframesCli } from "../../src/timeline/lint.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "..", "support", "fixtures", "projects", "long");

/** The sound of the generated A-roll: a quiet sine, so levelling has work to do. */
const QUIET = "0.05";

/**
 * @param {string} ffmpeg
 * @param {string[]} args
 */
async function make(ffmpeg, args) {
  const result = await runHelper({
    command: ffmpeg,
    args: ["-hide_banner", "-loglevel", "error", "-y", ...args],
    timeoutMs: 60_000,
  });
  if (result.code !== 0) throw new Error(`ffmpeg failed: ${result.stderr.slice(-300)}`);
}

/**
 * Builds the project in `dir` (made if needed): index.html cut from the `long` fixture,
 * `shared/gsap.min.js` from the renderer's own vendor folder, and generated media.
 * @param {string} dir
 * @param {string} [ffmpeg]
 * @returns {Promise<{ frames: number }>}
 */
export async function buildTinyProject(dir, ffmpeg = findFfmpeg() ?? "") {
  if (ffmpeg === "") throw new Error("ffmpeg is not installed");
  const bin = findHyperframesCli();
  if (bin === null) throw new Error("the hyperframes package is not installed");
  const media = path.join(dir, "assets", "media");
  fs.mkdirSync(media, { recursive: true });
  fs.mkdirSync(path.join(dir, "shared"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets", "music"), { recursive: true });

  const vendor = path.resolve(path.dirname(bin), "..", "dist", "vendor", "npm");
  const gsap = fs
    .readdirSync(vendor)
    .filter((n) => n.startsWith("gsap@"))
    .sort()
    .at(-1);
  fs.copyFileSync(
    path.join(vendor, gsap ?? "", "dist", "gsap.min.js"),
    path.join(dir, "shared", "gsap.min.js"),
  );
  fs.copyFileSync(
    path.join(
      FIXTURE,
      "..",
      "..",
      "..",
      "..",
      "..",
      "src",
      "render",
      "testProject",
      "hyperframes.json",
    ),
    path.join(dir, "hyperframes.json"),
  );
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    '{ "id": "vidai-real-test", "name": "VidAI real test", "createdAt": "2026-11-22T00:00:00.000Z" }\n',
  );

  await make(ffmpeg, [
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1920x1080:rate=30:duration=6",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=48000:duration=6`,
    "-af",
    `volume=${QUIET}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-b:v",
    "400k",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "30",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-shortest",
    path.join(media, "aroll.mp4"),
  ]);
  await make(ffmpeg, [
    "-f",
    "lavfi",
    "-i",
    "smptebars=size=1920x1080:rate=30:duration=2",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-b:v",
    "300k",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "30",
    "-an",
    path.join(media, "broll.mp4"),
  ]);
  await make(ffmpeg, [
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=duration=4:color=pink:amplitude=0.02:sample_rate=44100",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    path.join(dir, "assets", "music", "bed.mp3"),
  ]);

  let html = fs.readFileSync(path.join(FIXTURE, "index.html"), "utf8");
  html = html
    .replace(/\s*<link rel="stylesheet" href="shared\/kit\.css" \/>/u, "")
    .replace(/\s*@font-face \{[^}]*\}/u, "")
    .replace('data-duration="45"', 'data-duration="3"');
  const from = html.indexOf("      <!-- A-roll");
  const to = html.indexOf("    </div>\n    <script>");
  if (from === -1 || to === -1) throw new Error("the fixture page has a new shape");
  const clips =
    `      <video id="a-1" class="clip" src="assets/media/aroll.mp4" playsinline data-has-audio="true" data-start="0" data-duration="3" data-media-start="1" data-track-index="0" data-vidai-kind="aroll" data-vidai-label="Hook" style="z-index:0"></video>\n` +
    `      <video id="b-1" class="clip" src="assets/media/broll.mp4" playsinline muted data-start="1" data-duration="1" data-media-start="0" data-track-index="1" data-vidai-kind="broll" data-vidai-label="Bars" style="z-index:1"></video>\n` +
    `      <audio id="m-1" class="clip" src="assets/music/bed.mp3" data-start="0" data-duration="3" data-media-start="0" data-track-index="12" data-vidai-kind="music" data-vidai-label="Music bed"></audio>\n`;
  fs.writeFileSync(path.join(dir, "index.html"), html.slice(0, from) + clips + html.slice(to));
  return { frames: 90 };
}

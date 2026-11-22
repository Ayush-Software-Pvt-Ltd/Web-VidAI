// Helpers for the tests of the change requests' pictures (not a test file itself).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFps } from "../../src/timeline/frames.js";
import { ROOT_SCRIPT } from "../../src/timeline/rootScript.js";

/**
 * A frame rate (throws for a bad one).
 * @param {number} num
 * @param {number} den
 * @returns {import("../../src/timeline/frames.js").Fps}
 */
export function fpsOf(num, den = 1) {
  const fps = makeFps(num, den);
  if (fps === null) throw new Error(`bad frame rate ${num}/${den}`);
  return fps;
}

/** The real ffmpeg of this machine, or null. */
export function realFfmpeg() {
  for (const candidate of [
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** A fresh temporary folder and its cleanup. */
export function tempFolder(prefix = "vidai-note-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Mean red, green and blue of a rectangle of a picture, by ffmpeg (never by looking at it).
 * @param {string} ffmpeg
 * @param {string} file
 * @param {{ x: number, y: number, w: number, h: number } | null} crop Pixels; null: the whole picture.
 * @returns {[number, number, number]}
 */
export function meanRgb(ffmpeg, file, crop) {
  const chain = [
    crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}` : null,
    "scale=1:1:flags=area",
    "format=rgb24",
  ];
  const result = spawnSync(
    ffmpeg,
    ["-v", "error", "-i", file, "-vf", chain.filter(Boolean).join(","), "-f", "rawvideo", "-"],
    { maxBuffer: 1 << 20 },
  );
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
  return [result.stdout[0] ?? -1, result.stdout[1] ?? -1, result.stdout[2] ?? -1];
}

/**
 * The size of a picture, by reading the PNG header.
 * @param {string} file
 */
export function pngDimensions(file) {
  const head = fs.readFileSync(file).subarray(0, 24);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/**
 * The files of a folder as relative paths (recursive, links not followed), sorted.
 * @param {string} dir
 */
export function listTree(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ folder, /** @type {string} */ prefix) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      out.push(relative);
      if (entry.isDirectory()) walk(path.join(folder, entry.name), relative);
    }
  };
  walk(dir, "");
  return out.sort();
}

const OVERLAY = `<!doctype html>
<html>
  <head><meta charset="UTF-8" /></head>
  <body>
    <template>
      <style>
        #root { position: absolute; inset: 0; }
        #root .box { position: absolute; left: 5%; top: 75%; width: 20%; height: 20%; background: #fff; }
      </style>
      <div id="root" data-composition-id="ov-1" data-width="1920" data-height="1080">
        <div class="box" id="ov-1-box"></div>
      </div>
      <script>
        const tl = gsap.timeline({ paused: true });
        tl.fromTo("#ov-1-box", { opacity: 0.999 }, { opacity: 1, duration: 0.1 }, 0);
        window.__timelines["ov-1"] = tl;
      </script>
    </template>
  </body>
</html>
`;

/**
 * Writes a small real project (1920x1080, 30 fps, 4 seconds) into `dir`:
 * - `assets/media/aroll.mp4`, 8 seconds of 640x360 whose colour tells the frame and the place:
 *   red = the source frame number (0 to 239), green = the height (0 at the top, 255 at the bottom),
 *   blue = the width (0 at the left, 255 at the right);
 * - clip `a-1` (timeline frames 0 to 59) plays the source from its start, so timeline frame f shows
 *   source frame f; clip `a-2` (frames 60 to 119) plays from source second 5, so frame f shows
 *   source frame f + 90;
 * - clip `ov-1`, an overlay on track 2 for timeline frames 60 to 119: a white box over the lower left
 *   (x 5 to 25 percent, y 75 to 95 percent of the frame).
 * @param {string} dir
 * @param {string} ffmpeg
 */
export function writeNoteProject(dir, ffmpeg) {
  fs.mkdirSync(path.join(dir, "assets", "media"), { recursive: true });
  fs.mkdirSync(path.join(dir, "compositions"), { recursive: true });
  fs.mkdirSync(path.join(dir, "shared"), { recursive: true });
  const made = spawnSync(
    ffmpeg,
    [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=640x360:r=30:d=8",
      "-vf",
      "geq=r='N':g='Y*255/H':b='X*255/W'",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "12",
      "-g",
      "1",
      path.join(dir, "assets", "media", "aroll.mp4"),
    ],
    { encoding: "utf8" },
  );
  if (made.status !== 0) throw new Error(`ffmpeg could not make the test video: ${made.stderr}`);
  fs.copyFileSync(
    path.join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "toolkit",
      "CLAUDE_VE_ALL",
      "gfx",
      "_shared",
      "js",
      "gsap.min.js",
    ),
    path.join(dir, "shared", "gsap.min.js"),
  );
  fs.writeFileSync(path.join(dir, "compositions", "ov-1.html"), OVERLAY);
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="shared/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; overflow: hidden; background: #000; }
      .clip { position: absolute; inset: 0; }
      video.clip { width: 100%; height: 100%; object-fit: cover; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="30" data-duration="4">
      <video id="a-1" class="clip" src="assets/media/aroll.mp4" muted playsinline data-start="0" data-duration="2" data-media-start="0" data-track-index="0" data-vidai-kind="aroll" data-vidai-label="Hook" style="z-index:0"></video>
      <video id="a-2" class="clip" src="assets/media/aroll.mp4" muted playsinline data-start="2" data-duration="2" data-media-start="5" data-track-index="0" data-vidai-kind="aroll" data-vidai-label="Body" style="z-index:0"></video>
      <div id="ov-1" class="clip" data-composition-id="ov-1" data-composition-src="compositions/ov-1.html" data-start="2" data-duration="2" data-track-index="2" data-vidai-kind="overlay" data-vidai-label="Box" data-width="1920" data-height="1080" style="z-index:2"></div>
    </div>
    <script>
${ROOT_SCRIPT}
    </script>
  </body>
</html>
`,
  );
  fs.writeFileSync(
    path.join(dir, "edit.json"),
    JSON.stringify({
      toolkitVersion: "1.0.0",
      fps: "30",
      width: 1920,
      height: 1080,
      sources: [
        {
          name: "aroll.mp4",
          path: "assets/media/aroll.mp4",
          originalPath: null,
          frames: 240,
          fps: "30",
        },
      ],
      graphics: [{ id: "ov-1", template: "box", variables: {}, label: "Box" }],
    }),
  );
}

/**
 * The first bytes of a PNG of the given size: all `pngSize` reads.
 * @param {number} width
 * @param {number} height
 */
export function fakePng(width, height) {
  const head = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

/**
 * A fake `start` for `createNotePictures`: records every call and answers like the real programs.
 * - the snapshot call (`... snapshot ...`) writes one `frame-NN-at-<t>.png` per `--at` time into the
 *   `-o` folder (size = the project's size times the zoom scale, as the real tool) and prints its
 *   JSON; it also writes `.hyperframes/video-state.json` into the project, as the real tool does;
 * - the ffmpeg call writes the files its arguments name.
 * @param {object} [options]
 * @param {{ width: number, height: number }} [options.size] The project size (default 1920x1080).
 * @param {(call: { command: string, args: readonly string[] }) => import("../../src/timeline/noteRun.js").RunResult | null} [options.override]
 *   Answers a call itself (a failure, a timeout) when it returns a result.
 */
export function fakeRunner({ size = { width: 1920, height: 1080 }, override = () => null } = {}) {
  /** @type {Array<{ command: string, args: readonly string[], cwd: string | undefined, env: unknown, timeoutMs: number }>} */
  const calls = [];
  /** @type {import("../../src/timeline/noteRun.js").StartRun} */
  const start = (options) => {
    calls.push({
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
    const ok = { code: 0, stdout: "", stderr: "", timedOut: false, stopped: false };
    const answer = override({ command: options.command, args: options.args });
    if (answer !== null) return { done: Promise.resolve(answer), stop: async () => {} };
    const args = options.args;
    if (args.includes("snapshot")) {
      const at = String(args[args.indexOf("--at") + 1]).split(",");
      const out = String(args[args.indexOf("-o") + 1]);
      const project = String(args[args.indexOf("snapshot") + 1]);
      const zoomAt = args.indexOf("--zoom-scale");
      const scale = zoomAt >= 0 ? Number(args[zoomAt + 1]) : 1;
      fs.mkdirSync(out, { recursive: true });
      fs.mkdirSync(path.join(project, ".hyperframes"), { recursive: true });
      fs.writeFileSync(path.join(project, ".hyperframes", "video-state.json"), "{}");
      const frames = at.map((t, i) => {
        const file = path.join(
          out,
          `frame-${String(i).padStart(2, "0")}-at-${Number(t).toFixed(3)}s.png`,
        );
        fs.writeFileSync(file, fakePng(size.width * scale, size.height * scale));
        return { path: file, time: Number(Number(t).toFixed(3)) };
      });
      const stdout = `some banner\n${JSON.stringify({ ok: true, outputDir: out, frames })}\n`;
      return { done: Promise.resolve({ ...ok, stdout }), stop: async () => {} };
    }
    // ffmpeg: every `.png` path after `-update 1` is an output.
    args.forEach((arg, i) => {
      if (args[i - 1] === "1" && args[i - 2] === "-update") fs.writeFileSync(arg, fakePng(1, 1));
    });
    return { done: Promise.resolve(ok), stop: async () => {} };
  };
  return { start, calls };
}

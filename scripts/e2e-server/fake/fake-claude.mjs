#!/usr/bin/env node
// A fake Claude Code for the server end-to-end suite (scripts/e2e-server). It speaks the
// stream-json protocol of `claude -p --input-format stream-json --output-format stream-json`
// closely enough for the job manager, and does what a real edit leaves behind: a minimal valid
// HyperFrames project at `output/<video folder>.hf/index.html` (the A-roll copied into it), a
// thumbnail and `meta.txt`, then `[OUTPUT COMPLETED]`.
//
// Every message after the first (a change request on the timeline, a re-edit) changes the project
// by one comment and completes again. Its program (the first message) names the folders in the
// header lines `MAIN_FOLDER = ...` and `PROJECT_FOLDER = ...`.
// Without a session (the helper that reads models and usage) it answers with small fixed answers.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write("2.1.319 (Claude Code)\n");
  process.exit(0);
}
if (args[0] === "auth") {
  process.stdout.write('{"loggedIn":true}\n');
  process.exit(0);
}

const flag = (/** @type {string} */ name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : (args[at + 1] ?? null);
};
const sid = flag("--session-id") ?? flag("--resume");
const out = (/** @type {unknown} */ event) => process.stdout.write(`${JSON.stringify(event)}\n`);

/** A small valid PNG (64x36, one colour), made with zlib. */
function makePng() {
  const width = 64;
  const height = 36;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (/** @type {Buffer} */ data) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (/** @type {string} */ type, /** @type {Buffer} */ data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x60)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** @returns {string | null} The GSAP copy that comes with the renderer (HyperFrames). */
function gsapFile() {
  const vendor = path.resolve(here, "..", "..", "..", "node_modules", "hyperframes", "dist", "vendor", "npm");
  try {
    const folder = fs.readdirSync(vendor).filter((n) => n.startsWith("gsap@")).sort().at(-1);
    const file = folder ? path.join(vendor, folder, "dist", "gsap.min.js") : "";
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/** The A-roll file of the video folder: the first video file in it. @param {string} dir */
function arollOf(dir) {
  const names = fs.readdirSync(dir).filter((n) => /\.(mp4|mov|m4v|mkv)$/iu.test(n)).sort();
  return names.length > 0 ? path.join(dir, names[0]) : null;
}

/** @param {string} mainFolder @param {string} projectFolder */
function writeProject(mainFolder, projectFolder) {
  fs.mkdirSync(path.join(projectFolder, "assets", "media"), { recursive: true });
  fs.mkdirSync(path.join(projectFolder, "shared"), { recursive: true });
  const aroll = arollOf(mainFolder);
  if (aroll) fs.copyFileSync(aroll, path.join(projectFolder, "assets", "media", "aroll.mp4"));
  const gsap = gsapFile();
  if (gsap) fs.copyFileSync(gsap, path.join(projectFolder, "shared", "gsap.min.js"));
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script src="shared/gsap.min.js"></script>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="1920" data-height="1080" data-fps="25" data-duration="2">
      <video id="a-1" class="clip" src="assets/media/aroll.mp4" playsinline data-has-audio="true" data-start="0" data-duration="2" data-media-start="0" data-track-index="0" data-vidai-kind="aroll" data-vidai-label="Hook" style="z-index:0"></video>
    </div>
    <script>
(function () {
  window.__timelines = window.__timelines || {};
  var root = document.getElementById("root");
  var length = Math.max(0, Number(root.getAttribute("data-duration")) || 0);
  var timeline = gsap.timeline({ paused: true });
  timeline.to({}, { duration: length }, 0);
  window.__timelines["main"] = timeline;
})();
    </script>
  </body>
</html>
`;
  fs.writeFileSync(path.join(projectFolder, "index.html"), html);
  const facts = {
    toolkitVersion: "1.0.0",
    fps: 25,
    width: 1920,
    height: 1080,
    sources: [
      {
        name: "aroll.mp4",
        path: "assets/media/aroll.mp4",
        originalPath: aroll,
        frames: 50,
        fps: "25",
      },
    ],
    graphics: [],
  };
  fs.writeFileSync(path.join(projectFolder, "edit.json"), `${JSON.stringify(facts, null, 2)}\n`);
}

if (!sid) {
  // The helper without a session: it answers the three requests VidAI sends (models, settings,
  // usage) with small fixed answers.
  const answers = /** @type {Record<string, unknown>} */ ({
    initialize: {
      models: [
        {
          value: "default",
          resolvedModel: "claude-fake-1",
          displayName: "Default (recommended)",
          description: "A fake model for the end-to-end run",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
      ],
    },
    get_settings: { effective: { model: "default" }, applied: { model: "claude-fake-1", effort: "high" } },
    get_usage: { subscription_type: null, rate_limits_available: false, rate_limits: null },
  });
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    try {
      const request = JSON.parse(line);
      if (request.type !== "control_request") return;
      const subtype = request.request?.subtype;
      out({
        type: "control_response",
        response:
          subtype in answers
            ? { subtype: "success", request_id: request.request_id, response: answers[subtype] }
            : { subtype: "error", request_id: request.request_id, error: `Unsupported: ${subtype}` },
      });
    } catch {
      /* not JSON: ignore */
    }
  });
  lines.on("close", () => process.exit(0));
} else {
  runSession(sid);
}

/** @param {string} id */
function runSession(id) {
  const header = (/** @type {string} */ text, /** @type {string} */ name) =>
    new RegExp(`^${name} = (.+)$`, "mu").exec(text)?.[1]?.trim() ?? null;
  /** @type {{ main: string | null, project: string | null }} */
  const session = { main: null, project: null };
  let messages = 0;
  const say = (/** @type {string} */ text) =>
    out({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: id,
    });
  const tool = (/** @type {string} */ toolId, /** @type {string} */ description) => {
    out({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: toolId, name: "Bash", input: { command: "true", description } },
        ],
      },
      parent_tool_use_id: null,
      session_id: id,
    });
    out({
      type: "user",
      message: {
        role: "user",
        content: [{ tool_use_id: toolId, type: "tool_result", content: "ok", is_error: false }],
      },
      parent_tool_use_id: null,
      session_id: id,
    });
  };
  const result = (/** @type {string} */ text) =>
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 2,
      result: text,
      session_id: id,
      total_cost_usd: 0.01,
      terminal_reason: "completed",
    });

  /** @param {string} text */
  function work(text) {
    session.main = header(text, "MAIN_FOLDER") ?? session.main;
    session.project = header(text, "PROJECT_FOLDER") ?? session.project;
    out({
      type: "system",
      subtype: "init",
      cwd: process.cwd(),
      session_id: id,
      model: "claude-fake-1",
      permissionMode: "bypassPermissions",
    });
    messages += 1;
    const main = session.main;
    const project = session.project;
    if (main === null || project === null) {
      say("There is nothing to do for this message.");
      result("nothing to do");
      return;
    }
    tool(`t${messages}a`, "Inspect the A-roll");
    say("[VIDAI_PROGRESS inspected]");
    tool(`t${messages}b`, "Build the HyperFrames project");
    const index = path.join(project, "index.html");
    if (!fs.existsSync(index)) writeProject(main, project);
    else fs.appendFileSync(index, `\n<!-- changed by the fake agent (${messages}) -->\n`);
    const outputDir = path.join(main, "output");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "thumbnail-1.png"), makePng());
    fs.writeFileSync(
      path.join(outputDir, "meta.txt"),
      `Titles:\n1. ${path.basename(main)}\n\nDescription:\nA fake edit.\n\nTags: test\n`,
    );
    say("[VIDAI_PROGRESS review_saved]");
    say("[OUTPUT COMPLETED]");
    result("[OUTPUT COMPLETED]");
  }

  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === "control_request") {
      out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: { still_queued: [] },
        },
      });
      return;
    }
    if (message.type === "user") {
      const content = message.message?.content;
      const text = Array.isArray(content)
        ? content.map((/** @type {any} */ part) => part.text ?? "").join("\n")
        : String(content ?? "");
      work(text);
    }
  });
  lines.on("close", () => process.exit(0));
}

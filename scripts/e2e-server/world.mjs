// The world of one run: a throwaway data folder (seeded so edits can start without the network),
// a storage folder with one channel folder and one video folder holding a short A-roll, the fake
// Claude Code, and the real server started on a free port.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FAKE_CLAUDE = path.join(REPO, "scripts", "e2e-server", "fake", "fake-claude.mjs");

export const ADMIN_EMAIL = "admin@example.com";
export const USER_EMAIL = "user@example.com";
/** Throwaway passwords of this run (never a real one). */
export const ADMIN_PASSWORD = `admin-${Math.random().toString(36).slice(2, 12)}-e2e`;
export const USER_PASSWORD = `user-${Math.random().toString(36).slice(2, 12)}-e2e`;

export const CHANNEL_NAME = "E2E Channel";
export const VIDEO_FOLDER = "001 First Video";

/** @returns {Promise<number>} A port nobody listens on right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (probe.address());
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

/** @param {string} program @returns {boolean} */
function hasProgram(program) {
  return spawnSync(program, ["-version"], { stdio: "ignore" }).status === 0;
}

/**
 * A two second A-roll: a real clip when ffmpeg is there, else a tiny file the fake accepts.
 * @param {string} file
 * @returns {"ffmpeg" | "placeholder"}
 */
function writeARoll(file) {
  if (hasProgram("ffmpeg")) {
    const made = spawnSync(
      "ffmpeg",
      [
        ...["-v", "error", "-y"],
        ...["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=25:duration=2"],
        ...["-f", "lavfi", "-i", "sine=frequency=440:duration=2"],
        ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac"],
        ...["-shortest", file],
      ],
      { stdio: "ignore" },
    );
    if (made.status === 0 && fs.existsSync(file)) return "ffmpeg";
  }
  fs.writeFileSync(file, "tiny a-roll");
  return "placeholder";
}

/**
 * Whether the real HyperFrames renderer can run here: its browser is installed already (the run
 * never downloads one) and ffmpeg is there.
 * @returns {{ ok: boolean, note: string }}
 */
export function rendererStatus() {
  const cli = path.join(REPO, "node_modules", ".bin", "hyperframes");
  if (!fs.existsSync(cli)) return { ok: false, note: "the hyperframes package is not installed" };
  if (!hasProgram("ffmpeg")) return { ok: false, note: "ffmpeg is not installed" };
  const found = spawnSync(cli, ["browser", "path"], { encoding: "utf8", timeout: 60_000 });
  const line = String(found.stdout ?? "").trim().split(/\r?\n/u).at(-1) ?? "";
  if (found.status !== 0 || line === "" || !fs.existsSync(line)) {
    return { ok: false, note: "the renderer's browser is not installed (hyperframes browser ensure)" };
  }
  return { ok: true, note: line };
}

/**
 * Makes the folders. `prepare.json` is written as a finished Prepare (the steps, the hash of the
 * shipped requirements.txt, a placeholder for the environment's Python), so edits can start
 * without installing Python packages or the speech model; the renderer's steps are marked done
 * only when the renderer can run here.
 * @param {{ root: string, renderer: boolean }} input
 */
async function seedToolkit({ root, renderer }) {
  const dataDir = path.join(root, "data");
  const { toolkitPaths } = await import(
    pathToFileURL(path.join(REPO, "server", "src", "toolkit", "paths.js")).href
  );
  const { requirementsHash } = await import(
    pathToFileURL(path.join(REPO, "server", "src", "toolkit", "install.js")).href
  );
  const paths = toolkitPaths(dataDir);
  fs.mkdirSync(path.dirname(paths.python), { recursive: true });
  fs.writeFileSync(paths.python, "#!/bin/sh\n", { mode: 0o755 });
  const now = Date.now();
  const ids = ["python", "venv", "packages", "ffmpeg", "doctor", "speech", "browser", "render"];
  const record = {
    format: 1,
    steps: ids.map((id) => {
      const done = renderer || !["browser", "render"].includes(id);
      return {
        id,
        state: done ? "done" : "pending",
        message: done ? "Prepared by the end-to-end runner." : null,
        at: done ? now : null,
      };
    }),
    log: [],
    requirementsHash: requirementsHash(
      path.join(REPO, "toolkit", "CLAUDE_VE_ALL", "requirements.txt"),
    ),
    startedAt: now,
    finishedAt: now,
  };
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.prepareFile, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * @param {{ out?: string }} [options]
 */
export async function makeWorld({ out } = {}) {
  const root = fs.realpathSync(
    out
      ? (fs.mkdirSync(out, { recursive: true }), out)
      : fs.mkdtempSync(path.join(os.tmpdir(), "vidai-e2e-server-")),
  );
  const dataDir = path.join(root, "data");
  const storage = path.join(root, "storage");
  const channelDir = path.join(storage, CHANNEL_NAME);
  const videoDir = path.join(channelDir, VIDEO_FOLDER);
  fs.mkdirSync(videoDir, { recursive: true });
  const aroll = writeARoll(path.join(videoDir, "clip.mp4"));
  const renderer = rendererStatus();
  await seedToolkit({ root, renderer: renderer.ok });
  return { root, dataDir, storage, channelDir, videoDir, aroll, renderer };
}

/**
 * Starts the real server (`server/src/main.js`) on a free port with the fake Claude Code.
 * @param {Awaited<ReturnType<typeof makeWorld>>} world
 * @param {{ verbose?: boolean }} [options]
 */
export async function startServer(world, { verbose = false } = {}) {
  const port = await freePort();
  const logFile = path.join(world.root, "server.out");
  const sink = fs.openSync(logFile, "a");
  /** @type {Record<string, string>} */
  const env = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: process.env["HOME"] ?? world.root,
    VIDAI_DATA_DIR: world.dataDir,
    VIDAI_SECRETS: "memory",
    VIDAI_CLAUDE_BIN: FAKE_CLAUDE,
    VIDAI_ADMIN_EMAIL: ADMIN_EMAIL,
    VIDAI_ADMIN_PASSWORD: ADMIN_PASSWORD,
    VIDAI_HOST: "127.0.0.1",
    VIDAI_PORT: String(port),
  };
  const child = spawn(process.execPath, [path.join(REPO, "server", "src", "main.js")], {
    cwd: REPO,
    env,
    stdio: ["ignore", sink, sink],
  });
  fs.closeSync(sink);
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const base = `https://127.0.0.1:${port}`;

  const tail = () => {
    try {
      return fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-12).join("\n");
    } catch {
      return "";
    }
  };
  // Waits until the page answers (the certificate is the server's own).
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exited) throw new Error(`The server stopped while starting:\n${tail()}`);
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`The server did not answer within 60 seconds:\n${tail()}`);
    }
    if (await answers(base)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (verbose) process.stdout.write(`  server: ${base} (log ${logFile})\n`);

  async function stop() {
    if (exited) return;
    child.kill("SIGTERM");
    const done = new Promise((resolve) => child.once("exit", resolve));
    const late = new Promise((resolve) => setTimeout(resolve, 45_000, "late"));
    if ((await Promise.race([done, late])) === "late") child.kill("SIGKILL");
  }
  /** Last resort for a process exit: kills the child without waiting. */
  function killNow() {
    if (!exited) child.kill("SIGKILL");
  }

  return { base, port, logFile, stop, killNow, tail };
}

/** @param {string} base @returns {Promise<boolean>} */
function answers(base) {
  return new Promise((resolve) => {
    import("node:https").then(({ default: https }) => {
      const request = https.get(
        base,
        { rejectUnauthorized: false, timeout: 2000 },
        (response) => {
          response.resume();
          resolve(true);
        },
      );
      request.on("error", () => {
        resolve(false);
      });
      request.on("timeout", () => {
        request.destroy();
        resolve(false);
      });
    }, () => {
      resolve(false);
    });
  });
}

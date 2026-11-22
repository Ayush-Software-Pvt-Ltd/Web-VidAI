// The whole server for the integration tests of the composition root: every module wired as in
// production (`src/engine.js`), with the programs replaced by the stand-ins the module tests use
// (fake Claude Code, fake renderer and ffmpeg, stand-in toolkit and Python, a fake ffprobe), in a
// temporary data directory. Tests talk to it like a browser: HTTPS, cookie, `X-VidAI: 1`, the
// event stream (`startApp` and `makeClient` of `support.js`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAgent } from "../../src/agents/start.js";
import { toolkitPaths } from "../../src/toolkit/paths.js";
import { until } from "../jobs/managerSupport.js";
import { FAKE_CLAUDE } from "../jobs/engineSupport.js";
import { fakeFfprobe } from "../library/support.js";
import { FIXTURES } from "../timeline/helpers.js";
import { writeShippedToolkit } from "../support/fake-python.js";
import { FAKE_CLI } from "../render/helpers.js";
import { ADMIN_EMAIL, ADMIN_PASSWORD, startApp } from "./support.js";

export { ADMIN_EMAIL, ADMIN_PASSWORD, until };
export const USER_PASSWORD = "user-password-for-tests";

/** The timings the job driver needs in tests (as `jobs/managerSupport.js`). */
const DRIVER_TIMINGS = {
  settle: 250,
  interruptTimeout: 3000,
  exitTimeout: 5000,
  killGrace: 500,
  stallTimeout: 15_000,
  progressInterval: 100,
  treeRefresh: 200,
  retrySecond: 0,
};

/** A Python that "works" for Prepare: every command succeeds, `-m venv` makes the file. @param {string} venv */
function pretendRunner(venv) {
  return async (/** @type {{ args?: string[] }} */ request) => {
    const text = (request.args ?? []).join(" ");
    const ok = (/** @type {string[]} */ tail) => ({
      started: true,
      code: 0,
      timedOut: false,
      aborted: false,
      tail,
      error: null,
    });
    if (text.includes("sys.version_info")) return ok(["3.12.4"]);
    if (text.includes("-m venv")) {
      fs.mkdirSync(path.dirname(venv), { recursive: true });
      fs.writeFileSync(venv, "#!/bin/sh\n");
      return ok([]);
    }
    if (text.includes("-m pip --version")) return ok(["pip 24.0 from x"]);
    if (text.includes("doctor")) return ok(["speech   OK  mlx, device gpu", "result: READY"]);
    if (text.includes("snapshot_download")) return ok(["VIDAI_MODEL mlx m /c"]);
    return ok([]);
  };
}

/** @param {string} dir @param {"ffprobe" | "ffmpeg"} name */
function renderWrapper(dir, name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" ${name} "$@"\n`, {
    mode: 0o755,
  });
  return file;
}

/**
 * What a stopped world leaves for the next start.
 * @typedef {object} WorldBase
 * @property {string} root
 * @property {Array<(spec: any) => void>} starts
 * @property {{ api: any, stateOf: (jobId: string) => string }} live
 */

/**
 * Start the whole server. Pass `base` (from a world that was stopped) to start again on the same
 * data directory and the same stand-ins.
 * @param {{ base?: WorldBase, engine?: Record<string, any>, settings?: Record<string, unknown> }} [input]
 */
export async function startWorld({ base, engine = {}, settings } = {}) {
  const root = base?.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "vidai-world-"));
  const dataDir = path.join(root, "data");
  const stateDir = path.join(root, "fake-state");
  const binDir = path.join(root, "bin");
  const source = path.join(root, "toolkit-source");
  for (const dir of [stateDir, binDir, source]) fs.mkdirSync(dir, { recursive: true });
  if (!base) writeShippedToolkit(source);
  const probe = fakeFfprobe(root);
  const renderConfig = path.join(root, "fake-render-config.json");
  if (!fs.existsSync(renderConfig)) fs.writeFileSync(renderConfig, "{}");
  const venv = toolkitPaths(dataDir).python;

  /** @type {Array<(spec: any) => void>} */
  const starts = base?.starts ?? [];
  // The hooks of `starts` outlive one start: they look at the app that runs now.
  /** @type {{ api: any, stateOf: (jobId: string) => string }} */
  const live = base?.live ?? { api: null, stateOf: () => "" };
  const baseEnv = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    FAKE_STATE: stateDir,
    HOME: root,
  };
  const env = {
    ...baseEnv,
    VIDAI_SECRETS: "memory",
    VIDAI_CLAUDE_BIN: FAKE_CLAUDE,
    VIDAI_ADMIN_EMAIL: ADMIN_EMAIL,
    VIDAI_ADMIN_PASSWORD: ADMIN_PASSWORD,
    ...probe.env("ok"),
  };
  const quiet = () => Promise.resolve({ ok: true, message: "ok" });
  const t = await startApp({
    dataDir,
    env,
    options: {
      engine: {
        claude: {
          home: root,
          startClient: () => {
            throw new Error("no Claude Code helper in the tests");
          },
          ...engine["claude"],
        },
        toolkit: {
          source,
          ensureBrowser: quiet,
          testRender: quiet,
          prepareOptions: {
            runner: pretendRunner(venv),
            pythonCandidates: () => [
              { command: "/fake/python3", args: [], label: "/fake/python3" },
            ],
            findFfmpeg: () => "/fake/ffmpeg",
            findFfprobe: () => "/fake/ffprobe",
          },
          ...engine["toolkit"],
        },
        timeline: { runLint: async () => ({ errors: [], problem: null }), ...engine["timeline"] },
        render: {
          hyperframesBin: FAKE_CLI,
          ffmpeg: renderWrapper(binDir, "ffmpeg"),
          ffprobe: renderWrapper(binDir, "ffprobe"),
          browserPath: "/fake/browser",
          freeBytes: async () => 100 * 1024 ** 3,
          runnerOptions: {
            env: {
              ...process.env,
              FAKE_RENDER_CONFIG: renderConfig,
              FAKE_RENDER_RECORD: path.join(root, "fake-record.jsonl"),
            },
            endGraceMs: 200,
            gpuNoteMs: 10,
          },
          ...engine["render"],
        },
        copies: { ffmpeg: () => null, ffprobe: () => null, ...engine["copies"] },
        pictures: { cli: null, ffmpeg: null, ...engine["pictures"] },
        jobs: {
          baseEnv,
          hyperframesBin: FAKE_CLI,
          driverTimings: DRIVER_TIMINGS,
          shutdownMs: 10_000,
          startAgent: (/** @type {any} */ spec) => {
            for (const hook of starts) hook(spec);
            return startAgent(spec);
          },
          ...engine["jobs"],
        },
        tokenSweepMs: 60_000,
        ...Object.fromEntries(
          Object.entries(engine).filter(
            ([key]) =>
              !["claude", "toolkit", "timeline", "render", "copies", "pictures", "jobs"].includes(
                key,
              ),
          ),
        ),
      },
    },
  });
  const api = t.app.engine;
  // Edits need Prepare's editing steps: wait for the stand-in Python to be "installed".
  await until(() => api["toolkit"].api.renderReady(), 20_000);
  const admin = t.client();
  await admin.rpc("login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (settings) await admin.rpc("adminUpdateSettings", settings);

  let counter = 0;
  /** A new user with a signed-in client. @param {{ role?: string, name?: string }} [options] */
  async function addUser({ role = "user", name = `user${(counter += 1)}` } = {}) {
    const email = `${name}@example.com`;
    const created = await admin.rpc("adminCreateUser", { email, password: USER_PASSWORD, role });
    if (created.status !== 200)
      throw new Error(`adminCreateUser: ${created.status} ${created.text}`);
    const client = t.client();
    const login = await client.rpc("login", { email, password: USER_PASSWORD });
    if (login.status !== 200) throw new Error(`login: ${login.status}`);
    return { client, id: /** @type {string} */ (login.json.user.id), email };
  }

  /**
   * A channel with one video folder that has a tiny A-roll, seen by the library.
   * @param {{ client: ReturnType<typeof t.client>, id: string }} user
   * @param {{ channel?: string, folder?: string }} [options]
   */
  async function addVideo(user, { channel = "Main", folder = "001 First" } = {}) {
    const made = await user.client.rpc("createChannel", {
      name: channel,
      videoType: "auto",
      location: { kind: "new", parent: null, folderName: channel },
    });
    if (made.status !== 200) throw new Error(`createChannel: ${made.status} ${made.text}`);
    const channelId = /** @type {string} */ (made.json.id);
    const dir = fs.realpathSync(api["storage"].api.channelsRepo.byId(channelId).dir);
    const videoDir = path.join(dir, folder);
    fs.mkdirSync(videoDir, { recursive: true });
    fs.writeFileSync(path.join(videoDir, "clip.mp4"), "tiny a-roll");
    await api["library"].api.rescan(user.id);
    const videoId = `${channelId}/${folder}`;
    const key = (await api["library"].api.videoByWireId(user.id, videoId)).key;
    const projectDir = path.join(videoDir, "output", `${folder}.hf`);
    return { channelId, videoId, key, dir: videoDir, channelDir: dir, projectDir, folder };
  }

  /**
   * The agent leaves the long fixture project behind (or a change to it) when it starts. With a
   * video, only for the job of that video that is running (several videos can have jobs at once).
   * @param {string | { key: string, projectDir: string }} target
   */
  function writesProject(target) {
    const projectDir = typeof target === "string" ? target : target.projectDir;
    starts.push(() => {
      if (typeof target !== "string") {
        const job = live.api["jobs"].api.activeJob(target.key);
        if (!job || live.stateOf(job.id) !== "running") return;
      }
      if (!fs.existsSync(projectDir)) {
        fs.cpSync(path.join(FIXTURES, "long"), projectDir, { recursive: true });
      } else {
        fs.appendFileSync(path.join(projectDir, "index.html"), "\n<!-- changed by the agent -->\n");
      }
    });
  }

  /**
   * The fake Claude Code names its signal files after the video folder as the prompt gives it (a
   * whole path here, since the prompt carries absolute paths), so their folders must exist first.
   * @param {{ dir: string }} video
   */
  function signals(video) {
    const file = (/** @type {string} */ kind) => `${stateDir}/${kind}.${video.dir}`;
    fs.mkdirSync(path.dirname(file("started")), { recursive: true });
    return {
      started: () => fs.existsSync(file("started")),
      release() {
        fs.mkdirSync(path.dirname(file("release")), { recursive: true });
        fs.writeFileSync(file("release"), "");
      },
    };
  }

  /** @param {string} jobId */
  const stateOf = (jobId) =>
    String(t.app.db.get("SELECT state FROM jobs WHERE id = ?", jobId)?.["state"]);

  live.api = api;
  live.stateOf = stateOf;

  return {
    ...t,
    live,
    root,
    api,
    admin,
    starts,
    stateDir,
    addUser,
    addVideo,
    writesProject,
    signals,
    stateOf,
    renderConfig,
    /** @param {string} jobId @param {string} state */
    waitState: (jobId, state) => until(() => stateOf(jobId) === state, 30_000),
    /** @param {string} scenario */
    scenario: (scenario) => fs.writeFileSync(path.join(stateDir, "scenario"), scenario),
    /** Stop the app but keep the folders, for `startWorld({ base })`. */
    async stopApp() {
      await t.close();
    },
    /** Stop everything and remove the temporary folders. */
    async close() {
      await t.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

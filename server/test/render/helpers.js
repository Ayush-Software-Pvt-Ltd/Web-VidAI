// Shared setup of the render tests: a temporary data directory, a video folder with a tiny
// project, the fake CLI plus fake ffprobe and ffmpeg wrappers, and fakes for the limits module,
// the process registry and the job log.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRenderRunner } from "../../src/render/runner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CLI = path.join(here, "..", "support", "fake-hyperframes.mjs");

/** A logger that keeps what it is told. */
export function memoryLog() {
  /** @type {{ level: string, message: string }[]} */
  const lines = [];
  return {
    lines,
    info: (/** @type {string} */ message) => lines.push({ level: "info", message }),
    warn: (/** @type {string} */ message) => lines.push({ level: "warn", message }),
    error: (/** @type {string} */ message) => lines.push({ level: "error", message }),
  };
}

/** @param {string} root @param {{ fps?: string, seconds?: number, width?: number, height?: number }} [shape] */
export function writeProject(root, { fps = "30", seconds = 2, width = 1920, height = 1080 } = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "index.html"),
    `<!doctype html><html><body><div id="root" data-composition-id="main" data-start="0" ` +
      `data-width="${width}" data-height="${height}" data-fps="${fps}" data-duration="${seconds}"></div></body></html>\n`,
  );
}

/**
 * Fake of `limits.api`. `gpu`: `"free"` gives a slot at once, `"wait"` waits for `grant()`,
 * `"broken"` rejects with an ordinary error.
 * @param {{ workers?: number, gpu?: "free" | "wait" | "broken" }} [options]
 */
export function fakeLimits({ workers = 1, gpu = "free" } = {}) {
  /** @type {string[]} */
  const events = [];
  /** @type {{ resolve(): void } | null} */
  let waiting = null;
  const api = {
    envFor: () => ({ VIDAI_LIMIT_TEST: "yes" }),
    limitsFor: () => ({ renderWorkers: workers }),
    /** @param {string} _key @param {{ rootPid: number | null, kind: string }} job */
    jobStarted: (_key, job) => {
      events.push(`started:${job.kind}:${job.rootPid === null ? "none" : "pid"}`);
    },
    jobEnded: () => {
      events.push("ended");
    },
    resumeAll: () => {
      events.push("resumed");
    },
    /** @param {string} _key @param {AbortSignal} [signal] */
    acquireGpuSlot(_key, signal) {
      events.push("slot:asked");
      if (gpu === "broken") return Promise.reject(new Error("the slot folder is not writable"));
      const slot = {
        index: 0,
        release: () => {
          events.push("slot:released");
        },
      };
      if (gpu === "free") {
        events.push("slot:taken");
        return Promise.resolve(slot);
      }
      return new Promise((resolve, reject) => {
        waiting = {
          resolve: () => {
            events.push("slot:taken");
            resolve(slot);
          },
        };
        signal?.addEventListener("abort", () => {
          events.push("slot:aborted");
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    },
  };
  return {
    api,
    events,
    grant: () => waiting?.resolve(),
    get isWaiting() {
      return waiting !== null;
    },
  };
}

/**
 * @param {string} dir
 * @param {"ffprobe" | "ffmpeg"} name
 * @returns {string} A script that runs the fake as `name`.
 */
function wrapper(dir, name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" ${name} "$@"\n`, {
    mode: 0o755,
  });
  return file;
}

/**
 * @typedef {object} HarnessOptions
 * @property {Record<string, unknown>} [config] The fake's config (see `fake-hyperframes.mjs`).
 * @property {{ fps?: string, seconds?: number, width?: number, height?: number }} [project]
 * @property {number | (() => Promise<number>)} [free] Free bytes (default 100 GB).
 * @property {ReturnType<typeof fakeLimits>} [limits]
 * @property {1080 | 2160} [resolution]
 * @property {string | null} [browserPath]
 * @property {Partial<import("../../src/render/runner.js").RenderRunnerDeps>} [deps]
 */

/** @param {HarnessOptions} [options] */
export function makeHarness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-render-"));
  const dataDir = path.join(root, "data");
  const videoDir = path.join(root, "channel", "My Video");
  const projectDir = path.join(videoDir, "output", "My Video.hf");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  writeProject(projectDir, options.project);
  const frames = (options.project?.seconds ?? 2) * 30;
  const configFile = path.join(root, "fake-config.json");
  const recordFile = path.join(root, "fake-record.jsonl");
  fs.writeFileSync(
    configFile,
    JSON.stringify({ probe: { frames }, hf: { frames }, ...options.config }),
  );
  const limits = options.limits ?? fakeLimits();
  const log = memoryLog();
  /** @type {{ videoKey: string, jobId: string, drafts: readonly { kind: string, text: string }[] }[]} */
  const logged = [];
  /** @type {import("../../src/render/runner.js").RenderPatch[]} */
  const updates = [];
  /** @type {string[]} */
  const registryEvents = [];
  let tick = 0;
  const free = options.free ?? 100 * 1024 ** 3;
  const runner = createRenderRunner({
    limits: limits.api,
    registry: {
      add: async ({ pid }) => void registryEvents.push(`add:${typeof pid}`),
      remove: async () => void registryEvents.push("remove"),
    },
    sink: {
      push: (videoKey, jobId, drafts) => void logged.push({ videoKey, jobId, drafts }),
    },
    onUpdate: (patch) => void updates.push(patch),
    dataDir,
    clock: { now: () => (tick += 1100) },
    log,
    hyperframesBin: FAKE_CLI,
    ffmpeg: wrapper(bin, "ffmpeg"),
    ffprobe: wrapper(bin, "ffprobe"),
    browserPath: options.browserPath ?? "/fake/browser",
    freeBytes: typeof free === "function" ? free : async () => free,
    env: { ...process.env, FAKE_RENDER_CONFIG: configFile, FAKE_RENDER_RECORD: recordFile },
    endGraceMs: 200,
    gpuNoteMs: 10,
    ...options.deps,
  });
  /** @type {import("../../src/render/runner.js").RenderFacts} */
  const facts = {
    videoKey: "k".repeat(32),
    projectDir,
    videoDir,
    folderName: "My Video",
    resolution: options.resolution ?? 1080,
    userId: "u1",
  };
  return {
    root,
    dataDir,
    videoDir,
    projectDir,
    outputDir: path.join(videoDir, "output"),
    limits,
    runner,
    facts,
    log,
    logged,
    updates,
    registryEvents,
    configFile,
    /** @param {Record<string, unknown>} config */
    setConfig: (config) =>
      fs.writeFileSync(
        configFile,
        JSON.stringify({ probe: { frames }, hf: { frames }, ...config }),
      ),
    /** @returns {{ tool: string, argv: string[], env: Record<string, string | null>, pid: number, cwd: string }[]} */
    calls() {
      try {
        return fs
          .readFileSync(recordFile, "utf8")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    /** @returns {string[]} The job log as `kind: text`. */
    lines: () => logged.flatMap((e) => e.drafts.map((d) => `${d.kind}: ${d.text}`)),
    cacheDir: () => path.join(dataDir, "cache", "render"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Polls until `check` is true.
 * @param {() => boolean} check
 * @param {string} [what]
 * @param {number} [timeoutMs]
 */
export async function waitFor(check, what = "the condition", timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** @param {number} pid @returns {boolean} */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

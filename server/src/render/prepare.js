// What Prepare (the toolkit installer, docs/SPEC.md section 7) needs for rendering to work
// without the network (section 12): the renderer's browser and a first render, which also fills
// the renderer's font cache. Both answer `{ ok, message }` and never throw.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderArgs, renderEnv, workFolders } from "./args.js";
import { cleanLine } from "./diagnostics.js";
import { failureMessage } from "./diagnostics.js";
import { createLineSplitter } from "./tool.js";
import { dataPaths } from "../config.js";
import { runHelper } from "../platform/process.js";

/** The small project `testRender` renders (two seconds, a title in the Inter font). */
export const TEST_PROJECT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "testProject",
);

/** How long the browser may take to install (about 400 MB) and a test render to run. */
const ENSURE_TIMEOUT_MS = 20 * 60_000;
const TEST_TIMEOUT_MS = 10 * 60_000;

/**
 * @typedef {object} PrepareDeps
 * @property {string} hyperframesBin
 * @property {string} dataDir
 * @property {string} [nodePath]
 * @property {Readonly<Record<string, string | undefined>>} [env]
 * @property {() => string | null} [ffmpeg] For the test render (the renderer finds its own when null).
 * @property {() => string | null} [ffprobe]
 * @property {() => string | null} [browserPath] The browser found by `ensureBrowser`, for the test render.
 * @property {typeof runHelper} [run] Test seam.
 * @property {import("../log.js").Logger} [log]
 */

/** @typedef {{ ok: boolean, message: string }} PrepareResult */

/**
 * The browser path out of the text `hyperframes browser ensure` prints:
 * `   Path:    /Users/x/.cache/hyperframes/chrome/.../chrome-headless-shell`.
 * @param {string} output
 * @returns {string | null}
 */
export function parseBrowserPath(output) {
  for (const raw of output.split(/\r?\n/u)) {
    const match = /^\s*Path:\s+(.+?)\s*$/u.exec(cleanLine(raw));
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * @param {PrepareDeps} deps
 */
export function createPrepare(deps) {
  const { hyperframesBin, dataDir, nodePath = process.execPath, run = runHelper } = deps;
  const base = deps.env ?? process.env;
  const log = deps.log;
  /** The browser `ensureBrowser` found, kept for the renders of this run. @type {string | null} */
  let foundBrowser = null;

  /** @returns {Record<string, string | undefined>} */
  const quietEnv = () => ({
    ...base,
    HYPERFRAMES_NO_TELEMETRY: "1",
    HYPERFRAMES_NO_UPDATE_CHECK: "1",
  });

  return {
    /** @returns {string | null} The browser `ensureBrowser` found (null before it ran). */
    browserPath: () => foundBrowser,

    /**
     * Finds or installs the renderer's browser (`hyperframes browser ensure`; it downloads about
     * 400 MB the first time).
     * @returns {Promise<PrepareResult & { path: string | null }>}
     */
    async ensureBrowser() {
      try {
        const result = await run({
          command: nodePath,
          args: [hyperframesBin, "browser", "ensure"],
          env: quietEnv(),
          timeoutMs: ENSURE_TIMEOUT_MS,
        });
        const found = parseBrowserPath(result.stdout);
        if (result.code === 0 && found !== null) {
          foundBrowser = found;
          return { ok: true, message: `The renderer's browser is ready: ${found}`, path: found };
        }
        const why = cleanLine(
          result.timedOut ? "it took too long" : lastLine(result.stderr || result.stdout),
        );
        return {
          ok: false,
          message: `The renderer's browser could not be installed: ${why || "no reason was given"}.`,
          path: null,
        };
      } catch (error) {
        log?.warn("hyperframes browser ensure failed", error);
        return {
          ok: false,
          message: `The renderer's browser could not be installed: ${error instanceof Error ? error.message : String(error)}.`,
          path: null,
        };
      }
    },

    /**
     * Renders the built-in two second project once at 1 worker, without the GPU (which also
     * fetches and caches the fonts it uses).
     * @returns {Promise<PrepareResult>}
     */
    async testRender() {
      const workDir = path.join(
        dataPaths(dataDir).renderCacheDir,
        `test-${process.pid}-${Date.now().toString(36)}`,
      );
      try {
        const folders = workFolders(workDir);
        for (const dir of Object.values(folders)) await fs.mkdir(dir, { recursive: true });
        const project = path.join(workDir, "project");
        await fs.cp(TEST_PROJECT_DIR, project, { recursive: true });
        await copyGsap(hyperframesBin, path.join(project, "shared"));
        const outFile = path.join(folders.out, "test.mp4");
        const env = renderEnv({
          base,
          limits: {},
          workDir,
          browserPath: deps.browserPath?.() ?? foundBrowser,
          ffmpeg: deps.ffmpeg?.() ?? null,
          ffprobe: deps.ffprobe?.() ?? null,
        });
        const result = await run({
          command: nodePath,
          args: [
            hyperframesBin,
            ...renderArgs({
              projectDir: project,
              outFile,
              fps: "30",
              workers: 1,
              resolution: 1080,
              portrait: false,
              gpu: false,
            }),
          ],
          env,
          cwd: workDir,
          timeoutMs: TEST_TIMEOUT_MS,
        });
        if (result.timedOut) return { ok: false, message: "The test render took too long." };
        if (result.code !== 0) {
          /** @type {string[]} */
          const lines = [];
          const splitter = createLineSplitter((line) => lines.push(line));
          splitter.push(`${result.stdout}\n${result.stderr}`);
          splitter.end();
          return {
            ok: false,
            message: `The test render failed. ${failureMessage(lines, result.code)}`,
          };
        }
        const size = (await fs.stat(outFile)).size;
        return {
          ok: size > 0,
          message: size > 0 ? "A test render works." : "The test render wrote an empty file.",
        };
      } catch (error) {
        log?.warn("the test render failed", error);
        return {
          ok: false,
          message: `The test render could not be run: ${error instanceof Error ? error.message : String(error)}.`,
        };
      } finally {
        await fs
          .rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
          .catch(() => {});
      }
    },
  };
}

/** @param {string} text @returns {string} */
function lastLine(text) {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1) ?? "";
}

/**
 * Copies GSAP (the renderer's own vendored copy) into the test project, so the project needs no
 * network and the package carries no copy of it.
 * @param {string} hyperframesBin `<package>/bin/hyperframes.mjs`
 * @param {string} toDir
 */
async function copyGsap(hyperframesBin, toDir) {
  const vendor = path.resolve(path.dirname(hyperframesBin), "..", "dist", "vendor", "npm");
  const entries = await fs.readdir(vendor);
  const folder = entries
    .filter((name) => name.startsWith("gsap@"))
    .sort()
    .at(-1);
  if (folder === undefined) throw new Error("the renderer's copy of GSAP was not found");
  await fs.mkdir(toDir, { recursive: true });
  await fs.copyFile(
    path.join(vendor, folder, "dist", "gsap.min.js"),
    path.join(toDir, "gsap.min.js"),
  );
}

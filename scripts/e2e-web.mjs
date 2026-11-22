// End-to-end tests of VidAI Web (SPEC section 12): the debug `vidai-web` server with its real Rust
// core, driven by a real headless Chromium like a user (open the printed address, click, type,
// read the page), against the fake Claude Code the desktop suite uses.
//
//   npm run e2e:web                       every scenario
//   npm run e2e:web -- access start       only the scenarios whose names start with these
//   npm run e2e:web -- --keep             keep the whole work folder (also the Editing Folders)
//   npm run e2e:web -- --no-build         use the existing UI build and debug server as they are
//   npm run e2e:web -- --out <folder>     make the work folder inside <folder> (default: system temp)
//   npm run e2e:web -- --verbose          print the steps a scenario reports
//   npm run e2e:web -- --real             only the scenarios with the real local Claude Code (haiku);
//                                         they never run without this flag, and it runs only them
//
// How it works:
// - dist/ is built when it is older than the sources of the UI, and the debug server
//   (`cargo build --manifest-path src-web/Cargo.toml`) when its sources or the core's are newer.
// - Every scenario gets its own throwaway folder inside one work folder: app data directory
//   (`VIDAI_DATA_DIR`), Editing Folder with tiny generated videos, fake Claude state folder and
//   screenshots. Servers listen on a free port (`--port 0`); keys are in memory
//   (`VIDAI_SECRETS=memory`); `VIDAI_CLAUDE_BIN` is the fake; `VIDAI_WEB_NO_BROWSER=1` makes the
//   server print its address instead of starting a browser. The real data directory is never used.
// - The browser reaches the app only like a user. The test reads the disk and the fake's records to
//   assert, never to do the user's part. Seeding settings before the server starts is allowed.
// - A scenario fails on any console error, uncaught page error, failed request (that it did not say
//   it expects) and Content-Security-Policy violation of its pages. A screenshot (1280x800) is
//   taken at the end of every scenario and at every failure into the work folder.
// - Every server and browser started is ended, also on failure, timeout and Ctrl+C; fake Claude
//   processes left behind fail the scenario.
// - e2e-web-report.json in the work folder lists every scenario with its result, screenshots,
//   issues and notes. The exit code is 1 when any scenario failed.
//
// Needs: Node.js 22, Rust, Playwright's Chromium (`npx playwright install chromium`); ffmpeg for
// playable test videos (else header-only MP4s).
import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { makeMedia } from "./e2e/media.mjs";
import { launchBrowser, createWatch } from "./e2e-web/browser.mjs";
import { stopAll } from "./e2e-web/server.mjs";
import { createTest } from "./e2e-web/world.mjs";
import {
  buildUi,
  cargoBuild,
  newest,
  root,
  run as runInherit,
  targetDirectory,
  uiIsStale,
} from "./web/common.mjs";

const execFile = promisify(execFileCb);
const NAME = "e2e:web";
const fakeClaude = path.join(root, "src-tauri/tests/support/fake-claude.sh");
const fixtures = path.join(root, "src-tauri/tests/fixtures/claude-control");
const scenarioDir = path.join(root, "scripts", "e2e-web", "scenarios");

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`${NAME}: ${message}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
/** @type {string | null} */
let outDir = null;
const outAt = argv.findIndex((a) => a === "--out" || a.startsWith("--out="));
if (outAt >= 0) {
  const arg = argv[outAt] ?? "";
  const inline = arg.startsWith("--out=");
  outDir = inline ? arg.slice("--out=".length) : (argv[outAt + 1] ?? null);
  if (!outDir || outDir.startsWith("--")) fail("--out needs a folder");
  argv.splice(outAt, inline ? 1 : 2);
}
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const only = argv.filter((a) => !a.startsWith("--"));
for (const flag of flags) {
  if (!["--keep", "--no-build", "--verbose", "--real"].includes(flag))
    fail(`Unknown option ${flag}`);
}
const keep = flags.has("--keep");
const verbose = flags.has("--verbose");
const real = flags.has("--real");
if (process.platform !== "darwin") fail("the web end-to-end tests run on macOS for now");

// ---------------------------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------------------------

/** @type {Set<() => Promise<void>>} */
const cleanups = new Set();
let interrupted = false;

async function runCleanups() {
  await stopAll();
  for (const cleanup of [...cleanups]) {
    cleanups.delete(cleanup);
    await cleanup().catch(() => {});
  }
}

for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
  process.on(signal, () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log(`\n${NAME}: ${signal}, ending every server and browser ...`);
    void runCleanups().then(() => process.exit(130));
  });
}

/**
 * Processes whose command line mentions `marker` (the fake Claude Code runs from the work folder).
 * @param {string} marker @returns {Promise<Array<{ pid: number, command: string }>>}
 */
async function belonging(marker) {
  const { stdout } = await execFile("/bin/ps", ["-axo", "pid=,command="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), command: m[2] ?? "" }))
    .filter((p) => p.pid !== process.pid && p.command.includes(marker));
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

/** @returns {Promise<string>} the debug server's path */
async function ensureBuilt() {
  const binary = path.join(await targetDirectory(), "debug", "vidai-web");
  if (flags.has("--no-build")) {
    if (!existsSync(binary)) fail(`no debug server at ${binary}`);
    if (!existsSync(path.join(root, "dist", "index.html"))) fail("no UI build in dist/");
    return binary;
  }
  if (uiIsStale()) await buildUi(NAME);
  const built = newest(binary);
  const inputs = [
    "src-web/src",
    "src-web/Cargo.toml",
    "src-web/Cargo.lock",
    "src-web/build.rs",
    "src-web/capabilities",
    "src-web/tauri.conf.json",
    "src-tauri/src",
    "src-tauri/Cargo.toml",
    "src-tauri/build.rs",
    "src-tauri/capabilities",
    "src-tauri/resources",
  ].map((p) => newest(path.join(root, p)));
  if (built < Math.max(...inputs)) {
    console.log(`${NAME}: building the debug server ...`);
    const build = cargoBuild({ release: false });
    const code = await runInherit(build.command, build.args, build.env);
    if (code !== 0) fail(`cargo build failed (exit ${String(code)})`);
  }
  if (!existsSync(binary)) fail(`cargo did not produce ${binary}`);
  return binary;
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

/** @returns {Promise<import("./e2e-web/types.mjs").Scenario[]>} */
async function loadScenarios() {
  const files = (await readdir(scenarioDir)).filter((f) => f.endsWith(".mjs")).sort();
  /** @type {import("./e2e-web/types.mjs").Scenario[]} */
  const all = [];
  for (const file of files) {
    const module = await import(pathToFileURL(path.join(scenarioDir, file)).href);
    all.push(module.default);
  }
  // The scenarios that use the real Claude Code run with --real and only then.
  const wanted = all.filter((s) => Boolean(s.real) === real);
  return only.length === 0 ? wanted : wanted.filter((s) => only.some((o) => s.name.startsWith(o)));
}

/** The folder the work folder goes into, without links. */
function workParent() {
  const parent = outDir ? path.resolve(outDir) : tmpdir();
  return existsSync(parent) ? realpathSync(parent) : parent;
}

/**
 * @param {Promise<unknown>} promise @param {number} ms @param {string} name
 */
function within(promise, ms, name) {
  /** @type {NodeJS.Timeout} */
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`scenario ${name} did not finish within ${ms / 1000} s`));
    }, ms);
  });
  return Promise.race([promise, limit]).finally(() => {
    clearTimeout(timer);
  });
}

async function main() {
  const scenarios = await loadScenarios();
  if (scenarios.length === 0) fail(`no scenario matches ${only.join(", ")}`);
  const binary = await ensureBuilt();
  await mkdir(workParent(), { recursive: true });
  const work = path.join(
    workParent(),
    `vidai-e2e-web-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await mkdir(path.join(work, "bin"), { recursive: true });
  const claude = path.join(work, "bin", "claude");
  await copyFile(fakeClaude, claude);
  await chmod(claude, 0o755);
  const media = await makeMedia(path.join(work, "media"));
  const browser = await launchBrowser();
  cleanups.add(() => browser.close());
  console.log(`${NAME}: ${scenarios.length} scenario(s), work folder ${work}`);
  if (media !== "ffmpeg") console.log(`${NAME}: no ffmpeg, the test videos are header-only MP4s`);

  /** @type {Array<{ name: string, title: string, result: "passed" | "failed", reason?: string, seconds: number, screenshots: string[], issues: string[], notes: string[] }>} */
  const results = [];
  for (const scenario of scenarios) {
    if (interrupted) break;
    const started = Date.now();
    console.log(`\n  ${scenario.name}: ${scenario.title}`);
    const watch = createWatch();
    /** @type {string[]} */
    const notes = [];
    /** @type {string[]} */
    const shotFiles = [];
    const world = await createTest({
      scenario,
      work,
      binary,
      claude,
      fixtures,
      browser,
      watch,
      log: (text) => {
        if (verbose) console.log(`      ${text}`);
      },
      notes,
      shotFiles,
    });
    /** @type {string} */
    let failure = "";
    try {
      await within(scenario.run(world.t), scenario.timeout ?? 120_000, scenario.name);
      await world.finalShot();
      if (watch.issues.length > 0) {
        throw new Error(`the page reported problems:\n        ${watch.issues.join("\n        ")}`);
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      await world.failureShots();
    }
    await world.closeContexts();
    await stopAll();
    // A picture check that was running when the server ended is allowed a moment to finish.
    /** @type {Array<{ pid: number, command: string }>} */
    let leftovers = await belonging(work);
    for (let wait = 0; wait < 50 && leftovers.length > 0; wait++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      leftovers = await belonging(work);
    }
    if (leftovers.length > 0) {
      for (const p of leftovers) process.kill(p.pid, "SIGKILL");
      failure ||= `processes were left behind:\n        ${leftovers.map((p) => `${p.pid} ${p.command}`).join("\n        ")}`;
    }
    if (!failure && !keep) {
      // Keep the screenshots; the rest of the scenario's folder is only needed to debug.
      for (const entry of ["Editing", "data", "fake"]) {
        await rm(path.join(world.t.dir, entry), { recursive: true, force: true });
      }
    }
    const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    console.log(
      failure
        ? `  FAIL ${scenario.name} (${seconds} s)\n      ${failure}`
        : `  PASS ${scenario.name} (${seconds} s, ${shotFiles.length} screenshots)`,
    );
    results.push({
      name: scenario.name,
      title: scenario.title,
      result: failure ? "failed" : "passed",
      ...(failure ? { reason: failure } : {}),
      seconds,
      screenshots: shotFiles,
      issues: watch.issues,
      notes,
    });
  }
  await runCleanups();
  const failed = results.filter((r) => r.result === "failed");
  await writeFile(
    path.join(work, "e2e-web-report.json"),
    JSON.stringify(
      { media, startedAt: path.basename(work).replace(/^vidai-e2e-web-/, ""), results },
      null,
      2,
    ),
  );
  console.log(
    `\n${NAME}: ${results.length - failed.length} passed, ${failed.length} failed. Screenshots, logs and e2e-web-report.json: ${work}`,
  );
  if (failed.length === 0 && !keep) {
    for (const entry of ["media", "bin"]) await rm(path.join(work, entry), { recursive: true });
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(
    `${NAME}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  await runCleanups();
  process.exit(1);
});

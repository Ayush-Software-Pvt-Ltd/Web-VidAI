#!/usr/bin/env node
// The end-to-end suite of the VidAI server (`npm run e2e:server`): the real server (HTTPS, SQLite,
// RPC, events) on a free port with a throwaway data folder and a fake Claude Code, driven by
// headless Chromium through the built UI.
//
//   npm run e2e:server -- [scenario-name-prefix ...] [--no-build] [--keep] [--verbose]
//                         [--out <folder>] [--timeout <seconds per step>]
//
// Scenarios are the files of `scenarios/` (`export const name`, `export async function run(ctx)`).
// One line is printed per step; a run ends with PASS or FAIL, writes `e2e-report.json` into the
// work folder and always stops the server and the browser, also on a failure and on Ctrl+C.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { REPO, makeWorld, startServer } from "./world.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {object} StepResult
 * @property {string} name
 * @property {"ok" | "fail" | "skip"} state
 * @property {number} ms
 * @property {string} [note] Why it was skipped, or the failure.
 *
 * @typedef {object} Context
 * @property {string} base The server's address.
 * @property {Awaited<ReturnType<typeof makeWorld>>} world
 * @property {() => Promise<import("playwright").Page>} newPage A page of a fresh browser context.
 * @property {<T>(name: string, fn: () => Promise<T>) => Promise<T>} step Runs one step; a failure
 *   ends the scenario.
 * @property {(name: string, why: string) => void} skip Records a step that cannot run here.
 * @property {(text: string) => void} note Prints a line that is not a step.
 */

/** @param {string[]} argv */
function parseArguments(argv) {
  const options = {
    build: true,
    keep: false,
    verbose: false,
    out: /** @type {string | null} */ (null),
    stepTimeout: 30,
    prefixes: /** @type {string[]} */ ([]),
  };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] ?? "";
    if (word === "--no-build") options.build = false;
    else if (word === "--keep") options.keep = true;
    else if (word === "--verbose") options.verbose = true;
    else if (word === "--out") options.out = path.resolve(argv[++i] ?? "");
    else if (word === "--timeout") options.stepTimeout = Number(argv[++i]);
    else if (word.startsWith("--")) throw new Error(`Unknown option ${word}.`);
    else options.prefixes.push(word);
  }
  if (options.out === "") throw new Error("--out needs a folder.");
  if (!Number.isFinite(options.stepTimeout) || options.stepTimeout <= 0) {
    throw new Error("--timeout needs a number of seconds.");
  }
  return options;
}

/** @param {string[]} prefixes */
async function loadScenarios(prefixes) {
  const dir = path.join(HERE, "scenarios");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".mjs"))
    .sort();
  const all = await Promise.all(
    files.map(async (file) => {
      /** @type {{ name: string, run: (ctx: Context) => Promise<void> }} */
      const module = await import(pathToFileURL(path.join(dir, file)).href);
      return module;
    }),
  );
  return all.filter((s) => prefixes.length === 0 || prefixes.some((p) => s.name.startsWith(p)));
}

/** @param {number} ms */
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** @param {unknown} error */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/** Marks a failure that was reported already (the scenario stops, the run goes on). */
class StepFailed extends Error {}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const scenarios = await loadScenarios(options.prefixes);
  if (scenarios.length === 0) throw new Error(`No scenario matches ${options.prefixes.join(" ")}.`);

  if (options.build) {
    process.stdout.write("building the UI (npm run build) ...\n");
    const built = spawnSync("npm", ["run", "build", "--silent"], { cwd: REPO, encoding: "utf8" });
    if (built.status !== 0) {
      const text = `${built.stdout}${built.stderr}`.trim().split("\n").slice(-15).join("\n");
      throw new Error(
        `The UI build failed (use --no-build to run against dist/ as it is):\n${text}`,
      );
    }
  } else if (!fs.existsSync(path.join(REPO, "dist", "index.html"))) {
    throw new Error("dist/ is missing: run without --no-build once.");
  }

  const world = await makeWorld(options.out ? { out: options.out } : {});
  process.stdout.write(`work folder: ${world.root}\n`);
  process.stdout.write(
    `A-roll: ${world.aroll}; renderer: ${world.renderer.ok ? "available" : `not available (${world.renderer.note})`}\n`,
  );

  /** @type {Awaited<ReturnType<typeof startServer>> | null} */
  let server = null;
  /** @type {import("playwright").Browser | null} */
  let browser = null;
  let stopping = false;
  /** Ends the browser and the server; safe to call twice. */
  async function cleanup() {
    if (stopping) return;
    stopping = true;
    await browser?.close().catch(() => {});
    await server?.stop().catch(() => {});
  }
  process.on("exit", () => {
    server?.killNow();
  });
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
    process.on(signal, () => {
      process.stdout.write(`\n${signal}: stopping the browser and the server ...\n`);
      void cleanup().then(() => process.exit(130));
    });
  }

  const report = {
    startedAt: new Date().toISOString(),
    ok: false,
    workFolder: world.root,
    base: "",
    scenarios:
      /** @type {Array<{ name: string, ok: boolean, ms: number, steps: StepResult[] }>} */ ([]),
    issues: /** @type {string[]} */ ([]),
  };
  const startedAt = Date.now();
  let failed = false;
  try {
    server = await startServer(world, { verbose: options.verbose });
    report.base = server.base;
    browser = await chromium.launch({ headless: true });
    const shots = path.join(world.root, "screenshots");
    fs.mkdirSync(shots, { recursive: true });

    for (const scenario of scenarios) {
      process.stdout.write(`\n${scenario.name}\n`);
      /** @type {StepResult[]} */
      const steps = [];
      /** @type {import("playwright").Page[]} */
      const pages = [];
      const began = Date.now();
      /** @type {Context} */
      const ctx = {
        base: server.base,
        world,
        async newPage() {
          const context = await /** @type {import("playwright").Browser} */ (browser).newContext({
            ignoreHTTPSErrors: true,
            viewport: { width: 1280, height: 800 },
            deviceScaleFactor: 1,
          });
          context.setDefaultTimeout(options.stepTimeout * 1000);
          const page = await context.newPage();
          watch(page, report.issues, options.verbose);
          pages.push(page);
          return page;
        },
        async step(stepName, fn) {
          const at = Date.now();
          try {
            const value = await fn();
            const ms = Date.now() - at;
            steps.push({ name: stepName, state: "ok", ms });
            process.stdout.write(`  ok    ${stepName} (${seconds(ms)})\n`);
            return value;
          } catch (error) {
            // Ctrl+C closed the browser under the step: the step did not fail by itself.
            if (stopping) throw new StepFailed(stepName);
            const ms = Date.now() - at;
            const note = messageOf(error).split("\n").slice(0, 12).join("\n");
            steps.push({ name: stepName, state: "fail", ms, note });
            process.stdout.write(`  FAIL  ${stepName} (${seconds(ms)})\n`);
            for (const line of note.split("\n")) process.stdout.write(`        ${line}\n`);
            await Promise.all(
              pages.map((page, i) =>
                page
                  .screenshot({ path: path.join(shots, `${scenario.name}-fail-${i + 1}.png`) })
                  .catch(() => {}),
              ),
            );
            throw new StepFailed(stepName);
          }
        },
        skip(stepName, why) {
          steps.push({ name: stepName, state: "skip", ms: 0, note: why });
          process.stdout.write(`  skip  ${stepName} - ${why}\n`);
        },
        note(text) {
          process.stdout.write(`        ${text}\n`);
        },
      };
      let ok = true;
      try {
        await scenario.run(ctx);
      } catch (error) {
        ok = false;
        if (!(error instanceof StepFailed)) {
          steps.push({ name: "(scenario)", state: "fail", ms: 0, note: messageOf(error) });
          process.stdout.write(`  FAIL  (scenario) ${messageOf(error)}\n`);
        }
      }
      report.scenarios.push({ name: scenario.name, ok, ms: Date.now() - began, steps });
      if (!ok) failed = true;
    }
    if (report.issues.length > 0) {
      process.stdout.write(`\nbrowser problems seen (${report.issues.length}):\n`);
      for (const issue of report.issues.slice(0, 20)) process.stdout.write(`  ${issue}\n`);
      failed = true;
    }
    if (failed && options.verbose) process.stdout.write(`\nserver log:\n${server.tail()}\n`);
  } catch (error) {
    failed = true;
    process.stdout.write(`\n${messageOf(error)}\n`);
  } finally {
    await cleanup();
    report.ok = !failed;
    fs.writeFileSync(
      path.join(world.root, "e2e-report.json"),
      `${JSON.stringify({ ...report, ms: Date.now() - startedAt }, null, 2)}\n`,
    );
  }

  process.stdout.write(`\n${failed ? "FAIL" : "PASS"} (${seconds(Date.now() - startedAt)})\n`);
  if (options.keep || options.out || failed) {
    process.stdout.write(`work folder kept: ${world.root} (report: e2e-report.json)\n`);
  } else {
    fs.rmSync(world.root, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}

/**
 * Collects what a person's console would show as a problem: console errors, uncaught page
 * errors, failed requests and answers of status 400 or more.
 * @param {import("playwright").Page} page
 * @param {string[]} issues
 * @param {boolean} verbose
 */
function watch(page, issues, verbose) {
  /** @param {string} text */
  const add = (text) => {
    issues.push(text);
    if (verbose) process.stdout.write(`        browser: ${text}\n`);
  };
  page.on("console", (message) => {
    if (message.type() === "error") add(`console error: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    add(`page error: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    // The event stream ends with a navigation, a closed page or a stopped server.
    if (request.url().endsWith("/api/events") || page.isClosed()) return;
    add(`failed request: ${request.method()} ${request.url()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      add(`status ${response.status()}: ${response.request().method()} ${response.url()}`);
    }
  });
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${messageOf(error)}\n`);
    process.exit(2);
  },
);

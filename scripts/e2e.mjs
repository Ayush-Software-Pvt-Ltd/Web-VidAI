// End-to-end tests of the real VidAI app: the debug build, its real Rust backend and real
// window, driven through the DOM like a user, against a fake Claude Code. Runs on macOS and on
// Windows.
//
//   npm run e2e                        every scenario with the fake Claude Code
//   npm run e2e -- start-editing stop  only these scenarios (names or name prefixes)
//   npm run e2e -- --real              the one smoke scenario with the real local Claude Code (macOS)
//   npm run e2e -- --keep              keep the whole work folder (also the Editing Folders)
//   npm run e2e -- --no-build          use the existing debug build as it is
//   npm run e2e -- --require-screenshots  fail when the window cannot be captured
//   npm run e2e -- --out <folder>      make the work folder inside <folder> (default: system temp)
//   npm run e2e -- --target x86_64-apple-darwin  the Intel debug build (under Rosetta 2 on Apple
//                                      Silicon); also aarch64-apple-darwin, universal-apple-darwin
//                                      or the short names x64, arm64, universal (macOS only)
//
// How it works:
// - The debug build contains a hook (src-tauri/src/e2e.rs, compiled only with debug assertions)
//   that is inactive unless VIDAI_E2E_SCRIPT is set. It evaluates that script in the main
//   webview once the page has loaded, appends every report the page emits to VIDAI_E2E_REPORT,
//   hands lines from the app's stdin to the page, and answers file dialogs with queued paths.
// - The script is scripts/e2e/page/harness.js (user-like DOM helpers) plus one scenario step
//   from scripts/e2e/scenarios/. The step asks the runner for screenshots, disk checks and fake
//   Claude controls through reports, and gets the answers through stdin.
// - Every scenario gets its own app data folder, Editing Folder with tiny generated videos, and
//   fake Claude state folder, all inside one throwaway work folder.
// - What differs between macOS and Windows (building and finding the app, its window,
//   screenshots, the clipboard, real key presses, the process list) is behind one small interface,
//   scripts/e2e/macos/platform.mjs and scripts/e2e/windows/platform.mjs. What the interface looks
//   like on each platform (shortcut key, wording) is in scripts/e2e/interface.mjs.
// - Screenshots capture only the VidAI window, never the screen. They are a visual record, not an
//   assertion. On macOS the hook makes the window join every Space, also the one of an app in
//   full screen, so it is normally always on screen, and keeps its page running while the
//   person's own windows cover it (WebKit would count a covered page as hidden and stop its
//   animations, so menus and dialogs would never finish closing). Should it not be on screen (while
//   the screen is locked) the shot is skipped and the run says so, because every functional check
//   goes through the DOM and the disk. --require-screenshots makes a skipped shot a failure, for
//   runs whose purpose is the visual record.
// - Quitting must leave no process behind: the processes of the app's tree that ran last are
//   checked after the app has quit by itself.
// - On Windows every top-level window that shows up while the app runs is recorded, and a console
//   window fails the scenario (SPEC section 11: no console window may flash up).
// - The app and everything it started are always ended, also on failure, timeout or Ctrl+C.
// - The run writes e2e-report.json into the work folder: every scenario with its result (passed,
//   failed with the reason, or skipped on this platform with the reason), its screenshots and the
//   windows seen.
//
// Needs: Node.js; macOS: Xcode command line tools (swiftc), ffmpeg (else header-only test videos);
// Windows: Git for Windows (Git Bash runs the fake Claude Code).
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { currentInterface } from "./e2e/interface.mjs";
import { apiOptions } from "./e2e/library.mjs";
import { makeMedia } from "./e2e/media.mjs";
import { MAC_TARGETS, macTarget, root } from "./mac-targets.mjs";

const e2eDir = path.join(root, "scripts", "e2e");
const fakeClaude = path.join(root, "src-tauri/tests/support/fake-claude.sh");
const controlFixtures = path.join(root, "src-tauri/tests/fixtures/claude-control");
const cacheDir = path.join(root, "node_modules/.cache/vidai-e2e");
const tauriCli = path.join(root, "node_modules/@tauri-apps/cli/tauri.js");
/**
 * The debug app is built with its own bundle id, so the OS never mistakes it for an installed
 * VidAI that may be running at the same time: on macOS `open` (the Dock reopen of scenario 09)
 * reaches the test app, and notifications or Launch Services state of the real app are never
 * touched; on Windows its WebView2 data and its single-instance lock are its own.
 */
const E2E_BUNDLE_ID = "com.vidai.desktop.e2e";
const isWindows = process.platform === "win32";

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`e2e: ${message}`);
  process.exit(2);
}

/** `--<name> <value>` / `--<name>=<value>`, taken out of the arguments. */
function takeOption(/** @type {string[]} */ args, /** @type {string} */ name) {
  const at = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (at < 0) return null;
  const arg = args[at] ?? "";
  const inline = arg.startsWith(`--${name}=`);
  const value = inline ? arg.slice(`--${name}=`.length) : args[at + 1];
  if (!value || value.startsWith("--")) fail(`--${name} needs a value`);
  args.splice(at, inline ? 1 : 2);
  return value;
}

const argv = process.argv.slice(2);
const targetName = takeOption(argv, "target");
const outDir = takeOption(argv, "out");
/** The Mac target of the debug build to test, or `null` for the host's own build. */
const target =
  targetName === null
    ? null
    : (macTarget(targetName) ??
      fail(
        `unknown target ${targetName} (use one of ${Object.values(MAC_TARGETS)
          .map((t) => t.triple)
          .join(", ")})`,
      ));
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const only = argv.filter((a) => !a.startsWith("--"));
const real = flags.has("--real");
const keep = flags.has("--keep");
const verbose = flags.has("--verbose");
const requireScreenshots = flags.has("--require-screenshots");
for (const flag of flags) {
  if (!["--real", "--keep", "--verbose", "--no-build", "--require-screenshots"].includes(flag)) {
    fail(`Unknown option ${flag}`);
  }
}
if (process.platform !== "darwin" && !isWindows) fail("the end-to-end tests need macOS or Windows");
if (isWindows && target) fail("--target is for the Mac builds");
if (isWindows && real) fail("--real runs on macOS only");

/** @type {import("./e2e/types.mjs").Platform} */
const platform = isWindows
  ? (await import("./e2e/windows/platform.mjs")).createPlatform({
      cacheDir,
      identifier: E2E_BUNDLE_ID,
    })
  : (await import("./e2e/macos/platform.mjs")).createPlatform({
      cacheDir,
      identifier: E2E_BUNDLE_ID,
      target,
    });
const ui = currentInterface();
const scaled = (/** @type {number} */ ms) => Math.round(ms * platform.timeScale);

// ---------------------------------------------------------------------------------------------
// Cleanup that always runs
// ---------------------------------------------------------------------------------------------

/** @type {Set<() => Promise<void>>} */
const cleanups = new Set();
let interrupted = false;

async function runCleanups() {
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch (error) {
      console.error(`e2e: cleanup failed: ${String(error)}`);
    }
    cleanups.delete(cleanup);
  }
}

for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = true;
    console.error(`\ne2e: ${signal}, ending the app and its processes`);
    void runCleanups()
      .then(() => platform.stop())
      .finally(() => process.exit(130));
  });
}

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

/** @typedef {import("./e2e/types.mjs").Proc} Proc */

/** Whether a command line mentions the work folder (also as Git Bash writes Windows paths). */
function mentions(/** @type {string} */ command, /** @type {string} */ marker) {
  if (!isWindows) return command.includes(marker);
  const norm = (/** @type {string} */ s) => s.toLowerCase().replaceAll("\\", "/");
  const m = norm(marker);
  const msys = m.replace(/^([a-z]):\//, "/$1/");
  const c = norm(command);
  return c.includes(m) || c.includes(msys);
}

/**
 * The processes started by `pid`, directly or not (across process groups, like the app's own
 * ProcessTree), with `pid` itself. A child on Windows must have started after its parent: the id
 * of a parent that ended may already belong to an unrelated, newer process.
 * @param {Proc[]} procs @param {number} pid
 */
function treeOf(procs, pid) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const members = new Set(byPid.has(pid) ? [pid] : []);
  const groups = new Set();
  for (;;) {
    const before = members.size;
    for (const p of procs) {
      const parent = byPid.get(p.ppid);
      const childOf =
        members.has(p.ppid) &&
        (p.started === null || parent?.started == null || p.started >= parent.started);
      if (childOf || (p.pgid !== null && groups.has(p.pgid) && p.pgid > 1)) members.add(p.pid);
    }
    for (const p of procs) if (members.has(p.pid) && p.pgid === p.pid) groups.add(p.pgid);
    if (members.size === before) break;
  }
  return procs.filter((p) => members.has(p.pid));
}

/**
 * Every process that belongs to the app run: the tree of `pid`, and anything whose command line
 * mentions the work folder (with their trees).
 * @param {number | null} pid @param {string} marker
 */
async function belonging(pid, marker) {
  const procs = await platform.processes();
  const me = process.pid;
  const roots = procs.filter((p) => p.pid !== me && mentions(p.command, marker)).map((p) => p.pid);
  if (pid !== null) roots.push(pid);
  const members = new Map();
  for (const root of roots) for (const p of treeOf(procs, root)) members.set(p.pid, p);
  members.delete(me);
  return [...members.values()];
}

/** @param {number[]} pids */
function killAll(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which processes of an earlier snapshot still run (the same process: on Windows it started at
 * the same time, elsewhere it has the same command line).
 * @param {Proc[]} snapshot
 */
async function survivors(snapshot) {
  const now = new Map((await platform.processes()).map((p) => [p.pid, p]));
  return snapshot.filter((p) => {
    const same = now.get(p.pid);
    if (!same) return false;
    return p.started !== null ? same.started === p.started : same.command === p.command;
  });
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ends the app process and every process of the run.
 * @param {number | null} pid @param {string} marker
 */
async function endEverything(pid, marker) {
  const before = await belonging(pid, marker);
  killAll(before.map((p) => p.pid));
  for (let i = 0; i < 50; i++) {
    const left = await belonging(null, marker);
    if (left.length === 0 && (pid === null || !isAlive(pid))) return;
    killAll(left.map((p) => p.pid));
    await sleep(100);
  }
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

/** Newest modification time below `dir` (files only). @param {string} dir */
function newest(dir) {
  if (!existsSync(dir)) return 0;
  const info = statSync(dir);
  if (!info.isDirectory()) return info.mtimeMs;
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "target" || entry.name.startsWith(".")) {
      continue;
    }
    latest = Math.max(latest, newest(path.join(dir, entry.name)));
  }
  return latest;
}

async function ensureApp() {
  const inputs = [
    "src",
    "index.html",
    "package.json",
    "vite.config.ts",
    "src-tauri/src",
    "src-tauri/Cargo.toml",
    "src-tauri/tauri.conf.json",
    "src-tauri/build.rs",
    "src-tauri/capabilities",
    "src-tauri/resources",
    ...platform.buildInputs,
  ].map((p) => newest(path.join(root, p)));
  const built = platform.builtAt();
  if (flags.has("--no-build")) {
    if (!built) fail(`no end-to-end debug build at ${platform.appBinary}`);
  } else if (built < Math.max(...inputs)) {
    await buildApp();
  }
  try {
    await platform.checkBuild();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function buildApp() {
  /** @type {string[]} */
  let args;
  try {
    args = await platform.buildArgs();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  console.log(`e2e: building the debug app (tauri ${args.join(" ")}) ...`);
  const started = Date.now();
  const log = path.join(cacheDir, `build-${target?.triple ?? platform.name}.log`);
  await mkdir(cacheDir, { recursive: true });
  const fd = openSync(log, "w");
  const code = await new Promise((resolve) => {
    // The Tauri CLI's own script, run by this Node: no shell, the same on every platform.
    const child = spawn(process.execPath, [tauriCli, ...args], {
      cwd: root,
      stdio: ["ignore", fd, fd],
    });
    cleanups.add(async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
    child.on("exit", resolve);
  });
  closeSync(fd);
  if (code !== 0) {
    const tail = readFileSync(log, "utf8").split("\n").slice(-30).join("\n");
    fail(`the debug build failed (exit ${String(code)}), see ${log}:\n${tail}`);
  }
  await platform.afterBuild();
  console.log(`e2e: built in ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

// ---------------------------------------------------------------------------------------------
// Fake Claude state
// ---------------------------------------------------------------------------------------------

/** @param {string} fakeDir @returns {Promise<import("./e2e/types.mjs").FakeCall[]>} */
async function fakeCalls(fakeDir) {
  const order = existsSync(path.join(fakeDir, "calls"))
    ? (await readFile(path.join(fakeDir, "calls"), "utf8")).split("\n").filter(Boolean)
    : [];
  /** @type {import("./e2e/types.mjs").FakeCall[]} */
  const calls = [];
  for (const pid of order) {
    const info = await readFile(path.join(fakeDir, `call.${pid}`), "utf8").catch(() => "");
    const stdin = await readFile(path.join(fakeDir, `in.${pid}`), "utf8").catch(() => "");
    /** @type {Record<string, string>} */
    const fields = {};
    for (const line of info.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1);
    }
    const lines = stdin.split("\n").filter(Boolean);
    const messages = [];
    for (const line of lines) {
      try {
        const json = JSON.parse(line);
        if (json.type === "user") {
          messages.push(
            json.message.content.map((/** @type {{ text?: string }} */ c) => c.text ?? "").join(""),
          );
        }
      } catch {
        // not JSON
      }
    }
    calls.push({
      pid: Number(pid),
      mode: fields.mode ?? "",
      sid: fields.sid ?? "",
      args: fields.args ?? "",
      cwd: fields.cwd ?? "",
      env: {
        // What points Claude Code at an Anthropic compatible API (SPEC section 7a).
        ...Object.fromEntries(
          [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
          ].map((name) => [name, fields[name] ?? ""]),
        ),
      },
      messages,
      stdin: lines,
    });
  }
  return calls;
}

// ---------------------------------------------------------------------------------------------
// One scenario
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} RunContext
 * @property {string} shots
 * @property {number} shotCount
 * @property {number} skippedShots
 * @property {string[]} shotFiles
 * @property {number | null} pid
 * @property {string[]} notifications
 * @property {string[]} pageErrors
 * @property {any[]} windowsSeen
 * @property {string[]} notes
 * @property {NodeJS.ProcessEnv} appEnv the environment of the running app
 */

/** Resolves `rel` inside the scenario folder; refuses anything outside it. */
function inside(/** @type {string} */ dir, /** @type {string} */ rel) {
  const full = path.resolve(dir, rel);
  if (full !== dir && !full.startsWith(dir + path.sep)) {
    throw new Error(`path outside the scenario folder: ${rel}`);
  }
  return full;
}

/**
 * Whether the current scenario found its window off screen. A hidden webview does not run
 * animation frames, so menus, popovers and images may never appear: a failure in that state
 * says more about the screen than about the app, and the failure message points that out.
 */
let windowOffScreen = false;

/** The clipboard file while a copy test runs (null when nothing is saved). @type {string | null} */
let savedClipboard = null;

async function restoreClipboard() {
  if (savedClipboard === null) return;
  const file = savedClipboard;
  savedClipboard = null;
  await platform.clipboardRestore(file);
}

/** @typedef {import("./e2e/types.mjs").Context & RunContext} FullContext */

/** Built-in runner operations for the steps. */
const builtinOps = {
  /** @param {FullContext} ctx @param {{ name: string }} args */
  async shot(ctx, args) {
    const pid = ctx.pid;
    if (pid === null) throw new Error("the app is not running");
    const safe = args.name.replace(/[^a-z0-9-]+/gi, "-");
    const file = path.join(ctx.shots, `${String(ctx.shotCount + 1).padStart(2, "0")}-${safe}.png`);
    // The window server can miss a window for a moment: while it is being ordered front, and
    // while the person switches Spaces (the window joins every Space, after the animation). It
    // can also fail to make an image of a window it lists at that very moment. So both the
    // lookup and the capture are tried again for 5 s.
    let lastError = null;
    for (let i = 0; i < 50; i++) {
      if (i > 0) await sleep(100);
      const window = await platform.findWindow(pid);
      if (!window) continue;
      try {
        const method = await platform.capture(window, file);
        if (verbose) console.log(`      shot ${path.basename(file)} (${method})`);
      } catch (error) {
        lastError = error;
        continue;
      }
      ctx.shotCount += 1;
      ctx.shotFiles.push(path.relative(path.dirname(ctx.dir), file));
      return { file, bounds: window.bounds };
    }
    if (lastError) throw lastError;
    if (!(await platform.findWindow(pid, true))) throw new Error("the VidAI window does not exist");
    if (requireScreenshots) {
      throw new Error("the VidAI window is not on screen (is the screen locked or asleep?)");
    }
    ctx.skippedShots += 1;
    windowOffScreen = true;
    return { file: null, bounds: [] };
  },
  /** Window id and bounds, or null when the window is not on screen. */
  async window(/** @type {FullContext} */ ctx) {
    if (ctx.pid === null) return null;
    const window = await platform.findWindow(ctx.pid);
    return window
      ? { id: window.id, bounds: window.bounds, foreground: window.info?.foreground ?? null }
      : null;
  },
  /** @param {import("./e2e/types.mjs").Context} ctx @param {{ path: string }} args */
  async exists(ctx, args) {
    return existsSync(inside(ctx.dir, args.path));
  },
  /** @param {import("./e2e/types.mjs").Context} ctx @param {{ path: string }} args */
  async list(ctx, args) {
    const full = inside(ctx.dir, args.path);
    return existsSync(full) ? (await readdir(full)).sort() : null;
  },
  /** @param {import("./e2e/types.mjs").Context} ctx @param {{ path: string }} args */
  async read(ctx, args) {
    return readFile(inside(ctx.dir, args.path), "utf8");
  },
  /** @param {import("./e2e/types.mjs").Context} ctx @param {{ path: string, content: string }} args */
  async write(ctx, args) {
    const full = inside(ctx.dir, args.path);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, args.content);
    return true;
  },
  /** @param {import("./e2e/types.mjs").Context} ctx @param {{ path: string }} args */
  async remove(ctx, args) {
    await rm(inside(ctx.dir, args.path), { force: true, recursive: true });
    return true;
  },
  /** Waits until a file exists. @param {import("./e2e/types.mjs").Context} ctx @param {{ path: string, timeout?: number }} args */
  async waitFile(ctx, args) {
    const full = inside(ctx.dir, args.path);
    const deadline = Date.now() + scaled(args.timeout ?? 15_000);
    while (!existsSync(full)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for the file ${args.path}`);
      await sleep(50);
    }
    return true;
  },
  /**
   * Writes a file in the fake Claude's state folder (scenario switches, releases). The fakes
   * notice it within a second: nothing writes into their wake-up FIFOs, which Windows programs
   * cannot open (tests/support/mod.rs, `wake_fakes`).
   */
  async fake(
    /** @type {import("./e2e/types.mjs").Context} */ ctx,
    /** @type {{ name: string, content?: string, remove?: boolean }} */ args,
  ) {
    const full = inside(ctx.fake, args.name);
    if (args.remove) await rm(full, { force: true });
    else await writeFile(full, args.content ?? "");
    return true;
  },
  /** Every fake Claude process so far. */
  async fakeCalls(/** @type {import("./e2e/types.mjs").Context} */ ctx) {
    return ctx.fakeCalls();
  },
  /** Which of these process ids (of this OS) are still alive. @param {unknown} _ctx @param {{ pids: number[] }} args */
  async alive(_ctx, args) {
    return args.pids.filter(isAlive);
  },
  /** Which of these process ids reported by the fake Claude (`$$`, `$!`) are still alive. */
  async fakeAlive(/** @type {unknown} */ _ctx, /** @type {{ pids: number[] }} */ args) {
    return platform.fakeAlive(args.pids);
  },
  /** The app's process tree now (without the app itself). */
  async processTree(/** @type {FullContext} */ ctx) {
    if (ctx.pid === null) return [];
    const pid = ctx.pid;
    return treeOf(await platform.processes(), pid).filter((p) => p.pid !== pid);
  },
  /** Which processes of an earlier `processTree` still run. @param {unknown} _ctx @param {{ procs: Proc[] }} args */
  async survivors(_ctx, args) {
    return survivors(args.procs);
  },
  /** Notifications the app showed so far (captured by the hook). */
  async notifications(/** @type {RunContext} */ ctx) {
    return ctx.notifications;
  },
  /** Sends a line to the app's stdin hook (`!close`, `!quit`). Set by `launchApp`. */
  async stdin() {
    throw new Error("not running");
  },
  /**
   * Saves the user's clipboard (every item and type, exactly) before a copy test; it is put back
   * by `clipboardRestore`, and by the cleanup if the run fails first.
   */
  async clipboardSave(/** @type {import("./e2e/types.mjs").Context} */ ctx) {
    const file = path.join(ctx.dir, "clipboard.saved");
    await platform.clipboardSave(file);
    savedClipboard = file;
    cleanups.add(restoreClipboard);
    return true;
  },
  /** The plain text on the clipboard now. */
  async clipboardRead() {
    return platform.clipboardText();
  },
  async clipboardRestore() {
    await restoreClipboard();
    cleanups.delete(restoreClipboard);
    return true;
  },
  /**
   * Covers the app's window with an opaque window of the runner, as the person's own windows do
   * while the suite runs; taken away by `uncover`, and at the latest when the launch ends.
   * @param {FullContext} ctx
   */
  async cover(ctx) {
    if (ctx.pid === null) throw new Error("the app is not running");
    return platform.cover(ctx.pid);
  },
  async uncover() {
    await platform.uncover();
    return true;
  },
  /** Asks macOS to reopen the app, like a click on its Dock icon (without activating it). */
  async reopen() {
    await platform.reopen();
    return true;
  },
  /**
   * A real key press through the OS into the app's window (Windows; on macOS the hook posts them,
   * `host.native("key")`). @param {FullContext} ctx
   * @param {{ key: string, ctrl?: boolean, shift?: boolean, alt?: boolean }} args
   */
  async pressKey(ctx, args) {
    if (ctx.pid === null) throw new Error("the app is not running");
    const { key, ...modifiers } = args;
    await platform.pressKey(ctx.pid, key, modifiers);
    return true;
  },
  /** A real mouse drag in screen pixels (Windows). @param {FullContext} ctx @param {{ from: number[], to: number[] }} args */
  async drag(ctx, args) {
    if (ctx.pid === null) throw new Error("the app is not running");
    return platform.drag(ctx.pid, args.from, args.to);
  },
  /**
   * A real click at a point of the window's client area, in pixels (Windows).
   * @param {FullContext} ctx @param {{ at: number[], button?: "left" | "right" }} args
   */
  async click(ctx, args) {
    if (ctx.pid === null) throw new Error("the app is not running");
    return platform.click(ctx.pid, args.at, args.button ?? "left");
  },
  /** A real turn of the mouse wheel (Windows). @param {FullContext} ctx @param {{ at: number[], delta: number, ctrl?: boolean }} args */
  async wheel(ctx, args) {
    if (ctx.pid === null) throw new Error("the app is not running");
    return platform.wheel(ctx.pid, args.at, args.delta, Boolean(args.ctrl));
  },
  /** Whether the system is in dark mode (what the "System" theme must follow). */
  async systemDark() {
    return platform.systemDark();
  },
  /**
   * Starts the app a second time, with the same data folder but without the hook, and waits up
   * to 15 s for it to end by itself (single instance). One that does not end is ended here.
   * With `fromForeground`, the runner's helper starts it while its cover window is the foreground
   * window (Windows), as Explorer starts a program on a click in the Start menu; otherwise this
   * Node process starts it, which never has the foreground.
   * @param {FullContext} ctx @param {{ fromForeground?: boolean } | null} args
   */
  async secondInstance(ctx, args) {
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...ctx.appEnv };
    delete env.VIDAI_E2E_SCRIPT;
    delete env.VIDAI_E2E_REPORT;
    if (args?.fromForeground) {
      // Only what differs from the runner's own environment, which the helper has too.
      /** @type {Record<string, string | null>} */
      const changes = { VIDAI_E2E_SCRIPT: null, VIDAI_E2E_REPORT: null };
      for (const [key, value] of Object.entries(env)) {
        if (value !== undefined && process.env[key] !== value) changes[key] = value;
      }
      return platform.startFromForeground(platform.appBinary, ctx.dir, changes, scaled(15_000));
    }
    const child = spawn(platform.appBinary, [], { cwd: ctx.dir, env, stdio: "ignore" });
    const started = Date.now();
    /** @type {number | null} */
    let code = null;
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), scaled(15_000));
      child.on("exit", (c) => {
        clearTimeout(timer);
        code = c;
        resolve(true);
      });
    });
    if (!exited && child.pid !== undefined) await endEverything(child.pid, "\0");
    return { exited, code, ms: Date.now() - started };
  },
};

/**
 * The source of a function as an expression (a method like `async page(ui) {}` is not one).
 * @param {Function} fn
 */
function asExpression(fn) {
  const source = fn.toString();
  if (/^(async\s+)?(function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(source)) return source;
  return `({ ${source} })[${JSON.stringify(fn.name)}]`;
}

/** Window classes of console windows (conhost, Windows Terminal). */
const CONSOLE_CLASSES = ["ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS"];

/**
 * Runs one launch of the app with one step. Resolves when the step is done and the app has
 * ended (quit by the step, or ended here).
 * @param {import("./e2e/types.mjs").Scenario} scenario
 * @param {FullContext} ctx
 * @param {import("./e2e/types.mjs").Launch} launch
 * @param {number} index
 * @param {number} deadline
 */
async function runLaunch(scenario, ctx, launch, index, deadline) {
  const harness = await readFile(path.join(e2eDir, "page/harness.js"), "utf8");
  const params = { ...ctx.params, platform: ui, timeScale: platform.timeScale };
  // Functions the steps of a scenario share run in the page too: `window.__vidaiShared`.
  const shared = Object.entries(scenario.shared ?? {})
    .map(([name, fn]) => `${JSON.stringify(name)}: ${asExpression(fn)}`)
    .join(",\n");
  const script = `${harness}\nwindow.__vidaiShared = {${shared}};\nwindow.__vidaiE2E.run(${JSON.stringify(params)}, ${asExpression(launch.page)});\n`;
  // A syntax error would only show as a silent page; catch it here.
  new vm.Script(script, { filename: `${scenario.name} step ${index}` });
  const scriptFile = path.join(ctx.dir, `step-${index}.js`);
  const reportFile = path.join(ctx.dir, `report-${index}.jsonl`);
  const logFile = path.join(ctx.dir, `app-${index}.log`);
  await writeFile(scriptFile, script);
  await writeFile(reportFile, "");
  const logFd = openSync(logFile, "w");

  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    VIDAI_DATA_DIR: ctx.data,
    VIDAI_SECRETS: "memory",
    VIDAI_E2E_SCRIPT: scriptFile,
    VIDAI_E2E_REPORT: reportFile,
    // The OpenCode 2 program of the machine running the test must never run an end-to-end edit:
    // by default it is not installed, and a scenario that needs it names its own (a fake).
    ...(scenario.real ? {} : { VIDAI_OPENCODE2_BIN: "/nonexistent/e2e-no-opencode2" }),
    ...scenario.env,
  };
  if (ctx.real) {
    env.VIDAI_CLAUDE_BIN = await realClaude();
  } else {
    // A scenario can say that Claude Code is not installed at all (`VIDAI_CLAUDE_BIN` pointing at
    // nothing), whatever the machine running the test has.
    env.VIDAI_CLAUDE_BIN =
      scenario.env?.VIDAI_CLAUDE_BIN ?? path.join(path.dirname(ctx.dir), "bin", "claude");
    env.FAKE_STATE = ctx.fake;
    env.FAKE_CLAUDE_FIXTURES = controlFixtures;
    platform.appEnv(env);
  }
  ctx.appEnv = env;
  if (isWindows) await platform.watchWindows();
  const child = spawn(platform.appBinary, [], { cwd: ctx.dir, env, stdio: ["pipe", logFd, logFd] });
  closeSync(logFd);
  const pid = child.pid ?? null;
  ctx.pid = pid;
  let exited = /** @type {{ code: number | null, signal: string | null } | null} */ (null);
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });
  const stdin = child.stdin;
  if (!stdin) throw new Error("the app's stdin is not a pipe");
  stdin.on("error", () => {});
  const send = (/** @type {string} */ line) => {
    if (exited === null && stdin.writable) stdin.write(`${line}\n`);
  };
  const marker = path.dirname(ctx.dir);
  const cleanup = async () => {
    await endEverything(pid, marker);
  };
  cleanups.add(cleanup);

  /** @type {Record<string, (ctx: any, args: any) => Promise<unknown>>} */
  const ops = {
    ...builtinOps,
    stdin: async (_ctx, args) => {
      send(args.line);
      return true;
    },
    ...(scenario.ops ?? {}),
  };

  // The app's process tree, looked at every few seconds, so that what ran last can be checked
  // after the app has quit by itself.
  /** @type {Proc[]} */
  let lastTree = [];
  let looking = false;
  const lookAtTree = async () => {
    if (looking || pid === null || exited !== null) return;
    looking = true;
    try {
      const tree = treeOf(await platform.processes(), pid);
      if (exited === null) lastTree = tree;
    } catch {
      // the next look
    } finally {
      looking = false;
    }
  };
  const treeTimer = setInterval(() => void lookAtTree(), 2_000);

  let offset = 0;
  let partial = "";
  let drainedAfterExit = false;
  let quitByItself = false;
  /** @type {{ ok: boolean, message?: string } | null} */
  let outcome = null;
  try {
    while (outcome === null) {
      if (Date.now() > deadline) {
        outcome = {
          ok: false,
          message: `timed out after ${scaled(scenario.timeout ?? 120_000) / 1000} s`,
        };
        break;
      }
      const text = readFileSync(reportFile, "utf8");
      if (text.length > offset) {
        partial += text.slice(offset);
        offset = text.length;
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          /** @type {any} */
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.t === "log") {
            console.log(`      ${message.text}`);
            ctx.notes.push(String(message.text));
          } else if (message.t === "pageError" || message.t === "consoleError") {
            ctx.pageErrors.push(message.text);
            if (verbose) console.log(`      [${message.t}] ${message.text}`);
          } else if (message.t === "notification") {
            ctx.notifications.push(`${message.title}: ${message.body}`);
          } else if (message.t === "req") {
            const op = ops[message.op];
            const reply = (/** @type {object} */ r) =>
              send(JSON.stringify({ id: message.id, ...r }));
            if (!op) {
              reply({ ok: false, error: `unknown runner operation "${message.op}"` });
            } else {
              Promise.resolve()
                .then(() => op(ctx, message.args))
                .then(
                  (value) => reply({ ok: true, value: value ?? null }),
                  (error) =>
                    reply({
                      ok: false,
                      error: error instanceof Error ? error.message : String(error),
                    }),
                );
            }
          } else if (message.t === "done") {
            outcome = { ok: true };
          } else if (message.t === "fail") {
            outcome = { ok: false, message: message.message };
            if (message.stack && verbose) console.log(message.stack);
          }
        }
      }
      if (outcome === null && exited !== null) {
        if (!drainedAfterExit) {
          // Read what the app reported right before it ended.
          drainedAfterExit = true;
          continue;
        }
        const { code, signal } = exited;
        quitByItself = Boolean(launch.exits);
        outcome = launch.exits
          ? // The step made the app quit, possibly before its own "done" got out.
            { ok: true }
          : {
              ok: false,
              message: `the app exited unexpectedly (code ${String(code)}, signal ${String(signal)})`,
            };
      }
      if (outcome === null) await sleep(50);
    }
    if (outcome.ok && launch.exits) {
      while (exited === null && Date.now() < deadline) await sleep(50);
      if (exited === null) outcome = { ok: false, message: "the app did not quit" };
      else quitByItself = true;
    }
    if (outcome.ok && exited === null) {
      // Quit like a user; a confirmation (running jobs) or a hang is ended by force below.
      looking = false;
      await lookAtTree();
      send("!quit");
      const until = Date.now() + 5_000;
      while (exited === null && Date.now() < until) await sleep(50);
      quitByItself = exited !== null;
    }
    if (outcome.ok && quitByItself) {
      // Quitting leaves nothing behind: what ran last ends with the app (WebView2 and the crash
      // watchdog take a moment).
      let left = await survivors(lastTree);
      for (let i = 0; i < 75 && left.length > 0; i++) {
        await sleep(200);
        left = await survivors(lastTree);
      }
      if (left.length > 0) {
        outcome = {
          ok: false,
          message: `processes were left behind after quitting:\n        ${left.map((p) => `${p.pid} ${p.name}: ${p.command}`).join("\n        ")}`,
        };
      }
    }
  } finally {
    clearInterval(treeTimer);
    await platform.uncover().catch(() => {});
    await cleanup();
    cleanups.delete(cleanup);
    ctx.pid = null;
    if (isWindows) {
      const shown = await platform.shownWindows().catch(() => []);
      ctx.windowsSeen.push(...shown.map((w) => ({ launch: index, ...w })));
      const consoles = shown.filter((w) => w.visible && CONSOLE_CLASSES.includes(String(w.class)));
      if (consoles.length > 0 && outcome?.ok) {
        outcome = {
          ok: false,
          message: `a console window showed up while the app ran: ${consoles.map((w) => `"${w.title}" (${w.process} ${w.pid}, ${w.class})`).join(", ")}`,
        };
      }
    }
  }
  if (!outcome.ok) {
    const log = readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(-15);
    throw new Error(
      `${outcome.message}${log.length ? `\n      app log (${logFile}):\n        ${log.join("\n        ")}` : ""}`,
    );
  }
}

async function realClaude() {
  const { execFile } = await import("node:child_process");
  const found = await new Promise((resolve) => {
    execFile("/bin/sh", ["-lc", "command -v claude"], (error, stdout) =>
      resolve(error ? "" : stdout.trim()),
    );
  });
  if (found) return String(found);
  const local = path.join(process.env.HOME ?? "", ".local/bin/claude");
  if (existsSync(local)) return local;
  return fail("the real Claude Code (`claude`) was not found");
}

/**
 * @param {import("./e2e/types.mjs").Scenario} scenario
 * @param {string} work
 * @param {RunContext} run filled while the scenario runs, also when it fails
 */
async function runScenario(scenario, work, run) {
  const dir = path.join(work, scenario.name);
  const editing = path.join(dir, "Editing");
  const data = path.join(dir, "data");
  const fake = path.join(dir, "fake");
  const shots = path.join(dir, "shots");
  for (const d of [editing, data, fake, shots]) await mkdir(d, { recursive: true });
  /** @type {FullContext} */
  const ctx = Object.assign(run, {
    dir,
    editing,
    data,
    fake,
    real,
    platform,
    params: { dir, editing, data, fake },
    shots,
    /** @param {string} channel @param {string} folder @param {string} media */
    async video(channel, folder, media) {
      const target = path.join(editing, channel, folder);
      await mkdir(target, { recursive: true });
      await copyFile(path.join(work, "media", `${media}.mp4`), path.join(target, "A-roll.mp4"));
      return target;
    },
    /** @param {Record<string, unknown>} settings */
    async seedSettings(settings) {
      await writeFile(
        path.join(data, "settings.json"),
        JSON.stringify(
          {
            schemaVersion: 9,
            editingFolder: editing,
            reviewSoftware: ui.reviewSoftwareId,
            maxConcurrentEdits: 3,
            model: null,
            effort: null,
            activeToolkit: "standard",
            channels: [],
            theme: "system",
            textSize: 15,
            // Off unless a scenario asks for it: most scenarios start several edits at once.
            startDelayMinutes: 0,
            // How edits run (SPEC section 7a): the Claude subscription until a scenario chooses.
            setup: "claudeSubscription",
            apiOptions: apiOptions(),
            ...settings,
          },
          null,
          2,
        ),
      );
    },
    fakeCalls: () => fakeCalls(fake),
    /** @param {string} name @param {string} [content] */
    async fakeSet(name, content = "") {
      await writeFile(inside(fake, name), content);
    },
  });
  const deadline = Date.now() + scaled(scenario.timeout ?? 120_000);
  try {
    if (scenario.prepare) await scenario.prepare(ctx);
    for (const [index, launch] of scenario.launches.entries()) {
      await runLaunch(scenario, ctx, launch, index, deadline);
    }
  } finally {
    if (scenario.cleanup) await scenario.cleanup(ctx);
  }
  const leftovers = await belonging(null, work);
  if (leftovers.length > 0) {
    throw new Error(
      `processes were left behind:\n        ${leftovers.map((p) => `${p.pid} ${p.command}`).join("\n        ")}`,
    );
  }
  checkIsolation(ctx);
  return ctx;
}

/**
 * The app kept its data in the scenario's own data folder (`VIDAI_DATA_DIR`), never in the OS
 * app data folder of its bundle id.
 * @param {FullContext} ctx
 */
function checkIsolation(ctx) {
  const osDir = platform.appDataDir(E2E_BUNDLE_ID);
  for (const name of ["settings.json", "state.json"]) {
    if (existsSync(path.join(osDir, name))) {
      throw new Error(`the app wrote ${name} into ${osDir} instead of its test data folder`);
    }
  }
  if (!ctx.real && !existsSync(path.join(ctx.data, "settings.json"))) {
    throw new Error(`the app wrote no settings.json into its test data folder ${ctx.data}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function loadScenarios() {
  const dir = path.join(e2eDir, "scenarios");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".mjs")).sort();
  /** @type {import("./e2e/types.mjs").Scenario[]} */
  const all = [];
  for (const file of files) {
    // A scenario file exports one scenario or a list of related ones.
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    all.push(...[mod.default].flat());
  }
  return all.filter(
    (s) =>
      Boolean(s.real) === real &&
      (only.length === 0 || only.some((name) => s.name === name || s.name.startsWith(name))),
  );
}

/** The folder the run's work folder goes into, without links or short (8.3) names. */
function workParent() {
  const parent = outDir ? path.resolve(outDir) : tmpdir();
  if (!existsSync(parent)) return parent;
  // macOS: /var is /private/var, as the fake's $PWD shows; Windows: long names, as Git Bash
  // shows them (the temp folder of a Windows account is often a short name, RUNNER~1).
  return isWindows ? realpathSync.native(parent) : realpathSync(parent);
}

async function main() {
  const scenarios = await loadScenarios();
  if (scenarios.length === 0) fail(`no scenario matches ${only.join(", ")}`);
  let display;
  try {
    display = await platform.start();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  await ensureApp();
  await mkdir(workParent(), { recursive: true });
  const work = path.join(
    workParent(),
    `vidai-e2e-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await mkdir(path.join(work, "bin"), { recursive: true });
  await platform.installFake(fakeClaude, path.join(work, "bin"));
  const media = await makeMedia(path.join(work, "media"));
  console.log(`e2e: ${scenarios.length} scenario(s) on ${display}, work folder ${work}`);
  if (media !== "ffmpeg") console.log("e2e: no ffmpeg, the test videos are header-only MP4 files");

  /** @type {{ name: string, title: string, result: "passed" | "failed" | "skipped", reason?: string, seconds: number, screenshots: string[], skippedScreenshots: number, pageErrors: string[], notes: string[], windowsSeen: any[] }[]} */
  const results = [];
  for (const scenario of scenarios) {
    if (interrupted) break;
    const started = Date.now();
    console.log(`\n  ${scenario.name}: ${scenario.title}`);
    if (scenario.skip) {
      console.log(`  SKIP ${scenario.name}: ${scenario.skip}`);
      results.push({
        name: scenario.name,
        title: scenario.title,
        result: "skipped",
        reason: scenario.skip,
        seconds: 0,
        screenshots: [],
        skippedScreenshots: 0,
        pageErrors: [],
        notes: [],
        windowsSeen: [],
      });
      continue;
    }
    windowOffScreen = false;
    /** @type {RunContext} */
    const run = {
      shots: "",
      shotCount: 0,
      skippedShots: 0,
      shotFiles: [],
      pid: null,
      notifications: [],
      pageErrors: [],
      windowsSeen: [],
      notes: [],
      appEnv: {},
    };
    const record = (/** @type {"passed" | "failed"} */ result, /** @type {string} */ reason) => {
      results.push({
        name: scenario.name,
        title: scenario.title,
        result,
        ...(reason ? { reason } : {}),
        seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
        screenshots: run.shotFiles,
        skippedScreenshots: run.skippedShots,
        pageErrors: run.pageErrors,
        notes: run.notes,
        windowsSeen: run.windowsSeen,
      });
    };
    try {
      await runScenario(scenario, work, run);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const skipped =
        run.skippedShots > 0 ? `, ${run.skippedShots} skipped: window not on screen` : "";
      console.log(`  PASS ${scenario.name} (${seconds} s, ${run.shotCount} screenshots${skipped})`);
      if (run.pageErrors.length > 0) {
        console.log(`      page errors: ${run.pageErrors.slice(0, 5).join(" | ")}`);
      }
      record("passed", "");
    } catch (error) {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const hint = windowOffScreen
        ? "\n      Note: the VidAI window was not on screen during this scenario (screen locked or asleep?). Menus, popovers and images need a visible window, so run it again with the screen on before treating this as a bug."
        : "";
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  FAIL ${scenario.name} (${seconds} s)\n      ${message}${hint}`);
      record("failed", message);
    }
  }
  await runCleanups();
  const leftovers = await belonging(null, work);
  const failed = results.filter((r) => r.result === "failed");
  const skipped = results.filter((r) => r.result === "skipped");
  await writeFile(
    path.join(work, "e2e-report.json"),
    JSON.stringify(
      {
        platform: platform.name,
        display,
        interface: ui,
        media,
        startedAt: path.basename(work).replace(/^vidai-e2e-/, ""),
        results,
        leftovers,
      },
      null,
      2,
    ),
  );
  console.log(
    `\ne2e: ${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped. Screenshots, logs and e2e-report.json: ${work}`,
  );
  if (leftovers.length > 0) {
    console.log(`e2e: processes left behind: ${leftovers.map((p) => p.command).join("; ")}`);
    await endEverything(null, work);
  }
  await platform.stop();
  if (failed.length === 0 && leftovers.length === 0 && !keep) {
    // Keep the screenshots, logs and the report: they are the record of the run.
    for (const entry of await readdir(work)) {
      if (entry === "media" || entry === "bin")
        await rm(path.join(work, entry), { recursive: true });
    }
  }
  const exists = await stat(work).then(
    () => true,
    () => false,
  );
  if (!exists) console.log("e2e: work folder removed");
  process.exit(failed.length === 0 && leftovers.length === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(`e2e: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  await runCleanups();
  await platform.stop();
  process.exit(1);
});

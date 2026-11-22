// The Windows installer, end to end, as a person uses it (CI, after `npm run tauri build`):
//
//   node scripts/e2e/windows/installer-smoke.mjs <VidAI_..._x64-setup.exe> <out folder>
//
// 1. A silent per-user install (`/S`), without administrator rights.
// 2. VidAI starts from the installed copy, in a normal run (no test environment): its window
//    appears (screenshot), and its data folder is %APPDATA%\com.vidai.desktop.
// 3. No console window shows up while it runs (SPEC section 11).
// 4. Closing the window (WM_CLOSE, like its close button) ends VidAI with nothing running, and no
//    process of its tree is left behind.
// 5. A silent uninstall removes the installed files and the uninstall entry.
// The result is <out folder>/installer-report.json with the screenshot next to it; the exit code
// says whether every step passed.
import { execFile as execFileCb, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Helper, largeScreenOnCi } from "./platform.mjs";

const execFile = promisify(execFileCb);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const CONSOLE_CLASSES = ["ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS"];

const [setup, outArg] = process.argv.slice(2);
if (!setup || !outArg) {
  console.error("usage: installer-smoke.mjs <setup.exe> <out folder>");
  process.exit(2);
}
const out = path.resolve(outArg);

/** @type {{ step: string, ok: boolean, detail: unknown }[]} */
const steps = [];
/** @param {string} step @param {boolean} ok @param {unknown} detail */
function record(step, ok, detail) {
  steps.push({ step, ok, detail });
  console.log(
    `${ok ? "PASS" : "FAIL"} ${step}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
  );
}

/**
 * The uninstall entry of VidAI for this user: its registry values.
 * @returns {Promise<Record<string, string> | null>}
 */
async function uninstallEntry() {
  const root = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
  /** The values of `reg query` output, by key. @param {string[]} args */
  const query = async (args) => {
    /** @type {Map<string, Record<string, string>>} */
    const keys = new Map();
    try {
      const { stdout } = await execFile("reg", ["query", ...args]);
      /** @type {Record<string, string>} */
      let values = {};
      for (const line of stdout.split(/\r?\n/)) {
        if (line.startsWith("HKEY_")) {
          values = {};
          keys.set(line.trim(), values);
          continue;
        }
        const m = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line);
        if (m?.[1] && m[2] !== undefined) values[m[1]] = m[2].trim();
      }
    } catch {
      // nothing found
    }
    return keys;
  };
  for (const [key, values] of await query([root, "/s", "/f", "VidAI", "/d"])) {
    if (values.DisplayName !== "VidAI") continue;
    return { key, ...((await query([key])).get(key) ?? values) };
  }
  return null;
}

/** Waits for `check` to return something truthy, up to `ms`. @template T */
async function until(/** @type {() => Promise<T> | T} */ check, /** @type {number} */ ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value || Date.now() > deadline) return value;
    await sleep(250);
  }
}

/** @param {any[]} procs @param {number} pid */
function treeOf(procs, pid) {
  const members = new Set([pid]);
  for (let grown = true; grown;) {
    grown = false;
    for (const p of procs) {
      const parent = procs.find((q) => q.pid === p.ppid);
      if (!members.has(p.pid) && members.has(p.ppid) && (!parent || p.started >= parent.started)) {
        members.add(p.pid);
        grown = true;
      }
    }
  }
  return procs.filter((p) => members.has(p.pid));
}

async function main() {
  await mkdir(out, { recursive: true });
  const helper = new Helper();
  const ready = await helper.start();
  console.log(`screen: ${JSON.stringify(await largeScreenOnCi(helper, ready.screen))}`);
  const appData = path.join(process.env.APPDATA ?? "", "com.vidai.desktop");
  const appDataBefore = existsSync(appData);

  // 1. Silent per-user install.
  const installed = await new Promise((resolve) => {
    const child = spawn(path.resolve(setup), ["/S"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 300_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const entry = await until(uninstallEntry, 30_000);
  const location = entry?.InstallLocation?.replace(/^"|"$/g, "") ?? "";
  const exe = location ? path.join(location, "VidAI.exe") : "";
  record("silent install", installed === 0 && existsSync(exe), {
    exitCode: installed,
    entry,
    exe,
    files: location && existsSync(location) ? readdirSync(location) : [],
  });
  if (!existsSync(exe)) return finish(helper);

  // An installer may start the app by itself; this test starts it.
  const already = (await helper.call("processes")).filter(
    (/** @type {any} */ p) => p.name.toLowerCase() === "vidai.exe",
  );
  record("no VidAI started by the installer", already.length === 0, already);
  for (const p of already) process.kill(p.pid);

  // 2. Start, as from the Start menu: the user's environment without any test variable.
  /** @type {NodeJS.ProcessEnv} */
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(VIDAI_|FAKE_)/i.test(k)),
  );
  await helper.call("watchStart");
  const app = spawn(exe, [], { env, stdio: "ignore", cwd: location });
  const pid = app.pid ?? 0;
  /** @type {{ code: number | null } | null} */
  let exited = null;
  app.on("exit", (code) => {
    exited = { code };
  });
  const window = await until(async () => {
    /** @type {any[]} */
    const windows = await helper.call("windows", { pid });
    return windows.find((w) => w.width > 200 && w.height > 200) ?? null;
  }, 60_000);
  record("the window appears", Boolean(window), window);
  if (window) {
    // Let the page render its first screen (onboarding: Claude Code is not installed here).
    await sleep(6_000);
    const shot = await helper.call("capture", {
      hwnd: window.hwnd,
      file: path.join(out, "installed-app.png"),
    });
    record("screenshot", true, shot);
  }
  const dataReady = await until(() => existsSync(appData), 15_000);
  record("data folder %APPDATA%\\com.vidai.desktop", Boolean(dataReady), {
    existedBefore: appDataBefore,
    files: dataReady ? readdirSync(appData) : [],
  });
  const tree = treeOf(await helper.call("processes"), pid);
  console.log(`process tree: ${tree.map((p) => `${p.pid} ${p.name}`).join(", ")}`);

  // 4. Close the window like its close button: nothing runs, so VidAI ends.
  if (window) await helper.call("close", { hwnd: window.hwnd });
  const ended = await until(() => exited !== null, 20_000);
  record("closing the window ends VidAI", Boolean(ended), exited);
  if (!ended) process.kill(pid);
  const survivors = async () => {
    const now = await helper.call("processes");
    return tree.filter((p) =>
      now.some((/** @type {any} */ q) => q.pid === p.pid && q.started === p.started),
    );
  };
  await until(async () => (await survivors()).length === 0, 20_000);
  const left = await survivors();
  record(
    "no process left behind",
    left.length === 0,
    left.map((p) => `${p.pid} ${p.name}: ${p.command}`),
  );
  for (const p of left) process.kill(p.pid);

  // 3. No console window showed up.
  /** @type {any[]} */
  const shown = await helper.call("watchStop");
  const consoles = shown.filter((w) => w.visible && CONSOLE_CLASSES.includes(w.class));
  record("no console window", consoles.length === 0, {
    consoles,
    windowsShown: shown.map((w) => `${w.process} ${w.class} "${w.title}"`),
  });

  // 5. Silent uninstall.
  const uninstaller = (entry?.QuietUninstallString ?? entry?.UninstallString ?? "").trim();
  const match = /^"([^"]+)"|^(\S+)/.exec(uninstaller);
  const program = match?.[1] ?? match?.[2] ?? path.join(location, "uninstall.exe");
  await new Promise((resolve) => {
    const child = spawn(program, ["/S"], { stdio: "ignore" });
    child.on("exit", resolve);
    child.on("error", resolve);
  });
  // The NSIS uninstaller copies itself to the temp folder and runs from there: wait for its work.
  const removed = await until(async () => !existsSync(exe) && !(await uninstallEntry()), 120_000);
  record("silent uninstall", Boolean(removed), {
    program,
    exeLeft: existsSync(exe),
    folderLeft: existsSync(location) ? readdirSync(location) : null,
    entryLeft: await uninstallEntry(),
    dataFolderKept: existsSync(appData),
  });
  return finish(helper);
}

/** @param {Helper} helper */
async function finish(helper) {
  helper.stop();
  await writeFile(path.join(out, "installer-report.json"), JSON.stringify({ steps }, null, 2));
  const failed = steps.filter((s) => !s.ok);
  console.log(`\ninstaller: ${steps.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  await writeFile(
    path.join(out, "installer-report.json"),
    JSON.stringify({ steps, error: String(error) }, null, 2),
  ).catch(() => {});
  process.exit(1);
});

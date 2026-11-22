// The macOS side of the end-to-end runner (scripts/e2e.mjs): the debug app bundle, `ps`,
// window-only screenshots with `screencapture -l<window id>`, and three small Swift helpers
// (`winid`: the window of a process; `clipboard`: save, restore and read the pasteboard;
// `cover`: an opaque window over the app's window, as the person's own windows put there).
//
// Needs: Xcode command line tools (swiftc); Screen Recording permission for the terminal.
import { execFile as execFileCb, spawn } from "node:child_process";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { archsOf, bundleDir, canRunIntel, checkRustTargets, root } from "../../mac-targets.mjs";

const execFile = promisify(execFileCb);
const here = path.join(root, "scripts", "e2e", "macos");

/**
 * @param {{ cacheDir: string, identifier: string, target: import("../../mac-targets.mjs").MacTarget | null }} options
 * @returns {import("../types.mjs").Platform}
 */
export function createPlatform({ cacheDir, identifier, target }) {
  const appBundle = path.join(
    target ? bundleDir(target, "debug") : path.join(root, "src-tauri/target/debug/bundle"),
    "macos/VidAI.app",
  );
  const appBinary = path.join(appBundle, "Contents/MacOS/VidAI");
  /** @type {Record<string, string>} */
  const helpers = {};
  /** The running `cover` helper, if any. @type {import("node:child_process").ChildProcess | null} */
  let cover = null;

  async function uncover() {
    const child = cover;
    cover = null;
    if (!child || child.exitCode !== null) return;
    const ended = new Promise((resolve) => child.once("exit", resolve));
    child.stdin?.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    await ended;
    clearTimeout(timer);
  }

  /** Compiles a Swift helper of this folder (`winid`, `clipboard`, `cover`) once, returns its path. */
  async function helper(/** @type {string} */ name) {
    const source = path.join(here, `${name}.swift`);
    const binary = path.join(cacheDir, name);
    if (!existsSync(binary) || statSync(binary).mtimeMs < statSync(source).mtimeMs) {
      await mkdir(cacheDir, { recursive: true });
      await execFile("swiftc", ["-O", "-o", binary, source]);
    }
    helpers[name] = binary;
    return binary;
  }

  /** The bundle id of the debug build, or null when there is none. */
  function bundleId() {
    const plist = path.join(appBundle, "Contents/Info.plist");
    if (!existsSync(plist)) return null;
    const m = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(
      readFileSync(plist, "utf8"),
    );
    return m?.[1] ?? null;
  }

  /** @param {string} pid @param {boolean} any */
  async function winid(pid, any) {
    const { stdout } = await execFile(
      helpers.winid ?? (await helper("winid")),
      any ? [pid, "--any"] : [pid],
    );
    return stdout.trim();
  }

  return {
    name: "macos",
    timeScale: 1,
    appBinary,
    buildInputs: ["src-tauri/tauri.macos.conf.json", "src-tauri/helpers"],

    builtAt() {
      return existsSync(appBinary) && bundleId() === identifier ? statSync(appBinary).mtimeMs : 0;
    },

    async buildArgs() {
      const config = JSON.stringify({ identifier });
      const args = ["build", "--debug", "--bundles", "app", "--config", config];
      if (target) {
        await checkRustTargets(target);
        args.push("--target", target.triple);
      }
      return args;
    },

    async afterBuild() {},

    async checkBuild() {
      if (!target) return;
      const archs = await archsOf(appBinary);
      if (archs.join(" ") !== target.archs.join(" ")) {
        throw new Error(
          `${appBinary} is ${archs.join(" + ")}, expected ${target.archs.join(" + ")}`,
        );
      }
      // A universal binary runs its native slice, so only a thin Intel build runs translated.
      if (process.arch === "arm64" && archs.join(" ") === "x86_64") {
        if (!(await canRunIntel())) {
          throw new Error(
            "this Mac cannot run Intel apps: install Rosetta 2 (softwareupdate --install-rosetta)",
          );
        }
        console.log("e2e: testing the Intel (x86_64) build under Rosetta 2");
      }
    },

    async start() {
      await helper("winid");
      await helper("clipboard");
      await helper("cover");
      return "macOS";
    },

    async stop() {
      await uncover();
    },

    appEnv(env) {
      // A quick, predictable login-shell capture that does not run the developer's shell setup.
      env.SHELL = "/bin/sh";
    },

    async installFake(source, binDir) {
      const target = path.join(binDir, "claude");
      await copyFile(source, target);
      await chmod(target, 0o755);
      return target;
    },

    async findWindow(pid, any = false) {
      const parts = (await winid(String(pid), any)).split(/\s+/).filter(Boolean);
      if (parts.length !== 5) return null;
      return { id: parts[0] ?? "", bounds: parts.slice(1).map(Number) };
    },

    async capture(window, file) {
      await execFile("screencapture", ["-x", "-o", `-l${window.id}`, file]);
      return "screencapture";
    },

    async processes() {
      const { stdout } = await execFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat=,command="], {
        maxBuffer: 16 * 1024 * 1024,
      });
      /** @type {import("../types.mjs").Proc[]} */
      const list = [];
      for (const line of stdout.split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!m || m[4]?.startsWith("Z")) continue;
        const command = m[5] ?? "";
        list.push({
          pid: Number(m[1]),
          ppid: Number(m[2]),
          pgid: Number(m[3]),
          started: null,
          name: path.basename(command.split(" ")[0] ?? ""),
          command,
        });
      }
      return list;
    },

    async clipboardSave(file) {
      await execFile(helpers.clipboard ?? (await helper("clipboard")), ["save", file]);
    },

    async clipboardRestore(file) {
      await execFile(helpers.clipboard ?? (await helper("clipboard")), ["restore", file]);
    },

    async clipboardText() {
      return (await execFile(helpers.clipboard ?? (await helper("clipboard")), ["text"])).stdout;
    },

    async pressKey() {
      // Real key presses on macOS are posted through AppKit by the app's own hook
      // (`host.native("key")`), which needs no Accessibility permission for the terminal.
      throw new Error('on macOS, real key presses go through host.native("key")');
    },

    async wheel() {
      throw new Error("mouse wheel events are not implemented on macOS");
    },

    async click() {
      throw new Error("real mouse clicks are not implemented on macOS");
    },

    async drag() {
      throw new Error("mouse drags are not implemented on macOS");
    },

    async cover(pid) {
      await uncover();
      const child = spawn(helpers.cover ?? (await helper("cover")), [String(pid)], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      cover = child;
      let output = "";
      const line = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the cover window did not show")), 10_000);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => (output += chunk));
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const covered = /^covered (.*)$/m.exec(output);
          if (covered) {
            clearTimeout(timer);
            resolve(covered[1] ?? "");
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`the cover helper ended (exit ${String(code)}): ${output.trim()}`));
        });
      });
      return { bounds: String(line).split(" ").map(Number), foreground: null };
    },

    uncover,

    async setDisplay() {
      throw new Error("the tests do not change the display of a Mac");
    },

    async startFromForeground() {
      throw new Error("starting a program from the foreground process is for Windows");
    },

    async reopen() {
      // Like a click on the Dock icon, without activating the app.
      await execFile("open", ["-g", appBundle]);
    },

    async systemDark() {
      try {
        const { stdout } = await execFile("defaults", ["read", "-g", "AppleInterfaceStyle"]);
        return stdout.trim() === "Dark";
      } catch {
        return false; // the key is absent in light mode
      }
    },

    async fakeAlive(pids) {
      return pids.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
    },

    async watchWindows() {},

    async shownWindows() {
      return [];
    },

    appDataDir(id) {
      return path.join(homedir(), "Library", "Application Support", id);
    },
  };
}

// The Windows side of the end-to-end runner (scripts/e2e.mjs): the debug `VidAI.exe` (no
// installer bundle), and one long-lived Windows PowerShell helper (helper.ps1) for what Node
// cannot do itself: finding the app's window, capturing only that window, the clipboard, real key
// presses and mouse drags, the process list with command lines, and watching for windows that
// show up (a console window flashing while a job runs).
//
// Uses only what every Windows has (Windows PowerShell 5.1 and the .NET Framework), plus Git for
// Windows, whose Git Bash runs the fake Claude Code (src-tauri/tests/support/fake-claude.sh) as it
// does in the Rust integration tests (SPEC section 11).
import { execFile as execFileCb, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { root } from "../../mac-targets.mjs";

const execFile = promisify(execFileCb);
const helperScript = path.join(root, "scripts", "e2e", "windows", "helper.ps1");

/**
 * The long-lived PowerShell helper: one JSON request per line, one JSON answer per line.
 */
export class Helper {
  /** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
  child = null;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  pending = new Map();
  next = 1;
  stderr = "";
  /** @type {any} */
  ready = null;

  async start() {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helperScript,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (/** @type {string} */ chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8000);
    });
    const lines = createInterface({ input: child.stdout });
    /** @type {Promise<any>} */
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`the Windows helper did not start:\n${this.stderr}`)),
        120_000,
      );
      child.on("exit", (code) => {
        clearTimeout(timer);
        const error = new Error(`the Windows helper ended (exit ${String(code)}):\n${this.stderr}`);
        reject(error);
        for (const entry of this.pending.values()) entry.reject(error);
        this.pending.clear();
        this.child = null;
      });
      lines.on("line", (line) => {
        /** @type {any} */
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          this.stderr += `\n[stdout] ${line}`;
          return;
        }
        if (message.ready) {
          clearTimeout(timer);
          resolve(message);
          return;
        }
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(new Error(`Windows helper, ${String(message.error)}`));
      });
    });
    this.ready = await ready;
    return this.ready;
  }

  /** @param {string} op @param {Record<string, unknown>} [args] @returns {Promise<any>} */
  call(op, args = {}) {
    const child = this.child;
    if (!child) return Promise.reject(new Error("the Windows helper is not running"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  }

  stop() {
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
  }
}

/**
 * The window is at least 980 x 620 CSS px times the text-size zoom (up to 20 / 13), so a small
 * screen (CI runners start at 1024 x 768) caps its minimum size: on CI, the screen is made
 * 1920 x 1080 (never on a person's own PC). Returns the screen.
 * @param {Helper} helper @param {any} screen
 */
export async function largeScreenOnCi(helper, screen) {
  if ((screen.width >= 1920 && screen.height >= 1080) || process.env.CI !== "true") return screen;
  const changed = await helper.call("setResolution", { width: 1920, height: 1080 });
  console.log(
    `e2e: the screen was ${screen.width} x ${screen.height}, changed to 1920 x 1080 (result ${String(changed.result)})`,
  );
  return changed.screen;
}

/** Git Bash, found like VidAI finds it (src-tauri/src/platform/windows.rs, `git_bash`). */
export function gitBash() {
  const env = process.env;
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    env.ProgramFiles && path.join(env.ProgramFiles, "Git", "bin", "bash.exe"),
    env.ProgramW6432 && path.join(env.ProgramW6432, "Git", "bin", "bash.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ];
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

/**
 * @param {{ cacheDir: string, identifier: string }} options
 * @returns {import("../types.mjs").Platform}
 */
export function createPlatform({ cacheDir, identifier }) {
  const debugDir = path.join(root, "src-tauri", "target", "debug");
  // `mainBinaryName` names the app VidAI.exe; cargo's own name for it is vidai.exe.
  const binaries = ["VidAI.exe", "vidai.exe"].map((b) => path.join(debugDir, b));
  const stampFile = path.join(cacheDir, "build-windows.json");
  const helper = new Helper();

  /** The newest debug binary, or the expected path when there is none. */
  function appBinary() {
    const existing = binaries.filter((b) => existsSync(b));
    existing.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return existing[0] ?? binaries[0] ?? "";
  }

  /** The main window of a process: the largest visible top-level window. */
  async function mainWindow(/** @type {number} */ pid, all = false) {
    /** @type {any[]} */
    const windows = await helper.call("windows", { pid, all });
    const candidates = windows
      .filter((w) => w.height > 200 && w.width > 200 && !w.minimized)
      .sort((a, b) => b.width * b.height - a.width * a.height);
    return candidates[0] ?? null;
  }

  return {
    name: "windows",
    // Git Bash starts processes slowly and the fakes notice dropped files only once a second
    // (their wake-up FIFOs do not work from Windows programs), so waits get more room.
    timeScale: 2,
    get appBinary() {
      return appBinary();
    },
    buildInputs: ["src-tauri/tauri.windows.conf.json", "src-tauri/windows-app-manifest.xml"],

    builtAt() {
      // The stamp says that this binary is the e2e build (with the e2e identifier), not one of
      // `tauri dev` or a plain debug build, which write to the same place.
      if (!existsSync(stampFile)) return 0;
      try {
        const stamp = JSON.parse(readFileSync(stampFile, "utf8"));
        const binary = stamp.binary;
        if (stamp.identifier !== identifier || !binary || !existsSync(binary)) return 0;
        const info = statSync(binary);
        return info.mtimeMs === stamp.mtimeMs && info.size === stamp.size ? info.mtimeMs : 0;
      } catch {
        return 0;
      }
    },

    async buildArgs() {
      return ["build", "--debug", "--no-bundle", "--config", JSON.stringify({ identifier })];
    },

    async afterBuild() {
      const binary = appBinary();
      const info = statSync(binary);
      await mkdir(cacheDir, { recursive: true });
      await writeFile(
        stampFile,
        JSON.stringify({ identifier, binary, mtimeMs: info.mtimeMs, size: info.size }, null, 2),
      );
    },

    async checkBuild() {},

    async start() {
      if (!gitBash()) {
        throw new Error("Git for Windows (Git Bash) is needed: it runs the fake Claude Code");
      }
      const ready = await helper.start();
      const s = await largeScreenOnCi(helper, ready.screen);
      return `Windows, screen ${s.width} x ${s.height} at ${s.dpi} dpi, work area ${s.workWidth} x ${s.workHeight}`;
    },

    async stop() {
      helper.stop();
    },

    appEnv() {},

    async installFake(source, binDir) {
      // No extension: VidAI sees the `#!` line and runs it with Git Bash.
      const target = path.join(binDir, "claude");
      await copyFile(source, target);
      return target;
    },

    async findWindow(pid, any = false) {
      const w = await mainWindow(pid, any);
      if (!w) return null;
      const scale = (w.dpi || 96) / 96;
      return {
        id: String(w.hwnd),
        bounds: [w.x, w.y, w.width, w.height].map((v) => v / scale),
        info: w,
      };
    },

    async capture(window, file) {
      const result = await helper.call("capture", { hwnd: Number(window.id), file });
      return result.method;
    },

    async processes() {
      /** @type {any[]} */
      const list = await helper.call("processes");
      return list.map((p) => ({
        pid: p.pid,
        ppid: p.ppid,
        pgid: null,
        started: p.started || null,
        name: p.name,
        command: p.command,
      }));
    },

    async clipboardSave() {
      await helper.call("clipboardSave");
    },

    async clipboardRestore() {
      await helper.call("clipboardRestore");
    },

    async clipboardText() {
      return helper.call("clipboardText");
    },

    async pressKey(pid, key, modifiers) {
      const w = await mainWindow(pid);
      if (!w) throw new Error("the VidAI window is not on screen");
      const result = await helper.call("keys", { hwnd: w.hwnd, key, ...modifiers });
      if (!result.foreground) {
        throw new Error("Windows did not let the VidAI window come to the front for a key press");
      }
    },

    async drag(pid, from, to) {
      const w = await mainWindow(pid);
      if (!w) throw new Error("the VidAI window is not on screen");
      return helper.call("drag", { hwnd: w.hwnd, from, to });
    },

    async click(pid, at, button) {
      const w = await mainWindow(pid);
      if (!w) throw new Error("the VidAI window is not on screen");
      return helper.call("click", { hwnd: w.hwnd, at, button });
    },

    async wheel(pid, at, delta, ctrl) {
      const w = await mainWindow(pid);
      if (!w) throw new Error("the VidAI window is not on screen");
      return helper.call("wheel", { hwnd: w.hwnd, at, delta, ctrl });
    },

    async cover(pid) {
      const w = await mainWindow(pid);
      if (!w) throw new Error("the VidAI window is not on screen");
      const result = await helper.call("cover", { hwnd: w.hwnd });
      const scale = (w.dpi || 96) / 96;
      return {
        bounds: result.bounds.map((/** @type {number} */ v) => v / scale),
        foreground: result.foreground,
      };
    },

    async uncover() {
      if (helper.child) await helper.call("uncover");
    },

    async setDisplay(width, height) {
      const changed = await helper.call("setResolution", { width, height });
      if (changed.result !== 0) {
        throw new Error(
          `the display could not be set to ${width} x ${height} (result ${String(changed.result)})`,
        );
      }
      console.log(`      the screen is now ${changed.screen.width} x ${changed.screen.height}`);
    },

    async startFromForeground(file, cwd, env, timeout) {
      return helper.call("start", { file, cwd, env, timeout });
    },

    async reopen() {
      throw new Error("there is no Dock on Windows");
    },

    async systemDark() {
      try {
        const { stdout } = await execFile("reg", [
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
          "/v",
          "AppsUseLightTheme",
        ]);
        return /AppsUseLightTheme\s+REG_DWORD\s+0x0\b/.test(stdout);
      } catch {
        return false; // no setting: light
      }
    },

    async fakeAlive(pids) {
      // The fake reports Git Bash (MSYS2) process ids, which only Git Bash can look up.
      if (pids.length === 0) return [];
      const bash = gitBash();
      if (!bash) throw new Error("Git Bash not found");
      const script = `for p in ${pids.map(Number).join(" ")}; do kill -0 "$p" 2>/dev/null && echo "$p"; done; true`;
      const { stdout } = await execFile(bash, ["-c", script]);
      return stdout.split(/\s+/).filter(Boolean).map(Number);
    },

    async watchWindows() {
      await helper.call("watchStart");
    },

    async shownWindows() {
      return helper.call("watchStop");
    },

    appDataDir(id) {
      return path.join(process.env.APPDATA ?? "", id);
    },

    helper,
  };
}

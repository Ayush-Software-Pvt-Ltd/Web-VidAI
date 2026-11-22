// Shared by scripts/web.mjs and scripts/bundle-web.mjs: running commands, deciding whether the UI
// build is out of date, and finding where cargo puts the `vidai-web` binary.
import { execFile as execFileCb, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export const root = fileURLToPath(new URL("../..", import.meta.url));
export const manifest = "src-web/Cargo.toml";
export const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * Runs a command in the repository root with its output on this terminal and resolves with the
 * exit code (`null` when it was killed by a signal).
 * @param {string} command @param {string[]} args @param {Record<string, string>} [env]
 * @returns {Promise<number | null>}
 */
export function run(command, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...env },
      // npm.cmd is a batch file; Windows only starts those through a shell.
      shell: process.platform === "win32" && command.endsWith(".cmd"),
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
}

/**
 * Newest modification time below `path` (files only; build output and dot folders are skipped).
 * @param {string} entry
 * @returns {number}
 */
export function newest(entry) {
  if (!existsSync(entry)) return 0;
  const info = statSync(entry);
  if (!info.isDirectory()) return info.mtimeMs;
  let latest = 0;
  for (const child of readdirSync(entry, { withFileTypes: true })) {
    if (child.name === "node_modules" || child.name === "target" || child.name.startsWith(".")) {
      continue;
    }
    latest = Math.max(latest, newest(path.join(entry, child.name)));
  }
  return latest;
}

/** What `npm run build` turns into `dist/`. */
const UI_INPUTS = [
  "src",
  "index.html",
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "tsconfig.json",
];

/** Whether `dist/` is missing or older than the sources of the UI. */
export function uiIsStale() {
  const built = newest(path.join(root, "dist", "index.html"));
  if (built === 0) return true;
  return UI_INPUTS.some((input) => newest(path.join(root, input)) > built);
}

/**
 * Builds the UI (`npm run build`) unless `dist/` is up to date, or `force` is set.
 * Exits the process when the build fails.
 * @param {string} name Script name for messages.
 * @param {boolean} [force]
 */
export async function buildUi(name, force = false) {
  if (!force && !uiIsStale()) {
    console.log(`${name}: dist/ is up to date`);
    return;
  }
  console.log(`${name}: building the UI (npm run build) ...`);
  const code = await run(npm, ["run", "build"]);
  if (code !== 0) fail(name, `npm run build failed (exit ${String(code)})`);
}

/**
 * Where cargo writes build output for src-web (honours CARGO_TARGET_DIR and .cargo/config.toml).
 * @returns {Promise<string>}
 */
export async function targetDirectory() {
  const { stdout } = await execFile(
    "cargo",
    ["metadata", "--no-deps", "--format-version", "1", "--manifest-path", manifest],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  return /** @type {{ target_directory: string }} */ (JSON.parse(stdout)).target_directory;
}

/**
 * The cargo command that builds `vidai-web`.
 * `triple` set means `--target <triple>`, and `windows` on a Mac means cargo-xwin.
 * @param {{ release: boolean, triple?: string | undefined }} options
 * @returns {{ command: string, args: string[], env: Record<string, string> }}
 */
export function cargoBuild({ release, triple }) {
  const crossWindows =
    triple?.endsWith("-pc-windows-msvc") === true && process.platform !== "win32";
  const args = [crossWindows ? "xwin" : "build"];
  if (crossWindows) args.push("build");
  if (release) args.push("--release");
  if (triple) args.push("--target", triple);
  args.push("--manifest-path", manifest);
  return {
    command: "cargo",
    args,
    env: crossWindows
      ? { PATH: `/opt/homebrew/opt/llvm/bin${path.delimiter}${process.env["PATH"] ?? ""}` }
      : {},
  };
}

/**
 * @param {string} name @param {string} message @returns {never}
 */
export function fail(name, message) {
  console.error(`${name}: ${message}`);
  process.exit(1);
}

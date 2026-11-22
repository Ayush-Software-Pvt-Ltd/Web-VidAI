// Where VidAI Server keeps its data by default, and owner-only file permissions (docs/SPEC.md section 2).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The default data directory of the operating system.
 * macOS: `~/Library/Application Support/VidAI Server`, Windows: `%LOCALAPPDATA%\VidAI Server`,
 * anything else: `$XDG_DATA_HOME` or `~/.local/share`, plus `/vidai-server`.
 * @param {{ platform?: string, env?: Record<string, string | undefined>, home?: string }} [options]
 *   Injected so tests can ask for any system's answer.
 * @returns {string}
 */
export function defaultDataDir({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local");
    return path.win32.join(base, "VidAI Server");
  }
  if (platform === "darwin") {
    return path.posix.join(home, "Library", "Application Support", "VidAI Server");
  }
  const base = env.XDG_DATA_HOME || path.posix.join(home, ".local", "share");
  return path.posix.join(base, "vidai-server");
}

/**
 * Make a file readable by its owner only (0600) or a directory enterable by its owner only (0700).
 * Windows has no such mode bits (the profile folder is already private), so it does nothing there.
 * @param {string} target
 * @param {{ platform?: string }} [options]
 */
export function restrictToOwner(target, { platform = process.platform } = {}) {
  if (platform === "win32") return;
  const mode = fs.statSync(target).isDirectory() ? 0o700 : 0o600;
  fs.chmodSync(target, mode);
}

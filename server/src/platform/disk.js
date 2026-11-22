// Free disk space of the disk that holds a folder (docs/SPEC.md section 12: a render is refused
// when the disk that holds `cache/` has too little room).
//
// `fs.statfs` answers on macOS, Linux and Windows. When it fails (a network share, an old
// Windows), the system's own tool is asked: `df -k -P <dir>` on Unix, PowerShell's `Get-PSDrive`
// on Windows. The parts that read their output are pure so the Windows half is tested anywhere.

import fs from "node:fs";
import path from "node:path";
import { runHelper } from "./process.js";

/**
 * The nearest folder that exists, starting at `dir` and going up (a cache folder that was not
 * made yet lives on the disk of its parent).
 * @param {string} dir
 * @returns {string}
 */
export function existingFolder(dir) {
  let current = path.resolve(dir);
  for (;;) {
    try {
      if (fs.statSync(current).isDirectory()) return current;
    } catch {
      // Go up.
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * Free bytes from the output of `df -k -P <dir>`: the "Available" column of the last row, in
 * 1024-byte blocks.
 * @param {string} output
 * @returns {number | null}
 */
export function parseDf(output) {
  const rows = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const last = rows.at(-1);
  if (rows.length < 2 || last === undefined) return null;
  // The file system name can hold spaces, so count from the right: ... Used Available Capacity Mount.
  const fields = last.split(/\s+/u);
  const capacityAt = fields.findLastIndex((field) => /^\d+%$/u.test(field));
  if (capacityAt < 1) return null;
  const blocks = Number(fields[capacityAt - 1]);
  return Number.isSafeInteger(blocks) && blocks >= 0 ? blocks * 1024 : null;
}

/**
 * The PowerShell command that prints the free bytes of the drive that holds `dir`.
 * @param {string} dir An absolute Windows path with a drive letter.
 * @returns {{ command: string, args: string[] } | null} `null` for a path without a drive letter
 *   (a UNC share: `statfs` is all there is).
 */
export function windowsFreeCommand(dir) {
  const drive = /^([A-Za-z]):/u.exec(dir);
  if (drive === null) return null;
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-PSDrive -Name ${drive[1]} -PSProvider FileSystem).Free`,
    ],
  };
}

/**
 * The number PowerShell printed.
 * @param {string} output
 * @returns {number | null}
 */
export function parsePowerShellFree(output) {
  const text = output.trim();
  if (!/^\d+$/u.test(text)) return null;
  const bytes = Number(text);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

/**
 * @param {string} dir
 * @returns {Promise<number | null>}
 */
async function fromTool(dir) {
  try {
    if (process.platform === "win32") {
      const plan = windowsFreeCommand(dir);
      if (plan === null) return null;
      const result = await runHelper({ ...plan, timeoutMs: 15_000 });
      return result.code === 0 ? parsePowerShellFree(result.stdout) : null;
    }
    const result = await runHelper({ command: "df", args: ["-k", "-P", dir], timeoutMs: 15_000 });
    return result.code === 0 ? parseDf(result.stdout) : null;
  } catch {
    return null;
  }
}

/**
 * Bytes a normal user can still write on the disk that holds `dir` (which need not exist yet).
 * Rejects when no way of asking works.
 * @param {string} dir
 * @returns {Promise<number>}
 */
export async function freeBytes(dir) {
  const real = existingFolder(dir);
  try {
    const stats = await fs.promises.statfs(real);
    const bytes = Number(stats.bavail) * Number(stats.bsize);
    if (Number.isFinite(bytes) && bytes >= 0) return bytes;
  } catch {
    // Ask the system's own tool.
  }
  const bytes = await fromTool(real);
  if (bytes === null) throw new Error(`the free space of ${real} cannot be read`);
  return bytes;
}

// Small helpers shared by the POSIX and the Windows process code.

import { execFile } from "node:child_process";

/**
 * Resolves after `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Whether a process with this id exists (also when it belongs to another user, and also while
 * it is a zombie that nobody has reaped yet). Works on Windows too.
 * @param {number} pid
 * @returns {boolean}
 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/**
 * Runs a short system tool and returns what it printed. A tool that fails still gives its
 * output (`ps -p` exits 1 when one of the ids is gone); one that cannot be started gives `null`.
 * @param {string} file
 * @param {readonly string[]} args
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ stdout: string, ok: boolean } | null>}
 */
export function runTool(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error === null) {
          resolve({ stdout, ok: true });
          return;
        }
        const code = /** @type {NodeJS.ErrnoException} */ (error).code;
        // A string code is a failure to start (ENOENT, EACCES); a number is the exit status.
        resolve(typeof code === "string" ? null : { stdout: stdout || "", ok: false });
      },
    );
  });
}

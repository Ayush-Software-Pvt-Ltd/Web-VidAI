// The command line of a running process, for the registry of recorded processes
// (`jobs/registry.js`): a recorded process id counts as the same process only while its command
// line is the recorded one, so a process id that the system reused is never ended (the check of
// `sweep_registry` in `platform/process/unix.rs`).

import { runTool } from "./process.common.js";

/**
 * The text of `Get-CimInstance` for one process (Windows).
 * @param {number} pid
 * @returns {string}
 */
export function windowsCommandScript(pid) {
  return `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").CommandLine`;
}

/**
 * Turns the output of the system tool into one command line: the first non-empty line, trimmed;
 * `null` when there is none.
 * @param {string} text
 * @returns {string | null}
 */
export function parseCommand(text) {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line === undefined ? null : line;
}

/**
 * The command line of `pid`, or `null` when there is no such process or it cannot be read.
 * @param {number} pid
 * @param {{ windows?: boolean }} [options] Default: this system.
 * @returns {Promise<string | null>}
 */
export async function commandOf(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const windows = options.windows ?? process.platform === "win32";
  const result = windows
    ? await runTool("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        windowsCommandScript(pid),
      ])
    : await runTool("/bin/ps", ["-o", "command=", "-p", String(pid)]);
  if (result === null || !result.ok) return null;
  return parseCommand(result.stdout);
}

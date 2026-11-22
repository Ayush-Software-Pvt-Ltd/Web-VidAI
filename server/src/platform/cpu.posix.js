// The process table with what the CPU governor needs (docs/SPEC.md section 9, CPU), on macOS and
// Linux. `process.posix.js` gives the tree and the CPU seconds in two separate `ps` calls and
// no start time; the governor needs all of it from ONE snapshot, because a pid may be reused
// between two calls (then CPU time would be charged to, and a signal sent to, a stranger).
//
// One `ps -axo pid=,ppid=,pgid=,stat=,lstart=,time=` is the snapshot. `lstart` is the start time
// of the process to the second; (pid, start) names one process for as long as the computer runs
// (the pid space must wrap around to reuse a pid, which takes far more than a second).
// On Linux `time` has whole seconds only, which makes the governor coarse there; the macOS value
// has a resolution of 10 ms. Linux is not a target of the server's limits, it only has to work.

import { execFile } from "node:child_process";
import { parseCpuTime } from "./process.posix.js";

/**
 * One process of the table.
 * @typedef {object} ProcessRow
 * @property {number} pid
 * @property {number} ppid
 * @property {number} pgid
 * @property {boolean} zombie Has ended, waits for its parent to collect it.
 * @property {boolean} stopped Is stopped by a signal (`ps` state `T`), by anyone.
 * @property {string} start The start time as `ps` prints it (`Sun Nov 22 10:11:12 2026`).
 * @property {number} cpu CPU seconds used so far (user plus system).
 */

/**
 * What the governor needs from the operating system; tests pass a scripted one.
 * @typedef {object} ProcessTable
 * @property {() => Promise<ProcessRow[] | null>} snapshot Every process now, `null` when `ps`
 *   cannot be run.
 * @property {(pid: number, signal: "SIGSTOP" | "SIGCONT") => boolean} signal Sends the signal to
 *   one process (never a group); `false` when it is gone. Never signals pid 1 or below, nor the
 *   server itself.
 */

const LINE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s*$/;

/**
 * Parses the output of `ps -axo pid=,ppid=,pgid=,stat=,lstart=,time=`. Lines that do not fit
 * are skipped.
 * @param {string} text
 * @returns {ProcessRow[]}
 */
export function parseTable(text) {
  /** @type {ProcessRow[]} */
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m === null) continue;
    const cpu = parseCpuTime(/** @type {string} */ (m[6]));
    if (cpu === null) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      zombie: /** @type {string} */ (m[4]).startsWith("Z"),
      stopped: /** @type {string} */ (m[4]).startsWith("T"),
      // Spaces are squeezed: `ps` pads single-digit days ("Nov  2") differently between systems.
      start: /** @type {string} */ (m[5]).replace(/\s+/g, " "),
      cpu,
    });
  }
  return rows;
}

/** @returns {Promise<ProcessRow[] | null>} */
export function snapshot() {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-axo", "pid=,ppid=,pgid=,stat=,lstart=,time="],
      {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 32 * 1024 * 1024,
        // LC_ALL=C: the month and day names of `lstart` must not depend on the user's language.
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout) => resolve(error === null ? parseTable(stdout) : null),
    );
  });
}

/**
 * @param {number} pid
 * @param {"SIGSTOP" | "SIGCONT"} signal
 * @returns {boolean}
 */
export function signal(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** @type {ProcessTable} */
export const processTable = { snapshot, signal };

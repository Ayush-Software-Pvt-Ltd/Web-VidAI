// The process table of the CPU governor (docs/SPEC.md section 9, CPU, macOS way): one snapshot
// with start times and CPU seconds, and a signal to one process. Only the POSIX half exists;
// Windows enforces the budget with a Job Object (`jobobject.windows.js`) and needs no table.

import { processTable } from "./cpu.posix.js";

export { parseTable } from "./cpu.posix.js";

/**
 * @typedef {import("./cpu.posix.js").ProcessRow} ProcessRow
 * @typedef {import("./cpu.posix.js").ProcessTable} ProcessTable
 */

/** The real process table of this computer (POSIX only; on Windows `snapshot` is `null`). */
export const systemProcessTable = /** @type {ProcessTable} */ (
  process.platform === "win32" ? { snapshot: async () => null, signal: () => false } : processTable
);

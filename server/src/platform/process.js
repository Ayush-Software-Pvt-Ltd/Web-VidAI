// Starting agent programs and handling their process trees, the same call on every system.
// The OS-specific halves are `process.posix.js` and `process.windows.js`; this file starts
// processes and picks the half.
//
// An agent runs in a process group (a session on Unix) of its own, so that its whole tree can be
// found and ended: `spawnAgent` never `unref`s it and never lets a console window flash up.

import { spawn } from "node:child_process";
import fs from "node:fs";
import { resolveLaunch, spawnPlan } from "./launch.js";
import * as posix from "./process.posix.js";
import * as windows from "./process.windows.js";

export { isAlive } from "./process.common.js";
export { parsePs, collectTree, parseCpuTime, parseCpuTable } from "./process.posix.js";
export { parseWindowsProcesses, parseWindowsCpu, collectWindowsTree } from "./process.windows.js";

const impl = process.platform === "win32" ? windows : posix;

/** The members of the tree of `rootPid` (see the platform files). */
export const listTree = impl.listTree;
/** Ends the tree of `rootPid`: SIGTERM or `taskkill`, then force after the grace time. */
export const endTree = impl.endTree;
/** CPU seconds used so far by each pid. */
export const cpuByPid = impl.cpuByPid;
/** The total CPU seconds used so far by the pids. */
export const treeCpuSeconds = impl.treeCpuSeconds;
/** Freezes a tree (SIGSTOP); always `false` on Windows. */
export const suspend = impl.suspend;
/** Continues a frozen tree (SIGCONT); always `false` on Windows. */
export const resume = impl.resume;

/**
 * @typedef {object} SpawnOptions
 * @property {string} command The program (a path; on Windows also a script or npm shim, see
 *   `launch.js`).
 * @property {readonly string[]} [args]
 * @property {string} [cwd]
 * @property {Readonly<Record<string, string | undefined>>} [env] The whole child environment
 *   (default: this server's).
 */

/**
 * @param {SpawnOptions} options
 * @param {import("node:child_process").StdioOptions} stdio
 * @returns {import("node:child_process").ChildProcess}
 */
function spawnChild(options, stdio) {
  const env = options.env ?? process.env;
  const plan = spawnPlan(resolveLaunch(options.command, env), options.args ?? []);
  const child = spawn(plan.file, plan.args, {
    cwd: options.cwd,
    env: /** @type {NodeJS.ProcessEnv} */ (env),
    stdio,
    // A new session on Unix: the child leads a process group (`pid === pgid`) that holds its
    // whole tree. Windows has no groups; the tree is found by parent id.
    detached: process.platform !== "win32",
    windowsHide: true,
    ...(plan.argv0 === undefined ? {} : { argv0: plan.argv0 }),
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
  // A start failure arrives later as an `error` event; it must never crash the server.
  child.on("error", () => {});
  if (child.pid === undefined) {
    throw startError(options);
  }
  return child;
}

/**
 * The error for a program that could not be started, with the likely reason.
 * @param {SpawnOptions} options
 * @returns {Error}
 */
function startError(options) {
  const { command, cwd } = options;
  if (cwd !== undefined && !fs.existsSync(cwd)) {
    return Object.assign(new Error(`cannot start ${command}: the folder ${cwd} does not exist`), {
      code: "ENOENT",
    });
  }
  const separated = command.includes("/") || command.includes("\\");
  if (separated && !fs.existsSync(command)) {
    return Object.assign(new Error(`cannot start ${command}: the file does not exist`), {
      code: "ENOENT",
    });
  }
  return Object.assign(new Error(`cannot start ${command}: it is not an executable program`), {
    code: separated ? "EACCES" : "ENOENT",
  });
}

/**
 * Starts an agent program with piped stdin, stdout and stderr, in a process group of its own.
 * Throws (with a `code` such as `ENOENT` or `EACCES`) when it cannot be started.
 * @param {SpawnOptions} options
 * @returns {import("node:child_process").ChildProcessByStdio<import("node:stream").Writable, import("node:stream").Readable, import("node:stream").Readable>}
 */
export function spawnAgent(options) {
  return /** @type {any} */ (spawnChild(options, ["pipe", "pipe", "pipe"]));
}

/** The most output of a helper that is kept (the rest is dropped). */
const HELPER_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * @typedef {object} HelperResult
 * @property {number | null} code
 * @property {NodeJS.Signals | null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 */

/**
 * Runs a short program (`claude --version`) to its end, without stdin, with a time limit; its
 * whole tree is ended when the limit is reached. Rejects when it cannot be started.
 * @param {SpawnOptions & { timeoutMs: number }} options
 * @returns {Promise<HelperResult>}
 */
export function runHelper(options) {
  return new Promise((resolve, reject) => {
    /** @type {import("node:child_process").ChildProcess} */
    let child;
    try {
      child = spawnChild(options, ["ignore", "pipe", "pipe"]);
    } catch (error) {
      reject(error);
      return;
    }
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    child.stdout?.on("data", (/** @type {Buffer} */ chunk) => {
      if (outBytes < HELPER_OUTPUT_BYTES) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr?.on("data", (/** @type {Buffer} */ chunk) => {
      if (errBytes < HELPER_OUTPUT_BYTES) err.push(chunk);
      errBytes += chunk.length;
    });
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    let timedOut = false;
    let settled = false;
    const pid = /** @type {number} */ (child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      void impl.endTree(pid, { graceMs: 500 });
    }, options.timeoutMs);
    /**
     * @param {number | null} code
     * @param {NodeJS.Signals | null} signal
     */
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A grandchild may still hold the pipes: let go of them so the server is not kept alive.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    };
    child.once("exit", (code, signal) => {
      // Output can still be in flight, and a grandchild can keep the pipes open: wait for the
      // pipes to close, but not for long.
      const wait = setTimeout(() => finish(code, signal), 500);
      child.once("close", () => {
        clearTimeout(wait);
        finish(code, signal);
      });
    });
  });
}

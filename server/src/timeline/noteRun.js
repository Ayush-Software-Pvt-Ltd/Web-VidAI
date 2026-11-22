// Runs the capture program for the change requests' pictures: like `runHelper`, but the caller can
// end it (`stop()`), because the capture starts a browser and must not outlive the server's stop
// (docs/SPEC.md section 11, Change requests). The whole process tree is ended on the time limit
// and on `stop()`; the child is never detached.

import { endTree, spawnAgent } from "../platform/process.js";

/** The most output that is kept. */
const OUTPUT_BYTES = 1024 * 1024;

/**
 * @typedef {object} RunOptions
 * @property {string} command
 * @property {readonly string[]} args
 * @property {string} [cwd]
 * @property {Readonly<Record<string, string | undefined>>} [env]
 * @property {number} timeoutMs
 */

/**
 * @typedef {object} RunResult
 * @property {number | null} code
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 * @property {boolean} stopped Ended by `stop()`.
 */

/**
 * @typedef {object} Run
 * @property {Promise<RunResult>} done Never rejects for a failure of the program itself except
 *   that it could not be started (then it rejects with the reason).
 * @property {() => Promise<void>} stop Ends the program's tree; `done` then answers `stopped`.
 */

/**
 * @typedef {(options: RunOptions) => Run} StartRun The seam the tests replace.
 */

/**
 * Starts a program with a time limit.
 * @type {StartRun}
 */
export function startRun(options) {
  /** @type {import("node:child_process").ChildProcess} */
  let started;
  let timedOut = false;
  let stopped = false;
  try {
    started = spawnAgent(options);
  } catch (error) {
    const failed = Promise.reject(error);
    failed.catch(() => {});
    return { done: failed, stop: async () => {} };
  }
  started.stdin?.end();
  /** @type {Buffer[]} */
  const out = [];
  /** @type {Buffer[]} */
  const err = [];
  let outBytes = 0;
  let errBytes = 0;
  started.stdout?.on("data", (/** @type {Buffer} */ chunk) => {
    if (outBytes < OUTPUT_BYTES) out.push(chunk);
    outBytes += chunk.length;
  });
  started.stderr?.on("data", (/** @type {Buffer} */ chunk) => {
    if (errBytes < OUTPUT_BYTES) err.push(chunk);
    errBytes += chunk.length;
  });
  started.stdout?.on("error", () => {});
  started.stderr?.on("error", () => {});
  const pid = /** @type {number} */ (started.pid);
  const timer = setTimeout(() => {
    timedOut = true;
    void endTree(pid, { graceMs: 500 });
  }, options.timeoutMs);
  const done = new Promise((resolve) => {
    let settled = false;
    /** @param {number | null} code */
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A grandchild may still hold the pipes: let go of them.
      started.stdout?.destroy();
      started.stderr?.destroy();
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        stopped,
      });
    };
    started.once("exit", (code) => {
      const wait = setTimeout(() => finish(code), 500);
      started.once("close", () => {
        clearTimeout(wait);
        finish(code);
      });
    });
  });
  return {
    done,
    async stop() {
      stopped = true;
      await endTree(pid, { graceMs: 500 });
    },
  };
}

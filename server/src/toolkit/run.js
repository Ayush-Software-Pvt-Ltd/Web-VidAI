// Running one program of the toolkit's preparation to its end (docs/SPEC.md section 7): Python,
// `python -m venv`, pip, the toolkit's own check. Its output goes line by line to the caller (the
// server log and Prepare's log) and the last lines are kept for the sentence that tells what went
// wrong. It can be ended from outside (the whole process tree), which is how `stop()` works.

import { endTree, spawnAgent } from "../platform/process.js";

/**
 * @typedef {object} RunRequest
 * @property {string} command
 * @property {readonly string[]} [args]
 * @property {string} [cwd]
 * @property {Readonly<Record<string, string | undefined>>} [env]
 * @property {number} timeoutMs
 * @property {AbortSignal} [signal] Aborting ends the process tree.
 * @property {(line: string) => void} [onLine] Every line of stdout and stderr, without the newline.
 *
 * @typedef {object} RunResult
 * @property {boolean} started `false` when the program could not be started at all.
 * @property {number | null} code The exit code; `null` when it was ended or never started.
 * @property {boolean} timedOut
 * @property {boolean} aborted
 * @property {string[]} tail The last lines it printed (at most `TAIL_LINES`).
 * @property {string | null} error Why it could not start, in words.
 *
 * @typedef {(request: RunRequest) => Promise<RunResult>} Runner
 */

/** How many of the last output lines a result keeps. */
export const TAIL_LINES = 60;

/** Grace time between asking a process tree to end and killing it. */
const GRACE_MS = 2000;

/**
 * Splits chunks of text into lines; `flush` hands out the unfinished last line.
 * @param {(line: string) => void} onLine
 * @returns {{ push(chunk: string): void, flush(): void }}
 */
export function lineSplitter(onLine) {
  let rest = "";
  return {
    push(chunk) {
      rest += chunk;
      let at = rest.search(/\r\n|\n|\r/);
      while (at >= 0) {
        const line = rest.slice(0, at);
        const eol = rest.startsWith("\r\n", at) ? 2 : 1;
        rest = rest.slice(at + eol);
        if (line.trim() !== "") onLine(line);
        at = rest.search(/\r\n|\n|\r/);
      }
    },
    flush() {
      if (rest.trim() !== "") onLine(rest);
      rest = "";
    },
  };
}

/**
 * The real runner.
 * @type {Runner}
 */
export function runProcess(request) {
  return new Promise((resolve) => {
    /** @type {string[]} */
    const tail = [];
    const keep = (/** @type {string} */ line) => {
      tail.push(line);
      if (tail.length > TAIL_LINES) tail.shift();
      request.onLine?.(line);
    };
    /** @type {ReturnType<typeof spawnAgent>} */
    let child;
    try {
      child = spawnAgent({
        command: request.command,
        args: request.args ?? [],
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.env === undefined ? {} : { env: request.env }),
      });
    } catch (error) {
      resolve({
        started: false,
        code: null,
        timedOut: false,
        aborted: false,
        tail,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    child.stdin.end();
    const out = lineSplitter(keep);
    const err = lineSplitter(keep);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    let timedOut = false;
    let aborted = false;
    let settled = false;
    const pid = /** @type {number} */ (child.pid);
    const end = () => void endTree(pid, { graceMs: GRACE_MS });
    const timer = setTimeout(() => {
      timedOut = true;
      end();
    }, request.timeoutMs);
    const onAbort = () => {
      aborted = true;
      end();
    };
    if (request.signal?.aborted) onAbort();
    else request.signal?.addEventListener("abort", onAbort, { once: true });

    /** @param {number | null} code */
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      out.flush();
      err.flush();
      resolve({ started: true, code, timedOut, aborted, tail, error: null });
    };
    child.once("error", (error) => {
      if (settled) return;
      resolve({
        started: false,
        code: null,
        timedOut,
        aborted,
        tail,
        error: error.message,
      });
      settled = true;
      clearTimeout(timer);
    });
    child.once("exit", (code) => {
      // Output may still be in flight and a grandchild may keep the pipes open: wait for the
      // pipes, but not for long.
      const wait = setTimeout(() => finish(code), 500);
      child.once("close", () => {
        clearTimeout(wait);
        finish(code);
      });
    });
  });
}

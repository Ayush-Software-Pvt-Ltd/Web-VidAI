// One Claude Code process driven over its stream-json protocol (docs/SPEC.md section 5,
// "Driving Claude Code"): messages go in on stdin, events come out of stdout, the exit comes
// after both are drained.
//
// This is only the process and its pipes. What the events mean for a job is `turnTracker.js`.

import { spawnAgent } from "../../platform/process.js";
import { interruptLine, parseLine, userMessageLine } from "./protocol.js";

/** @typedef {import("./protocol.js").StreamEvent} StreamEvent */
/** @typedef {import("../harness.js").AgentProcess} AgentProcess */

/** Longest stdout line kept; a longer line is skipped (never held whole in memory). */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** How many stderr lines are kept. */
export const STDERR_TAIL_LINES = 20;
/** Longest stderr line kept, in bytes (a longer line is cut). */
export const STDERR_LINE_BYTES = 2_000;

/**
 * How the process ended.
 * @typedef {object} ExitInfo
 * @property {number | null} code `null` when it was ended by a signal.
 * @property {NodeJS.Signals | null} signal The signal that ended it, if any.
 * @property {string[]} stderrTail The last lines of stderr, oldest first.
 */

/**
 * What a session reports to its owner, in order: zero or more `line` events, then `exited`
 * once. `at` is the time of the injected clock.
 * @typedef {{ type: "line", event: StreamEvent, at: number }
 *   | { type: "exited", exit: ExitInfo, at: number }} SessionEvent
 */

/**
 * @typedef {object} Timings
 * @property {number} [stdoutDrainMs] How long stdout may keep delivering after the process
 *   exited (a grandchild can hold the pipe open). Default 2000.
 * @property {number} [stderrDrainMs] The same for stderr. Default 200.
 */

/**
 * @typedef {object} StartOptions
 * @property {string} command The `claude` program.
 * @property {string} cwd The Editing Folder (or video folder) it works in.
 * @property {Readonly<Record<string, string | undefined>>} env The complete environment of the
 *   child (nothing else is inherited).
 * @property {string} [sessionId] A new session (`--session-id`). Exactly one of `sessionId` and
 *   `resumeId` is given.
 * @property {string} [resumeId] An existing session (`--resume`).
 * @property {string | null} [model]
 * @property {string | null} [effort]
 * @property {(event: SessionEvent) => void} onEvent Called in order; must not throw (when it
 *   does, the error is dropped so a bad callback cannot crash the server).
 * @property {Timings} [timings]
 * @property {{ now: () => number }} [clock]
 */

/**
 * @typedef {AgentProcess & { closeStdin: () => void }} ClaudeSession
 */

/**
 * The command-line arguments of SPEC section 5. `model` and `effort` are trimmed and left out
 * when empty. Never `--continue`: it would pick the newest session of the folder, not ours.
 * @param {{ sessionId?: string, resumeId?: string, model?: string | null, effort?: string | null }} options
 * @returns {string[]}
 */
export function buildArgs(options) {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
  ];
  const model = options.model?.trim();
  if (model) args.push("--model", model);
  const effort = options.effort?.trim();
  if (effort) args.push("--effort", effort);
  if (options.resumeId !== undefined && options.sessionId !== undefined) {
    throw new TypeError("give a sessionId or a resumeId, not both");
  }
  if (options.resumeId !== undefined) args.push("--resume", options.resumeId);
  else if (options.sessionId !== undefined) args.push("--session-id", options.sessionId);
  else throw new TypeError("a sessionId or a resumeId is required");
  return args;
}

/** Whether the process ended cleanly. @param {ExitInfo} exit @returns {boolean} */
export function exitSuccess(exit) {
  return exit.code === 0;
}

/**
 * The last non-empty stderr line (trimmed), or `null`.
 * @param {ExitInfo} exit
 * @returns {string | null}
 */
export function lastStderrLine(exit) {
  for (let i = exit.stderrTail.length - 1; i >= 0; i -= 1) {
    const line = (exit.stderrTail[i] ?? "").trim();
    if (line !== "") return line;
  }
  return null;
}

/**
 * Splits a byte stream into lines at `\n` without decoding it first (so a multi-byte character
 * cut by a chunk edge stays whole), tolerating `\r\n`. A line longer than `maxBytes` is
 * handled by `overflow`: `"skip"` drops it, `"truncate"` delivers its first `maxBytes`. Only up
 * to `maxBytes` of a line is ever held.
 */
export class LineSplitter {
  #maxBytes;
  #overflow;
  /** @type {Buffer[]} */
  #parts = [];
  #length = 0;
  #overflowed = false;
  #any = false;

  /**
   * @param {{ maxBytes: number, overflow: "skip" | "truncate" }} options
   */
  constructor(options) {
    this.#maxBytes = options.maxBytes;
    this.#overflow = options.overflow;
  }

  /** How many bytes of the current, unfinished line are held (never more than the limit). */
  get bufferedBytes() {
    return this.#length;
  }

  /**
   * @param {Buffer} chunk
   * @param {(line: Buffer) => void} onLine Gets each complete line without its newline.
   */
  push(chunk, onLine) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline < 0 ? chunk.length : newline;
      if (end > start) this.#append(chunk.subarray(start, end));
      this.#any = true;
      if (newline < 0) return;
      this.#emit(onLine, true);
      start = newline + 1;
    }
  }

  /**
   * The end of the input: a last line without a newline is delivered.
   * @param {(line: Buffer) => void} onLine
   */
  end(onLine) {
    if (this.#any) this.#emit(onLine, false);
  }

  /** @param {Buffer} segment */
  #append(segment) {
    const room = this.#maxBytes - this.#length;
    if (segment.length > room) this.#overflowed = true;
    if (room <= 0) return;
    const kept = segment.length > room ? segment.subarray(0, room) : segment;
    this.#parts.push(kept);
    this.#length += kept.length;
  }

  /**
   * @param {(line: Buffer) => void} onLine
   * @param {boolean} newline Whether the line ended with a newline (then a `\r` before it goes).
   */
  #emit(onLine, newline) {
    let line = Buffer.concat(this.#parts, this.#length);
    const skip = this.#overflowed && this.#overflow === "skip";
    this.#parts = [];
    this.#length = 0;
    this.#overflowed = false;
    this.#any = false;
    if (skip) return;
    if (newline && line.length > 0 && line[line.length - 1] === 0x0d) {
      line = line.subarray(0, line.length - 1);
    }
    onLine(line);
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Starts Claude Code. Throws when the program cannot be started (`code` `ENOENT` or `EACCES`).
 * @param {StartOptions} options
 * @returns {ClaudeSession}
 */
export function startSession(options) {
  const clock = options.clock ?? { now: () => Date.now() };
  const stdoutDrainMs = options.timings?.stdoutDrainMs ?? 2000;
  const stderrDrainMs = options.timings?.stderrDrainMs ?? 200;
  const args = buildArgs(options);
  const child = spawnAgent({ command: options.command, args, cwd: options.cwd, env: options.env });
  const pid = /** @type {number} */ (child.pid);

  /** @param {SessionEvent} event */
  const deliver = (event) => {
    try {
      options.onEvent(event);
    } catch {
      // A throwing callback must not take the server down.
    }
  };

  let finished = false;

  // stdout: lines in, events out.
  const stdoutSplitter = new LineSplitter({ maxBytes: MAX_LINE_BYTES, overflow: "skip" });
  /** @param {Buffer} line */
  const onStdoutLine = (line) => {
    if (finished) return;
    const event = parseLine(line.toString("utf8"));
    if (event !== null) deliver({ type: "line", event, at: clock.now() });
  };
  const stdoutDone = new Promise((resolve) => {
    child.stdout.on("data", (/** @type {Buffer} */ chunk) => {
      if (!finished) stdoutSplitter.push(chunk, onStdoutLine);
    });
    child.stdout.on("end", () => {
      stdoutSplitter.end(onStdoutLine);
      resolve(undefined);
    });
    child.stdout.on("error", () => resolve(undefined));
    child.stdout.on("close", () => resolve(undefined));
  });

  // stderr: the tail, for the error message of a crash.
  /** @type {string[]} */
  const tail = [];
  const stderrSplitter = new LineSplitter({ maxBytes: STDERR_LINE_BYTES, overflow: "truncate" });
  /** @param {Buffer} line */
  const onStderrLine = (line) => {
    if (finished) return;
    if (tail.length === STDERR_TAIL_LINES) tail.shift();
    tail.push(line.toString("utf8").trimEnd());
  };
  const stderrDone = new Promise((resolve) => {
    child.stderr.on("data", (/** @type {Buffer} */ chunk) => {
      if (!finished) stderrSplitter.push(chunk, onStderrLine);
    });
    child.stderr.on("end", () => {
      stderrSplitter.end(onStderrLine);
      resolve(undefined);
    });
    child.stderr.on("error", () => resolve(undefined));
    child.stderr.on("close", () => resolve(undefined));
  });

  // stdin: a broken pipe (the child ended) is a failed write, never a crash.
  let stdinOpen = true;
  let ended = false;
  child.stdin.on("error", () => {
    stdinOpen = false;
  });
  child.stdin.on("close", () => {
    stdinOpen = false;
  });

  /** @param {string} line */
  const writeLine = (line) => {
    if (!stdinOpen || ended || child.stdin.destroyed || !child.stdin.writable) {
      throw Object.assign(new Error("stdin is closed"), { code: "EPIPE" });
    }
    child.stdin.write(`${line}\n`, (error) => {
      if (error) stdinOpen = false;
    });
  };

  // The exit comes once, after the pipes drained (a grandchild may hold them open).
  child.once("exit", (code, signal) => {
    stdinOpen = false;
    void (async () => {
      await Promise.race([stdoutDone, sleep(stdoutDrainMs)]);
      await Promise.race([stderrDone, sleep(stderrDrainMs)]);
      finished = true;
      child.stdout.destroy();
      child.stderr.destroy();
      deliver({
        type: "exited",
        exit: { code, signal, stderrTail: [...tail] },
        at: clock.now(),
      });
    })();
  });

  let nextRequest = 0;
  const closeStdin = () => {
    if (ended) return;
    ended = true;
    if (!child.stdin.destroyed) child.stdin.end();
  };

  return {
    pid,
    sendUser(text) {
      writeLine(userMessageLine(text));
    },
    interrupt() {
      nextRequest += 1;
      const id = `vidai-interrupt-${nextRequest}`;
      writeLine(interruptLine(id));
      return id;
    },
    close: closeStdin,
    closeStdin,
  };
}

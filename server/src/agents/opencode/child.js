// The OpenCode 2 server process of one job (docs/SPEC.md section 8, "Driving OpenCode 2"):
// started in a process group of its own, its listening line, the tail of
// what it prints, the wait for it to be ready, and the end of its whole process tree.
//
// Nothing here knows HTTP; the address it reports is the only thing the rest of the driver needs
// from the process. Nothing is reported to the owner until it arms the exit (`exitReport`).

import { endTree, listTree, spawnAgent } from "../../platform/process.js";
import { terminalName } from "../../platform/opencodeLaunch.js";

/**
 * Every time limit of the driver. Tests shorten them; the defaults are what runs for real.
 * @typedef {object} Timings
 * @property {number} startLimitMs How long a server may take to say it is ready. Generous on
 *   purpose: a first start on a computer that never ran OpenCode can migrate its database and
 *   unpack itself, and a failing start says why long before this (it exits, or prints).
 * @property {number} firstNoticeMs When the first "still waiting" notice is given.
 * @property {number} noticeEveryMs How often the next ones follow.
 * @property {number} pollMs How often the wait for the listening line looks again.
 * @property {number} requestTimeoutMs Every request but the event stream.
 * @property {number} subscribeTimeoutMs How long the event stream may take to deliver its first
 *   event.
 * @property {number} exitNoticeMs How long a failed request waits to see whether the server died
 *   (then its exit says why).
 * @property {number} drainMs How long the exit report lets the event stream drain.
 * @property {number} stderrDrainMs How long it then waits for stderr to close.
 * @property {number} reconcileEveryMs How often a job that waits for background work asks the
 *   server what still runs.
 * @property {readonly number[]} reconnectGapsMs The waits before each reconnect of a dropped
 *   event stream; the last one repeats.
 * @property {number} closeGraceMs How long the server may take to end after its stdin closed
 *   before its tree is ended by force.
 * @property {number} failureOutputWaitMs How long a failed start waits for the last output.
 */

/** @type {Timings} */
export const DEFAULT_TIMINGS = {
  startLimitMs: 180_000,
  firstNoticeMs: 8_000,
  noticeEveryMs: 15_000,
  pollMs: 50,
  requestTimeoutMs: 30_000,
  subscribeTimeoutMs: 10_000,
  exitNoticeMs: 2_000,
  drainMs: 2_000,
  stderrDrainMs: 200,
  reconcileEveryMs: 30_000,
  reconnectGapsMs: [250, 500, 1_000, 2_000, 5_000],
  closeGraceMs: 3_000,
  failureOutputWaitMs: 500,
};

/**
 * @param {Partial<Timings> | undefined} overrides
 * @returns {Timings}
 */
export function resolveTimings(overrides) {
  return { ...DEFAULT_TIMINGS, ...overrides };
}

/** How many lines of output are kept. */
export const TAIL_LINES = 20;
/** Longest line kept, in bytes (the rest of a longer line is cut). */
export const LINE_BYTES = 2_000;
/** How many of the last lines a failed start puts into its error. */
export const FAILURE_LINES = 4;

/**
 * Splits what a pipe delivers into lines at `\n` and `\r` (a progress display ends its lines with
 * a carriage return, or not at all), keeping the half line. Works on bytes, so a character cut by
 * a chunk edge stays whole.
 */
export class PipeLines {
  /** @type {number[]} */
  #half = [];

  /**
   * The lines `chunk` completes. A line longer than `LINE_BYTES` is cut.
   * @param {Buffer} chunk
   * @returns {string[]}
   */
  push(chunk) {
    /** @type {string[]} */
    const done = [];
    for (const byte of chunk) {
      if (byte === 0x0a || byte === 0x0d) {
        if (this.#half.length > 0) {
          done.push(Buffer.from(this.#half).toString("utf8"));
          this.#half = [];
        }
      } else if (this.#half.length < LINE_BYTES) {
        this.#half.push(byte);
      }
    }
    return done;
  }

  /** The half line now. @returns {string} */
  half() {
    return Buffer.from(this.#half).toString("utf8");
  }

  /**
   * The end of the stream turns the half line into a line.
   * @returns {string | null}
   */
  finish() {
    if (this.#half.length === 0) return null;
    const line = this.half();
    this.#half = [];
    return line;
  }
}

/**
 * The output of a server: the last lines it printed (stdout lines that were not its listening
 * line, and stderr) and the half line each stream has at the moment.
 */
export class Output {
  /** @type {string[]} */
  #lines = [];
  #partialOut = "";
  #partialErr = "";

  /** @param {string} line */
  push(line) {
    const text = line.trim();
    if (text === "") return;
    if (this.#lines.length === TAIL_LINES) this.#lines.shift();
    this.#lines.push(text);
  }

  /**
   * @param {"out" | "err"} stream
   * @param {string} text
   */
  setPartial(stream, text) {
    if (stream === "out") this.#partialOut = text;
    else this.#partialErr = text;
  }

  /**
   * The last `n` lines, oldest first, with the non-empty half line of each stream last.
   * @param {number} n
   * @returns {string[]}
   */
  last(n) {
    const all = [...this.#lines];
    for (const partial of [this.#partialOut, this.#partialErr]) {
      const text = partial.trim();
      if (text !== "") all.push(text);
    }
    return all.slice(Math.max(0, all.length - n));
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
 * @typedef {object} ExitStatus
 * @property {number | null} code
 * @property {NodeJS.Signals | null} signal
 */

/**
 * @typedef {object} SpawnOptions
 * @property {string} program
 * @property {readonly string[]} args
 * @property {string} cwd
 * @property {Readonly<Record<string, string | undefined>>} env The complete environment.
 * @property {(line: string) => string | null} listening The server's address from one line of its
 *   stdout, once it listens.
 * @property {Timings} timings
 * @property {{ now: () => number }} clock
 * @property {NodeJS.Platform} [platform] Only for the advice a silent start gives.
 */

/** A running server process. */
export class ServerChild {
  #child;
  #program;
  #timings;
  #clock;
  #platform;
  #output = new Output();
  /** @type {string | null} */
  #url = null;
  /** @type {ExitStatus | null} */
  #status = null;
  /** @type {Promise<string>} */
  #urlPromise;
  /** @type {Promise<ExitStatus>} */
  #exitPromise;
  /** @type {Promise<void>} */
  #stdoutDone;
  /** @type {Promise<void>} */
  #stderrDone;
  #stderrClosed = false;
  #stdinClosed = false;

  /**
   * Starts the server. Throws when the program cannot be started (`code` `ENOENT` or `EACCES`).
   * @param {SpawnOptions} options
   */
  constructor(options) {
    this.#program = options.program;
    this.#timings = options.timings;
    this.#clock = options.clock;
    this.#platform = options.platform ?? process.platform;
    const child = spawnAgent({
      command: options.program,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
    });
    this.#child = child;
    // The server ends when its stdin closes; a broken pipe is a closed pipe, never a crash.
    child.stdin.on("error", () => {});

    /** @type {(url: string) => void} */
    let foundUrl = () => {};
    this.#urlPromise = new Promise((resolve) => {
      foundUrl = resolve;
    });

    // stdout: the listening line, then drained so the pipe never fills. Every other line before
    // it is kept for the error of a start that fails.
    const outLines = new PipeLines();
    /** @param {string} line */
    const onOutLine = (line) => {
      if (this.#url !== null) return;
      const found = options.listening(line.trim());
      if (found === null) {
        this.#output.push(line);
        return;
      }
      this.#url = found;
      this.#output.setPartial("out", "");
      foundUrl(found);
    };
    this.#stdoutDone = new Promise((resolve) => {
      child.stdout.on("data", (/** @type {Buffer} */ chunk) => {
        if (this.#url !== null) return;
        for (const line of outLines.push(chunk)) onOutLine(line);
        if (this.#url === null) this.#output.setPartial("out", outLines.half());
      });
      const end = () => {
        const rest = outLines.finish();
        if (rest !== null) onOutLine(rest);
        this.#output.setPartial("out", "");
        resolve();
      };
      child.stdout.on("end", end);
      child.stdout.on("error", end);
      child.stdout.on("close", end);
    });

    // stderr: the tail, for the error of a start that fails and of a crash.
    const errLines = new PipeLines();
    this.#stderrDone = new Promise((resolve) => {
      child.stderr.on("data", (/** @type {Buffer} */ chunk) => {
        for (const line of errLines.push(chunk)) this.#output.push(line);
        this.#output.setPartial("err", errLines.half());
      });
      const end = () => {
        const rest = errLines.finish();
        if (rest !== null) this.#output.push(rest);
        this.#output.setPartial("err", "");
        this.#stderrClosed = true;
        resolve();
      };
      child.stderr.on("end", end);
      child.stderr.on("error", end);
      child.stderr.on("close", end);
    });

    this.#exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        this.#status = { code, signal };
        resolve(this.#status);
      });
    });
  }

  /** The server process (and process group) id. @returns {number} */
  get pid() {
    return /** @type {number} */ (this.#child.pid);
  }

  /** Whether the process has ended. @returns {boolean} */
  get exited() {
    return this.#status !== null;
  }

  /** Resolves when the process has ended. @returns {Promise<ExitStatus>} */
  get exitedPromise() {
    return this.#exitPromise;
  }

  /**
   * Waits until the server says where it listens, it exits, or the limit is over; says "still
   * waiting" through `onStatus` while it takes long. Rejects with the reason.
   * @param {(text: string) => void} onStatus
   * @returns {Promise<string>}
   */
  async waitForUrl(onStatus) {
    const t = this.#timings;
    const begun = this.#clock.now();
    let nextNotice = t.firstNoticeMs;
    for (;;) {
      const step = await Promise.race([
        this.#urlPromise.then((url) => ({ url })),
        this.#exitPromise.then(() => ({ exited: true })),
        sleep(t.pollMs).then(() => ({})),
      ]);
      if ("url" in step) return step.url;
      if ("exited" in step) {
        // A listening line printed just before the exit still counts as an answer; give the
        // pipe a moment to deliver it.
        await Promise.race([this.#stdoutDone, sleep(t.drainMs)]);
        if (this.#url !== null) return this.#url;
        throw new Error("OpenCode ended before it was ready");
      }
      const elapsed = this.#clock.now() - begun;
      if (elapsed >= t.startLimitMs) {
        throw new Error(
          `OpenCode did not become ready within ${Math.floor(t.startLimitMs / 1000)} seconds${this.#silenceNote()}`,
        );
      }
      if (elapsed >= nextNotice) {
        onStatus(`Still waiting for OpenCode to start (${Math.floor(elapsed / 1000)} s)`);
        nextNotice = elapsed + t.noticeEveryMs;
      }
    }
  }

  /**
   * What to tell about a server that is alive but has said nothing: it prints nothing, and how
   * to see what it is doing (on the computer that runs VidAI, not the browser's).
   * @returns {string}
   */
  #silenceNote() {
    if (this.#output.last(1).length > 0) return "";
    return `, and it printed nothing. To see what it is waiting for, run "${this.#program} serve" in ${terminalName(this.#platform)} on the computer that runs VidAI; if that hangs too, reinstall OpenCode`;
  }

  /**
   * Ends a server that failed to start and says why, with the last lines it printed.
   * @param {string} message
   * @returns {Promise<Error>}
   */
  async failure(message) {
    await endTree(this.pid, { graceMs: 0 });
    // What the server printed says why; give the readers a moment to get it.
    await Promise.race([this.#stderrDone, sleep(this.#timings.failureOutputWaitMs)]);
    const last = this.#output.last(FAILURE_LINES);
    return new Error(last.length === 0 ? message : `${message} (${last.join(" | ")})`);
  }

  /**
   * Whether the server process ends within `ms`.
   * @param {number} ms
   * @returns {Promise<boolean>}
   */
  async endedWithin(ms) {
    if (this.exited) return true;
    return Promise.race([this.#exitPromise.then(() => true), sleep(ms).then(() => false)]);
  }

  /** Closes the pipe to the server's stdin. Idempotent. */
  closeStdin() {
    if (this.#stdinClosed) return;
    this.#stdinClosed = true;
    if (!this.#child.stdin.destroyed) this.#child.stdin.end();
  }

  /**
   * Ends the server: asks politely by closing its stdin, and ends what is left of its whole
   * process tree after `graceMs` (the tools it started run in groups of their own, and some
   * ignore SIGTERM). The tree is looked at before stdin closes, so a tool whose server already
   * went away is still found. Resolves when nothing of the tree is left.
   * @param {{ graceMs?: number }} [options]
   * @returns {Promise<boolean>}
   */
  async end(options = {}) {
    const known = await listTree(this.pid);
    this.closeStdin();
    return endTree(this.pid, {
      graceMs: options.graceMs ?? this.#timings.closeGraceMs,
      knownPids: known,
    });
  }

  /**
   * Ends the whole tree at once.
   * @returns {Promise<boolean>}
   */
  kill() {
    return endTree(this.pid, { graceMs: 0 });
  }

  /**
   * Waits for the process to exit, then for the event stream to finish (`streamDone`, up to
   * `drainMs`), then for stderr (up to `stderrDrainMs`), and gives how it ended with the tail of
   * its output, so the last events come before the exit.
   * @param {Promise<void>} streamDone
   * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null, stderrTail: string[] }>}
   */
  async exitReport(streamDone) {
    const status = await this.#exitPromise;
    await Promise.race([streamDone, sleep(this.#timings.drainMs)]);
    await Promise.race([this.#stderrDone, sleep(this.#timings.stderrDrainMs)]);
    if (!this.#stderrClosed) this.#child.stderr.destroy();
    this.#child.stdout.destroy();
    return {
      code: status.code,
      signal: status.signal,
      stderrTail: this.#output.last(TAIL_LINES),
    };
  }
}

/**
 * Starts the server process.
 * @param {SpawnOptions} options
 * @returns {ServerChild}
 */
export function spawnServer(options) {
  return new ServerChild(options);
}

// A Claude Code process in stream-json mode used only for control requests (`initialize`,
// `get_settings`, `get_usage`). It never receives a
// user message, so it never makes a model call.
//
// The process runs without MCP servers, hooks or session persistence, in a working folder inside
// the server's data directory, so it leaves nothing behind. Closing stdin makes it exit with
// code 0; `close()` ends what is left of its process tree for sure.
//
// Never send `mcp_status`: its answer contains the user's MCP server credentials.

import fs from "node:fs";
import { AppError, toAppError } from "../../errors.js";
import { endTree, spawnAgent } from "../../platform/process.js";
import { controlRequestLine } from "./protocol.js";
import { LineSplitter, MAX_LINE_BYTES } from "./session.js";

/**
 * Arguments of the helper process. `--settings` turns off the user's hooks for this process only
 * (a hook must not run every minute for a usage refresh) and keeps it from registering a Remote
 * Control session.
 */
export const HELPER_ARGS = Object.freeze([
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-mode",
  "bypassPermissions",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--settings",
  '{"disableAllHooks":true,"remoteControlAtStartup":false}',
]);

/** How long a closed helper may take to exit before its tree is ended. */
export const EXIT_GRACE_MS = 3000;

/** Keeps the last line of stderr (shortened) for error messages. */
const STDERR_TAIL_CHARS = 300;

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function shorten(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}...`;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The stdin line of a control request (with its newline).
 * @param {string} id
 * @param {string} subtype
 * @returns {string}
 */
export function requestLine(id, subtype) {
  return `${controlRequestLine(id, subtype)}\n`;
}

/**
 * The `response` object of a stdout line when it is a `control_response` with a request id, else
 * `null`. Every other line (system messages, noise, unknown types) is ignored.
 * @param {string} line
 * @returns {Record<string, unknown> | null}
 */
export function parseControlLine(line) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(line.trim());
  } catch {
    return null;
  }
  if (!isRecord(value) || value["type"] !== "control_response") return null;
  const response = value["response"];
  if (!isRecord(response) || typeof response["request_id"] !== "string") return null;
  return response;
}

/**
 * The inner `response` of a `success` answer, or an error with a readable message.
 * @param {string} subtype The request it answers.
 * @param {Record<string, unknown>} answer
 * @returns {unknown}
 * @throws {AppError}
 */
export function parseAnswer(subtype, answer) {
  if (answer["subtype"] === "success") return answer["response"] ?? null;
  const reason = typeof answer["error"] === "string" ? answer["error"] : "unknown error";
  throw new AppError(
    "internal",
    `Claude Code could not answer ${subtype}: ${shorten(reason, STDERR_TAIL_CHARS)}`,
  );
}

/**
 * @typedef {object} ControlClient A running helper process.
 * @property {number} pid
 * @property {number} startedAt When it was started (the clock's time).
 * @property {() => boolean} isAlive Whether the process runs and can take requests.
 * @property {(subtype: string, timeoutMs: number) => Promise<unknown>} request Sends one control
 *   request and waits up to `timeoutMs` for its answer: resolves with the inner `response` of a
 *   `success` answer; an `error` answer, an exit or a timeout rejects. A timeout rejects only
 *   that request (its late answer is ignored, answers are matched by id), so the next request
 *   can still be answered.
 * @property {() => Promise<void>} close Closes stdin, which makes Claude Code exit, waits briefly,
 *   then ends the whole process tree. Pending requests are rejected. Resolves once the process
 *   is gone; calling it again returns the same promise.
 */

/**
 * @typedef {object} StartControlOptions
 * @property {string} command The `claude` program.
 * @property {Readonly<Record<string, string | undefined>>} env The complete environment of the
 *   child (nothing else is inherited).
 * @property {string} cwd Created when missing.
 * @property {typeof spawnAgent} [spawn] Default: `spawnAgent`.
 * @property {{ now(): number }} [clock]
 * @property {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [timers]
 * @property {number} [exitGraceMs] Default `EXIT_GRACE_MS`.
 * @property {number} [killGraceMs] How long the tree may take to end after SIGTERM (default 500).
 */

/**
 * Starts `command` with `HELPER_ARGS` in `cwd` with exactly the environment `env`.
 * @param {StartControlOptions} options
 * @returns {ControlClient}
 * @throws {AppError} When the folder cannot be created or the program cannot be started.
 */
export function startControlClient(options) {
  const { command, env, cwd } = options;
  const spawn = options.spawn ?? spawnAgent;
  const clock = options.clock ?? { now: () => Date.now() };
  const timers = options.timers ?? { setTimeout, clearTimeout };
  const exitGraceMs = options.exitGraceMs ?? EXIT_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? 500;

  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new AppError("io", `Could not create the folder ${cwd}: ${why}`);
  }
  /** @type {ReturnType<typeof spawnAgent>} */
  let child;
  try {
    child = spawn({ command, args: HELPER_ARGS, cwd, env });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new AppError("internal", `Could not start Claude Code: ${why}`);
  }
  const pid = /** @type {number} */ (child.pid);
  const startedAt = clock.now();

  /** @type {Map<string, { subtype: string, settle: (result: { value: unknown } | { error: AppError }) => void }>} */
  const pending = new Map();
  let nextId = 0;
  let closing = false;
  let exited = false;
  /** Set once the exit was seen and the pipes were drained: why requests fail from then on. */
  let exitMessage = "";
  let stdinOpen = true;
  let stderrTail = "";

  // stdout: the answers.
  const stdout = new LineSplitter({ maxBytes: MAX_LINE_BYTES, overflow: "skip" });
  /** @param {Buffer} line */
  const onStdoutLine = (line) => {
    const answer = parseControlLine(line.toString("utf8"));
    if (answer === null) return;
    const entry = pending.get(/** @type {string} */ (answer["request_id"]));
    if (entry === undefined) return; // an answer to an earlier request that timed out
    pending.delete(/** @type {string} */ (answer["request_id"]));
    try {
      entry.settle({ value: parseAnswer(entry.subtype, answer) });
    } catch (error) {
      entry.settle({ error: toAppError(error) });
    }
  };
  const stdoutDone = new Promise((resolve) => {
    child.stdout.on("data", (/** @type {Buffer} */ chunk) => stdout.push(chunk, onStdoutLine));
    child.stdout.on("end", () => {
      stdout.end(onStdoutLine);
      resolve(undefined);
    });
    child.stdout.on("error", () => resolve(undefined));
    child.stdout.on("close", () => resolve(undefined));
  });

  // stderr: the last line, for the error message of a crash.
  const stderr = new LineSplitter({ maxBytes: 4096, overflow: "truncate" });
  /** @param {Buffer} line */
  const onStderrLine = (line) => {
    const text = line.toString("utf8").trim();
    if (text !== "") stderrTail = shorten(text, STDERR_TAIL_CHARS);
  };
  const stderrDone = new Promise((resolve) => {
    child.stderr.on("data", (/** @type {Buffer} */ chunk) => stderr.push(chunk, onStderrLine));
    child.stderr.on("end", () => {
      stderr.end(onStderrLine);
      resolve(undefined);
    });
    child.stderr.on("error", () => resolve(undefined));
    child.stderr.on("close", () => resolve(undefined));
  });

  // stdin: a broken pipe (the child ended) is a failed request, never a crash.
  child.stdin.on("error", () => {
    stdinOpen = false;
  });
  child.stdin.on("close", () => {
    stdinOpen = false;
  });

  /**
   * @param {number} ms
   * @returns {{ promise: Promise<void>, cancel: () => void }}
   */
  function wait(ms) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const promise = new Promise((resolve) => {
      timer = timers.setTimeout(resolve, ms);
      timer?.unref?.();
    });
    return { promise, cancel: () => timers.clearTimeout(timer) };
  }

  /**
   * @param {string} what
   * @returns {AppError}
   */
  function exitedError(what) {
    return new AppError(
      "internal",
      stderrTail === "" ? `Claude Code ${what}.` : `Claude Code ${what}: ${stderrTail}`,
    );
  }

  /** The process is gone: fail everything that waits, after the last answers were read. */
  const exitedPromise = new Promise((resolve) => {
    child.once("exit", () => {
      exited = true;
      stdinOpen = false;
      void (async () => {
        // The last words may still be in the pipes; a grandchild can hold them open, so not for long.
        const drain = wait(500);
        await Promise.race([stdoutDone, drain.promise]);
        drain.cancel();
        const tail = wait(100);
        await Promise.race([stderrDone, tail.promise]);
        tail.cancel();
        exitMessage = "stopped unexpectedly";
        for (const [id, entry] of [...pending]) {
          pending.delete(id);
          entry.settle({ error: exitedError(exitMessage) });
        }
        resolve(undefined);
      })();
    });
  });
  void exitedPromise;

  /** @type {Promise<void> | null} */
  let closed = null;

  return {
    pid,
    startedAt,

    isAlive() {
      return !closing && !exited && stdinOpen;
    },

    request(subtype, timeoutMs) {
      if (subtype === "mcp_status") {
        throw new TypeError("mcp_status returns credentials and is never sent");
      }
      if (closing) {
        return Promise.reject(new AppError("internal", "The Claude Code helper was closed."));
      }
      if (exited) return Promise.reject(exitedError(exitMessage || "stopped unexpectedly"));
      nextId += 1;
      const id = `vidai-${nextId}`;
      return new Promise((resolve, reject) => {
        const timer = timers.setTimeout(() => {
          pending.delete(id);
          reject(
            new AppError(
              "internal",
              `Claude Code did not answer within ${Math.max(1, Math.round(timeoutMs / 1000))} seconds.`,
            ),
          );
        }, timeoutMs);
        timer?.unref?.();
        pending.set(id, {
          subtype,
          settle(result) {
            timers.clearTimeout(timer);
            if ("value" in result) resolve(result.value);
            else reject(result.error);
          },
        });
        const fail = (/** @type {Error} */ err) => {
          const entry = pending.get(id);
          if (entry === undefined) return;
          pending.delete(id);
          stdinOpen = false;
          void (async () => {
            // Give the stderr reader a moment to catch the last words.
            const tail = wait(100);
            await Promise.race([stderrDone, tail.promise]);
            tail.cancel();
            entry.settle({ error: exitedError(`could not be reached (${err.message})`) });
          })();
        };
        if (!stdinOpen || child.stdin.destroyed || !child.stdin.writable) {
          fail(new Error("stdin is closed"));
          return;
        }
        child.stdin.write(requestLine(id, subtype), (error) => {
          if (error) fail(error);
        });
      });
    },

    close() {
      if (closed !== null) return closed;
      closing = true;
      for (const [id, entry] of [...pending]) {
        pending.delete(id);
        entry.settle({ error: new AppError("internal", "The Claude Code helper was closed.") });
      }
      closed = (async () => {
        stdinOpen = false;
        if (!child.stdin.destroyed) child.stdin.end();
        const grace = wait(exitGraceMs);
        await Promise.race([exitedPromise, grace.promise]);
        grace.cancel();
        // Also when it left by itself: a grandchild must not stay behind.
        await endTree(pid, { graceMs: killGraceMs });
        const end = wait(2000);
        await Promise.race([exitedPromise, end.promise]);
        end.cancel();
        child.stdout.destroy();
        child.stderr.destroy();
      })();
      return closed;
    },
  };
}

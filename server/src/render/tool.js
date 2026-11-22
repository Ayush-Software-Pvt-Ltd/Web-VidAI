// Running one child of a render (the renderer, ffprobe, ffmpeg) as a child of the server that
// the runner can end: it is never detached from the server's tree, it is recorded in the process
// registry while it runs (so a crashed server can end it on the next start) and counted by the
// limits module (so its CPU budget is enforced), and its output is handed to the caller line by
// line.

/**
 * What a started child looks like to this module (a `ChildProcess` fits).
 * @typedef {object} ChildLike
 * @property {number | undefined} pid
 * @property {{ on(event: string, listener: (chunk: Buffer | string) => void): unknown, setEncoding?(encoding: string): unknown } | null} stdout
 * @property {{ on(event: string, listener: (chunk: Buffer | string) => void): unknown, setEncoding?(encoding: string): unknown } | null} stderr
 * @property {{ end(): void, on?(event: string, listener: () => void): unknown } | null} [stdin]
 * @property {(event: "exit" | "close" | "error", listener: (...args: any[]) => void) => unknown} once
 */

/**
 * @typedef {object} ToolSpec
 * @property {string} command
 * @property {readonly string[]} args
 * @property {Readonly<Record<string, string | undefined>>} env
 * @property {string} [cwd]
 */

/**
 * @typedef {object} ToolHooks
 * @property {(spec: ToolSpec) => ChildLike} spawn
 * @property {(pid: number) => void | Promise<void>} [onStart] Called once with the pid, before any
 *   output is read (registry and limits).
 * @property {(pid: number) => void | Promise<void>} [onEnd] Called once when the child is gone.
 * @property {(line: string, stream: "stdout" | "stderr") => void} [onLine] Each output line.
 * @property {number} [keepBytes] The most output kept in the result (default 256 KB).
 * @property {number} [closeWaitMs] How long to wait for the pipes after the exit (default 500).
 */

/**
 * @typedef {object} ToolResult
 * @property {number | null} code
 * @property {NodeJS.Signals | null} signal
 * @property {string} stdout Kept output (the last part when it was long).
 * @property {string} stderr
 * @property {Error | null} startError Set when the program could not be started.
 */

const DEFAULT_KEEP = 256 * 1024;

/**
 * Splits a stream into lines; a progress bar ends its lines with a carriage return.
 * @param {(line: string) => void} emit
 * @returns {{ push(text: string): void, end(): void }}
 */
export function createLineSplitter(emit) {
  let rest = "";
  return {
    push(text) {
      rest += text;
      const parts = rest.split(/\r\n|\r|\n/u);
      rest = parts.pop() ?? "";
      for (const part of parts) if (part !== "") emit(part);
    },
    end() {
      if (rest !== "") emit(rest);
      rest = "";
    },
  };
}

/**
 * Starts the child and waits for its end. Never rejects.
 * @param {ToolSpec} spec
 * @param {ToolHooks} hooks
 * @returns {{ pid: number | null, done: Promise<ToolResult> }}
 */
export function runTool(spec, hooks) {
  /** @type {ChildLike} */
  let child;
  try {
    child = hooks.spawn(spec);
  } catch (error) {
    const startError = error instanceof Error ? error : new Error(String(error));
    return {
      pid: null,
      done: Promise.resolve({ code: null, signal: null, stdout: "", stderr: "", startError }),
    };
  }
  const pid = child.pid ?? null;
  const keep = hooks.keepBytes ?? DEFAULT_KEEP;
  const closeWait = hooks.closeWaitMs ?? 500;
  try {
    child.stdin?.end();
  } catch {
    // A child that closed its input already is fine.
  }

  const done = (async () => {
    if (pid !== null) {
      try {
        await hooks.onStart?.(pid);
      } catch {
        // The registry failing must not stop the render.
      }
    }
    /** @type {{ [K in "stdout" | "stderr"]: string }} */
    const kept = { stdout: "", stderr: "" };
    /** @param {"stdout" | "stderr"} name */
    const attach = (name) => {
      const splitter = createLineSplitter((line) => hooks.onLine?.(line, name));
      child[name]?.on("data", (chunk) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        kept[name] = (kept[name] + text).slice(-keep);
        splitter.push(text);
      });
      child[name]?.on("error", () => {});
      return splitter;
    };
    const splitters = [attach("stdout"), attach("stderr")];
    /** @type {Error | null} */
    let startError = null;
    const ended = await new Promise((resolve) => {
      let settled = false;
      /** @param {number | null} code @param {NodeJS.Signals | null} signal */
      const finish = (code, signal) => {
        if (settled) return;
        settled = true;
        resolve({ code, signal });
      };
      child.once("error", (/** @type {Error} */ error) => {
        startError = error;
        finish(null, null);
      });
      child.once(
        "exit",
        (/** @type {number | null} */ code, /** @type {NodeJS.Signals | null} */ signal) => {
          // Output can still be in flight, and a grandchild can keep the pipes open: wait for the
          // pipes to close, but not for long.
          const wait = setTimeout(() => finish(code, signal), closeWait);
          child.once("close", () => {
            clearTimeout(wait);
            finish(code, signal);
          });
        },
      );
    });
    for (const splitter of splitters) splitter.end();
    if (pid !== null) {
      try {
        await hooks.onEnd?.(pid);
      } catch {
        // See above.
      }
    }
    const { code, signal } = /** @type {{ code: number | null, signal: NodeJS.Signals | null }} */ (
      ended
    );
    return { code, signal, stdout: kept.stdout, stderr: kept.stderr, startError };
  })();
  return { pid, done };
}

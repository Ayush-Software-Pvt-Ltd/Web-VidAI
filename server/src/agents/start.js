// Starts one job's agent program, whichever it is (docs/SPEC.md section 5, "Harness, program and
// model"): the one call the job driver (`jobs/driver.js`) makes. It hides the three differences
// that `claude/session.js` (`startSession`) and `opencode/session.js` (`startOpencodeSession`)
// have, listed at the head of the latter, so the driver has one code path:
//
// - Asynchronous start. Claude Code starts at once, OpenCode 2 needs an HTTP server and a
//   session first (up to 180 seconds). `startAgent` is always a promise; a start that cannot be
//   made rejects (the text is the user's, scrubbed for OpenCode), with nothing left running.
// - The id of a new session. Claude Code takes the id it is given, OpenCode 2 chooses its own.
//   Here the caller never gives one: `startAgent` makes a UUID for Claude Code and takes
//   OpenCode's, and returns the id in use as `sessionId`, for a resume as well (it is `resumeId`).
//   The caller must record `sessionId` as the job's session once the start resolved.
// - A refused prompt. OpenCode 2 can refuse a message (HTTP error); Claude Code never does.
//   Here `sendUser` always returns a promise. It rejects with `code: "EPIPE"` when the program is
//   gone (its `exited` event follows: wait for that), and with `code: "REFUSED"` when the program
//   refused the message, in which case an error `result` event has ALREADY been delivered to
//   `onEvent` (the driver ends the job from that event and ignores the rejection).
// - After an error result. A Claude Code process whose turn ended in an error and an OpenCode
//   server do not end by themselves: the OpenCode server stays alive, and so can Claude Code. A
//   job that ends on an error result MUST call `close()`; it is safe to call at any time, also
//   twice, and also after the program exited. The `exited` event follows `close()` (OpenCode
//   2: after its whole tree, tools included, was ended; Claude Code: when its input closed and it
//   went idle), and `finished` resolves after that event was delivered, for both programs.
//
// Everything else is the `AgentProcess` of `harness.js`, with the events of `SessionEvent`.

import { randomUUID } from "node:crypto";
import { startSession } from "./claude/session.js";
import { startOpencodeSession } from "./opencode/session.js";

/** @typedef {import("./claude/session.js").SessionEvent} SessionEvent */
/** @typedef {import("./harness.js").Harness} Harness */
/** @typedef {import("../../../src/lib/wire/harness.ts").ApiOption} ApiOption */

/**
 * What to start. `claude/session.js` and `opencode/session.js` document the common fields.
 * @typedef {object} AgentSpec
 * @property {Harness} harness The program.
 * @property {string} command The `claude` or `opencode2` program.
 * @property {string} cwd The Editing Folder.
 * @property {Readonly<Record<string, string | undefined>>} env For Claude Code the child's whole
 *   environment, for OpenCode 2 the base environment of its server.
 * @property {string | null} [model] Claude Code: the model to ask for (`null`: its default).
 *   OpenCode 2: the model id (required).
 * @property {string | null} [effort]
 * @property {string | null} [resumeId] An existing session to resume; `null` or absent starts a
 *   new session.
 * @property {string} [title] OpenCode 2: the title of a new session (default "VidAI").
 * @property {string} [jobDir] OpenCode 2: the job's folder for its private configuration.
 * @property {ApiOption} [option] OpenCode 2: `opencodeGo` or `openaiApi`.
 * @property {string | null} [key] OpenCode 2: the key of the option, if any.
 * @property {string | null} [baseUrl] OpenCode 2: the normalized address, `null` for the
 *   option's default.
 * @property {boolean} [testLogin]
 * @property {readonly string[]} [secrets]
 * @property {Partial<import("./opencode/child.js").Timings>} [timings] Start and exit timings of
 *   the program (OpenCode 2 only; for Claude Code `stdoutDrainMs` and `stderrDrainMs`).
 * @property {{ now: () => number }} [clock]
 * @property {(text: string) => void} [onStatus] OpenCode 2: a notice for the job's log.
 * @property {(text: string) => void} [onWarn]
 * @property {typeof fetch} [fetch]
 * @property {NodeJS.Platform} [platform]
 * @property {(event: SessionEvent) => void} onEvent Called in order, then never again after
 *   `exited`.
 */

/**
 * A running program of one job.
 * @typedef {object} AgentHandle
 * @property {number} pid The root of the job's process tree.
 * @property {string} sessionId The session in use (made here, chosen by OpenCode, or resumed).
 * @property {Harness} harness
 * @property {(text: string) => Promise<void>} sendUser See the head of this file.
 * @property {() => string} interrupt Interrupts the running turn and returns the id that the
 *   `controlResponse` event answers. Throws (`code: "EPIPE"`) when the program is gone.
 * @property {() => void} close Ends the program (see the head); idempotent.
 * @property {Promise<void>} finished Resolves, never rejects, once `exited` was delivered.
 */

/**
 * @param {string} message
 * @returns {Error}
 */
function gone(message) {
  return Object.assign(new Error(message), { code: "EPIPE" });
}

/**
 * Starts the program of `spec`. Rejects when it cannot be started.
 * @param {AgentSpec} spec
 * @returns {Promise<AgentHandle>}
 */
export async function startAgent(spec) {
  /** @type {() => void} */
  let markExited = () => {};
  const finished = new Promise((resolve) => {
    markExited = () => resolve(undefined);
  });
  let exitedSeen = false;
  /** @param {SessionEvent} event */
  const onEvent = (event) => {
    if (exitedSeen) return;
    if (event.type === "exited") exitedSeen = true;
    try {
      spec.onEvent(event);
    } finally {
      if (event.type === "exited") markExited();
    }
  };
  const resumeId = spec.resumeId ?? null;

  if (spec.harness === "opencode2") {
    if (spec.model === null || spec.model === undefined || spec.jobDir === undefined) {
      throw new TypeError("OpenCode 2 needs a model and a jobDir");
    }
    if (spec.option === undefined) throw new TypeError("OpenCode 2 needs an option");
    const session = await startOpencodeSession({
      command: spec.command,
      cwd: spec.cwd,
      env: spec.env,
      jobDir: spec.jobDir,
      option: spec.option,
      key: spec.key ?? null,
      baseUrl: spec.baseUrl ?? null,
      model: spec.model,
      effort: spec.effort ?? null,
      ...(resumeId === null ? { title: spec.title ?? "VidAI" } : { resumeId }),
      onEvent,
      ...(spec.onStatus === undefined ? {} : { onStatus: spec.onStatus }),
      ...(spec.onWarn === undefined ? {} : { onWarn: spec.onWarn }),
      ...(spec.testLogin === undefined ? {} : { testLogin: spec.testLogin }),
      ...(spec.secrets === undefined ? {} : { secrets: spec.secrets }),
      ...(spec.timings === undefined ? {} : { timings: spec.timings }),
      ...(spec.clock === undefined ? {} : { clock: spec.clock }),
      ...(spec.fetch === undefined ? {} : { fetch: spec.fetch }),
      ...(spec.platform === undefined ? {} : { platform: spec.platform }),
    });
    session.finished.then(markExited, markExited);
    return {
      pid: session.pid,
      sessionId: session.sessionId,
      harness: "opencode2",
      async sendUser(text) {
        try {
          await session.sendUser(text);
        } catch (error) {
          if (/** @type {{ code?: unknown }} */ (error).code === "EPIPE") throw error;
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
            code: "REFUSED",
          });
        }
      },
      interrupt: () => session.interrupt(),
      close: () => session.close(),
      finished,
    };
  }

  const sessionId = resumeId ?? randomUUID();
  const session = startSession({
    command: spec.command,
    cwd: spec.cwd,
    env: spec.env,
    ...(resumeId === null ? { sessionId } : { resumeId }),
    model: spec.model ?? null,
    effort: spec.effort ?? null,
    onEvent,
    ...(spec.timings === undefined ? {} : { timings: spec.timings }),
    ...(spec.clock === undefined ? {} : { clock: spec.clock }),
  });
  return {
    pid: session.pid,
    sessionId,
    harness: "claudeCode",
    async sendUser(text) {
      try {
        session.sendUser(text);
      } catch (error) {
        throw gone(error instanceof Error ? error.message : String(error));
      }
    },
    interrupt() {
      try {
        return session.interrupt();
      } catch (error) {
        throw gone(error instanceof Error ? error.message : String(error));
      }
    },
    close: () => session.close(),
    finished,
  };
}

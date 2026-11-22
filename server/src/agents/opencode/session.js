// Starts one job's OpenCode 2 session (docs/SPEC.md section 8, "Driving OpenCode 2"): the
// OpenCode counterpart of `startSession` in `claude/session.js`. What it returns is an
// `AgentProcess` of the job engine, and what it reports is the same `SessionEvent` stream (`line`
// events in the Claude Code vocabulary, then `exited` once), so the engine does not know which
// program runs.
//
// What differs from `startSession`, and why:
// - It is asynchronous: OpenCode's server must say where it listens, accept the event stream and
//   create or resume the session before a message can be sent, which takes HTTP calls (and, on a
//   first start, up to the 180 second start limit).
// - The id of a new session is chosen by OpenCode, so it comes back in the result (`sessionId`),
//   it is not an option. A resume names the OpenCode session in `resumeId`.
// - `env` is the environment of the server's own process, not the child's: the launcher removes
//   the variables that would change a run, adds the key, the password and the configuration, and
//   keeps the user's own OpenCode configuration out (`launch.js`).
// - `close()` ends the whole process tree (the server and the tools it started), not only the
//   pipe; `sendUser` returns a promise that rejects when OpenCode refuses the message; `interrupt`
//   returns its id at once and the `controlResponse` event follows when the server answered.

import { buildLaunch } from "./launch.js";
import { resolveTimings } from "./child.js";
import { startServer } from "./server.js";

/** @typedef {import("../claude/session.js").SessionEvent} SessionEvent */
/** @typedef {import("../harness.js").AgentProcess} AgentProcess */
/** @typedef {import("../../../../src/lib/wire/harness.ts").ApiOption} ApiOption */

/**
 * @typedef {object} OpencodeStartOptions
 * @property {string} command The `opencode2` program.
 * @property {string} cwd The Editing Folder (the server's working directory and the session's
 *   folder).
 * @property {Readonly<Record<string, string | undefined>>} env The base environment: the server's
 *   own, as `agentEnv` gives it for the job.
 * @property {string} jobDir The job's own folder for what the server needs on disk (the private
 *   configuration folder); made here, removed when the server ends. The engine passes
 *   `<data dir>/opencode/<job id>`.
 * @property {ApiOption} option `opencodeGo` or `openaiApi`.
 * @property {string | null} key The key of the option; `null` when it is optional and not saved.
 * @property {string | null} baseUrl The normalized address; `null` is the default of the option.
 * @property {string} model The model id.
 * @property {string | null} effort The reasoning effort; `null` is the model's default.
 * @property {string} [title] A new session with this title. Exactly one of `title` and `resumeId`.
 * @property {string} [resumeId] An existing OpenCode session.
 * @property {(event: SessionEvent) => void} onEvent Called in order; must not throw (when it does,
 *   the error is dropped).
 * @property {(text: string) => void} [onStatus] A notice for the job's log, one line.
 * @property {(text: string) => void} [onWarn] Something that could not be done and does not stop
 *   the job.
 * @property {boolean} [testLogin] The end-to-end test switch (`testLoginRequested`).
 * @property {readonly string[]} [secrets] More texts that must never appear in what is reported.
 * @property {Partial<import("./child.js").Timings>} [timings]
 * @property {{ now: () => number }} [clock]
 * @property {typeof fetch} [fetch]
 * @property {NodeJS.Platform} [platform]
 */

/**
 * A running session: an `AgentProcess` plus what OpenCode decided.
 * @typedef {Omit<AgentProcess, "sendUser"> & {
 *   sessionId: string,
 *   model: string,
 *   sendUser: (text: string) => Promise<void>,
 *   finished: Promise<void>,
 * }} OpencodeSession
 */

/**
 * Starts the server and the session of one job. Rejects when it cannot (the error is a sentence
 * for the user, with the last lines the server printed); nothing is left running or on disk then.
 * Throws a `TypeError` for an option the program cannot run or for neither or both of `title` and
 * `resumeId`.
 * @param {OpencodeStartOptions} options
 * @returns {Promise<OpencodeSession>}
 */
export async function startOpencodeSession(options) {
  if (options.option !== "opencodeGo" && options.option !== "openaiApi") {
    throw new TypeError(`OpenCode 2 cannot run the option ${String(options.option)}`);
  }
  if ((options.title === undefined) === (options.resumeId === undefined)) {
    throw new TypeError("give a title (new session) or a resumeId, not both and not neither");
  }
  const launch = buildLaunch({
    program: options.command,
    editingFolder: options.cwd,
    baseEnv: options.env,
    option: options.option,
    key: options.key,
    baseUrl: options.baseUrl,
    modelId: options.model,
    effort: options.effort?.trim() ? options.effort.trim() : null,
    jobDir: options.jobDir,
    testLogin: options.testLogin,
    platform: options.platform,
  });
  const key = options.key?.trim();
  return startServer(
    {
      launch,
      session:
        options.resumeId === undefined
          ? { title: /** @type {string} */ (options.title) }
          : { resumeId: options.resumeId },
      timings: resolveTimings(options.timings),
      clock: options.clock ?? { now: () => Date.now() },
      fetch: options.fetch ?? globalThis.fetch,
      jobDir: options.jobDir,
      secrets: [...(key ? [key] : []), ...(options.secrets ?? [])],
      platform: options.platform,
    },
    {
      onEvent: options.onEvent,
      onStatus: options.onStatus ?? (() => {}),
      onWarn: options.onWarn ?? (() => {}),
    },
  );
}

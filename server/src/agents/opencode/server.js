// One OpenCode 2 server and its session (docs/SPEC.md section 8, "Driving OpenCode 2"):
// starts the process, finds the model, creates or resumes the
// session, feeds the event stream through the translator (`events.js`) and carries out what it asks,
// and gives the job engine the same few calls as a Claude Code session.
//
// Start order, which matters:
// 1. the process starts and prints its address (or the start fails with what it printed);
// 2. the event stream connects and its first event arrives, BEFORE the session is made, so no event
//    of the session can be missed;
// 3. the model is chosen (OpenCode's own provider on VidAI's key, else VidAI's provider) and the
//    reasoning effort becomes the model's `variant` when the model offers it;
// 4. the session is created, or resumed (a session OpenCode does not have is reported as Claude
//    Code reports it, `resumeNotFound`);
// 5. the translator is armed: from now on events and the exit are reported.
//
// Nothing of the process is left behind by a start that fails, and every text that leaves here has
// the key and the password replaced.

import { scrubKey } from "../setups.js";
import { spawnServer } from "./child.js";
import { createTranslator, QUESTION_CANCELLED, resumeNotFound } from "./events.js";
import { USERNAME, listeningUrl, modelText, removeJobFiles, variantForEffort } from "./launch.js";
import { createApi, encode } from "./serverApi.js";
import { createEventStream } from "./serverStream.js";

/** @typedef {import("../claude/session.js").SessionEvent} SessionEvent */
/** @typedef {import("./launch.js").Launch} Launch */
/** @typedef {import("./launch.js").ModelRef} ModelRef */
/** @typedef {import("./child.js").Timings} Timings */

/** How many event ids are remembered to drop an event a reconnect delivers again. */
const SEEN_EVENTS = 2_000;

/**
 * @typedef {object} ServerConfig
 * @property {Launch} launch The server process and the model to ask for first.
 * @property {{ title: string } | { resumeId: string }} session A new session with this title, or
 *   an existing session of OpenCode.
 * @property {Timings} timings
 * @property {{ now: () => number }} clock
 * @property {typeof fetch} fetch
 * @property {string} jobDir The job's own folder; what the server left in it is removed at its end.
 * @property {string[]} secrets Texts that never leave this module (the key; the password is added).
 * @property {NodeJS.Platform} [platform]
 */

/**
 * @typedef {object} ServerHooks
 * @property {(event: SessionEvent) => void} onEvent
 * @property {(text: string) => void} onStatus A notice for the job's log (still waiting, an effort
 *   that is not used), one line.
 * @property {(text: string) => void} onWarn Something that could not be done and does not stop the
 *   job.
 */

/**
 * @typedef {object} RunningServer
 * @property {number} pid
 * @property {string} sessionId
 * @property {string} model `provider/model` the session runs.
 * @property {(text: string) => Promise<void>} sendUser
 * @property {() => string} interrupt
 * @property {() => void} close
 * @property {Promise<void>} finished Resolves after the exit was reported and the job's files are
 *   removed.
 */

/**
 * @param {string} message
 * @returns {Error}
 */
function brokenPipe(message) {
  return Object.assign(new Error(message), { code: "EPIPE" });
}

/**
 * Starts the server and its session. Rejects, with nothing left running or on disk, when it cannot.
 * @param {ServerConfig} config
 * @param {ServerHooks} hooks
 * @returns {Promise<RunningServer>}
 */
export async function startServer(config, hooks) {
  const { launch, timings, clock } = config;
  const secrets = [...config.secrets, launch.password];
  /** @param {string} text */
  const scrub = (text) => secrets.reduce((out, secret) => scrubKey(out, secret), text);
  const cleanFiles = () => removeJobFiles(config.jobDir, config.platform);

  /** @param {SessionEvent} event */
  const deliverEvent = (event) => {
    try {
      hooks.onEvent(event);
    } catch {
      // A throwing callback must not take the server down.
    }
  };
  /** @param {import("../claude/protocol.js").StreamEvent} event */
  const deliverLine = (event) => deliverEvent({ type: "line", event, at: clock.now() });
  /** @param {(text: string) => void} hook @returns {(text: string) => void} */
  const safe = (hook) => (text) => {
    try {
      hook(scrub(text));
    } catch {
      // Same.
    }
  };
  const status = safe(hooks.onStatus);
  const warn = safe(hooks.onWarn);

  /** @type {import("./child.js").ServerChild} */
  let child;
  try {
    child = spawnServer({
      program: launch.command.program,
      args: launch.command.args,
      cwd: launch.command.cwd,
      env: launch.command.env,
      listening: listeningUrl,
      timings,
      clock,
      platform: config.platform,
    });
  } catch (error) {
    cleanFiles();
    throw new Error(scrub(error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  }

  /** @type {import("./serverStream.js").EventStream | null} */
  let stream = null;
  /** The start failed: nothing of the server stays, and the error says why. @param {unknown} error */
  const fail = async (error) => {
    stream?.stop();
    const message = error instanceof Error ? error.message : String(error);
    const failure = await child.failure(scrub(message));
    cleanFiles();
    return new Error(scrub(failure.message), { cause: error });
  };

  /** @type {string} */
  let base;
  try {
    base = await child.waitForUrl(status);
  } catch (error) {
    throw await fail(error);
  }

  const api = createApi({
    base,
    password: launch.password,
    directory: launch.directory,
    requestTimeoutMs: timings.requestTimeoutMs,
    fetch: config.fetch,
    onWarn: warn,
  });

  /** @type {ReturnType<typeof createTranslator> | null} */
  let translator = null;
  let armed = false;
  /** @type {Set<string>} */
  const seen = new Set();

  /** The data of one event of the stream. @param {string} data */
  const feed = (data) => {
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    // A reconnect may deliver events again: each id is handled once.
    const id = /** @type {{ id?: unknown } | null} */ (parsed)?.id;
    if (typeof id === "string") {
      if (seen.has(id)) return;
      seen.add(id);
      if (seen.size > SEEN_EVENTS) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
    }
    if (translator === null) return;
    const translated = translator.translate(parsed);
    for (const action of translated.actions) api.answer(action, QUESTION_CANCELLED);
    if (armed) for (const event of translated.events) deliverLine(event);
  };

  stream = createEventStream({
    url: `${base}/api/event`,
    headers: {
      authorization: `Basic ${Buffer.from(`${USERNAME}:${launch.password}`).toString("base64")}`,
      "x-opencode-directory": encode(launch.directory),
    },
    fetch: config.fetch,
    firstEventTimeoutMs: timings.subscribeTimeoutMs,
    reconnectGapsMs: timings.reconnectGapsMs,
    serverAlive: () => !child.exited,
    onData: feed,
  });
  const streamHandle = stream;

  /** @type {ModelRef} */
  let model;
  /** @type {string} */
  let sessionId;
  let missing = false;
  try {
    await streamHandle.connected;
    model = await api.chooseModel(launch.model, launch.testLogin);
    /** @type {string | null} */
    let variant = null;
    if (launch.effort !== null) {
      const offered = await api.variants(model);
      const choice = variantForEffort(model, launch.effort, offered);
      variant = choice.variant;
      if (choice.note !== null) status(choice.note);
    }
    if ("resumeId" in config.session) {
      sessionId = config.session.resumeId;
      missing = !(await api.resumeSession(sessionId, model, variant));
    } else {
      sessionId = await api.createSession(config.session.title, model, variant);
    }
  } catch (error) {
    throw await fail(error);
  }

  translator = createTranslator({
    sessionId,
    model: modelText(model),
    directory: launch.directory,
  });
  armed = true;

  let closed = false;
  /** @type {Promise<unknown> | null} */
  let ending = null;
  /** @type {NodeJS.Timeout | null} */
  let watchTimer = null;
  const stopWatching = () => {
    if (watchTimer !== null) clearTimeout(watchTimer);
    watchTimer = null;
  };

  // The exit comes once, after the last events (or a short wait) and the last stderr.
  const finished = (async () => {
    const report = await child.exitReport(streamHandle.done);
    stopWatching();
    streamHandle.stop();
    // Whatever the server's tools left running goes with it, whether it was closed or ended alone.
    ending ??= child.end().catch(() => false);
    await ending;
    cleanFiles();
    deliverEvent({
      type: "exited",
      exit: { ...report, stderrTail: report.stderrTail.map(scrub) },
      at: clock.now(),
    });
  })();
  finished.catch(() => {});

  const close = () => {
    if (closed) return;
    closed = true;
    stopWatching();
    ending = child.end().catch(() => false);
  };

  // While the main session only waits for background work, the server's job list is checked.
  const watch = () => {
    watchTimer = setTimeout(() => {
      void (async () => {
        if (closed || child.exited || translator === null) return;
        if (translator.waitingForBackground()) {
          const running = await api.runningJobs(sessionId);
          if (running !== null && translator.waitingForBackground()) {
            for (const event of translator.reconcile(running)) deliverLine(event);
          }
        }
        if (!closed && !child.exited) watch();
      })();
    }, timings.reconcileEveryMs);
    watchTimer.unref();
  };

  if (missing) {
    deliverLine(resumeNotFound(sessionId));
    close();
  } else {
    watch();
  }

  /** @param {string} text */
  const send = async (text) => {
    const t = /** @type {NonNullable<typeof translator>} */ (translator);
    t.promptSent();
    /** @type {string} */
    let message;
    try {
      const { status: code, text: body } = await api.request(
        "POST",
        `/api/session/${encode(sessionId)}/prompt`,
        { text },
      );
      if (code >= 200 && code < 300) return;
      message = `OpenCode refused the message (HTTP ${code}): ${body.trim().slice(0, 500)}`;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      // A server that died meanwhile reports its own end (with its last words) next, like a
      // Claude Code process whose stdin is gone.
      if (await child.endedWithin(timings.exitNoticeMs)) throw brokenPipe(scrub(message));
    }
    message = scrub(message);
    for (const event of t.promptRefused(message)) deliverLine(event);
    throw new Error(message);
  };

  let nextRequest = 0;

  return {
    pid: child.pid,
    sessionId,
    model: modelText(model),
    sendUser(text) {
      if (closed) throw brokenPipe("the server is closed");
      const sent = send(text);
      sent.catch(() => {});
      return sent;
    },
    interrupt() {
      if (closed || child.exited) throw brokenPipe("the server is closed");
      nextRequest += 1;
      const requestId = `vidai-interrupt-${nextRequest}`;
      translator?.abortRequested();
      void (async () => {
        let success = false;
        /** @type {string | null} */
        let error;
        try {
          const result = await api.interrupt(sessionId);
          success = result.success;
          error = result.error;
          if (success) await api.stopBackground(sessionId);
        } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure);
        }
        deliverLine({
          type: "controlResponse",
          requestId,
          success,
          error: error === null ? null : scrub(error),
        });
      })();
      return requestId;
    },
    close,
    finished,
  };
}

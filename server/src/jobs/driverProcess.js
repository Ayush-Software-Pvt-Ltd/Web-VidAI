// One program of one job, from its start to its end (`run_process`, `drive`, `idle`, `pause`,
// `stop`, `close_and_wait`, `end_tree` and `wait_until` of `driver.rs`): starts it, sends the
// message, reads its events, decides when it is finished (docs/SPEC-desktop.md section 6, "Keeping
// a job going"), carries out a pause or a stop, and leaves no process behind.
//
// It is the Rust loop over the driver's channel, as one async function: every wait is a read of
// the mailbox with a limit (`driverMailbox.js`), so a request of the manager is seen at the next
// wait. A continuation is written only while no pause or stop was requested (`d.halted()`).

import { isResumeNotFound } from "../agents/claude/protocol.js";
import { TurnTracker } from "../agents/claude/turnTracker.js";
import { startAgent as realStartAgent } from "../agents/start.js";
import { observe, exitedByItself, errorEnd, firstLine } from "./driverObserve.js";
import { programName, spawnFailed, stalled, stuck, missingOutput } from "./errors.js";
import { statusLine } from "./keepgoing.js";
import { createDescriber, statusDraft } from "./logDescribe.js";
import { createWorkerWatch } from "./workBusy.js";

/** @typedef {import("./driverState.js").DriverState} DriverState */
/** @typedef {import("./driverObserve.js").ProcessEnd} ProcessEnd */

/**
 * What one program is started with.
 * @typedef {object} Launch
 * @property {string | null} resumeId The session to resume, or `null` for a new one.
 * @property {string} message The first message of this program.
 * @property {string} fullMessage The message of a new session when the session cannot be resumed.
 * @property {string} sentLine What to say in the log when the message is sent.
 */

/**
 * The state of one running program.
 * @typedef {object} Proc
 * @property {import("../agents/start.js").AgentHandle} handle
 * @property {number} gen
 * @property {TurnTracker} tracker
 * @property {ReturnType<typeof createDescriber>} describer
 * @property {{ resetsAt: number | null } | null} limit A rejected rate limit event, once seen.
 * @property {import("../agents/claude/protocol.js").TurnResult | null} error An error result that
 *   still has to be handled.
 * @property {string | null} interrupting The id of an interrupt that was sent.
 * @property {boolean} halted A pause or stop was found requested: nothing more is decided.
 * @property {boolean} interruptAnswered
 * @property {number} lastTreeRefresh
 * @property {Set<number>} known Every process of the tree seen so far (the registry knows them).
 * @property {import("./workBusy.js").WorkerWatch} workers
 */

/** @param {DriverState} d */
const program = (d) => programName(d.ctx.agent.harness);

/**
 * The message to the user for a program that could not be started.
 * @param {DriverState} d
 * @param {string} reason
 * @returns {string}
 */
function notStarted(d, reason) {
  return d.ctx.agent.harness === "opencode2"
    ? `The ${program(d)} program could not be started: ${d.ctx.sink.scrub?.(reason) ?? reason}`
    : spawnFailed(d.ctx.sink.scrub?.(reason) ?? reason, d.ctx.agent.harness);
}

/**
 * Starts the program of `launch`, drives it to its end and reports how it ended.
 * @param {DriverState} d
 * @param {Launch} launch
 * @returns {Promise<ProcessEnd>}
 */
export async function runProcess(d, launch) {
  // A request that arrived before anything started needs no process at all.
  if (d.request !== null) return { kind: d.requestedEnd() };
  const { ctx } = d;
  if (!d.beforeChangeDone && ctx.beforeChange !== undefined) {
    d.beforeChangeDone = true;
    const change = ctx.beforeChange;
    const attempt = (async () => {
      try {
        await change();
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    const waited = await d.raceRequest(attempt);
    if (!waited.done) return { kind: d.requestedEnd() };
    if (waited.value !== null) return { kind: "failed", message: waited.value };
  }

  d.gen += 1;
  const gen = d.gen;
  const start = ctx.startAgent ?? realStartAgent;
  const starting = start({
    ...ctx.agent,
    resumeId: launch.resumeId,
    onEvent: (event) => d.mailbox.push({ type: "event", gen, event }),
    onStatus: (text) => d.status(text),
  }).then(
    (handle) => ({ handle, error: null }),
    (error) => ({ handle: null, error: error instanceof Error ? error.message : String(error) }),
  );
  const started = await d.raceRequest(starting);
  if (!started.done) {
    // The program is still starting: wait for it, then let it go (nothing is left running).
    const late = await starting;
    if (late.handle !== null) await abandon(d, late.handle);
    return { kind: d.requestedEnd() };
  }
  const { handle, error } = started.value;
  if (handle === null) return { kind: "failed", message: notStarted(d, error ?? "") };

  if (handle.sessionId !== d.sessionId) {
    d.sessionId = handle.sessionId;
    d.update({ sessionId: handle.sessionId });
  }
  ctx.limiter?.jobStarted(handle.pid);
  d.limiterOn = true;
  const name = program(d);
  let detail =
    launch.resumeId === null ? `Started a new ${name} session` : `Resumed the ${name} session`;
  if (ctx.agent.harness === "claudeCode" && ctx.job.serviceName !== undefined) {
    detail += ` on ${ctx.job.serviceName}`;
  }
  const settings = [];
  if (ctx.agent.model) settings.push(`model ${ctx.agent.model}`);
  if (ctx.agent.effort) settings.push(`effort ${ctx.agent.effort}`);
  if (settings.length > 0) detail += ` (${settings.join(", ")})`;
  d.status(detail);

  const now = d.clock.now();
  /** @type {Proc} */
  const proc = {
    handle,
    gen,
    tracker: new TurnTracker(now),
    describer: createDescriber({
      harness: ctx.agent.harness,
      ...(ctx.describe ?? {}),
      ...(ctx.sink.scrub === undefined ? {} : { scrub: ctx.sink.scrub }),
    }),
    limit: null,
    error: null,
    interrupting: null,
    halted: false,
    interruptAnswered: false,
    lastTreeRefresh: now,
    known: new Set(),
    workers: createWorkerWatch({
      clock: d.clock,
      sample: (pids) => d.process.cpuByPid(pids),
      supported: true,
    }),
  };
  try {
    registerPid(d, proc, handle.pid);
    await refreshTree(d, proc);
    d.turn = { toolCalls: 0, marker: false };
    if (!d.halted()) {
      // A failed send means the program already died (its exit is reported next) or refused the
      // message (its error result is reported next).
      const sent = await send(d, proc, launch.message);
      if (sent === "sent") d.user(launch.sentLine, launch.message);
    }
    const end = await drive(d, proc, launch.resumeId !== null);
    if (proc.limit !== null) d.limit = proc.limit;
    return end;
  } catch (failure) {
    // Whatever went wrong inside, nothing is left running.
    const message = failure instanceof Error ? failure.message : String(failure);
    handle.close();
    await endTree(d, proc);
    return { kind: "failed", message: `The job could not be driven: ${message}` };
  }
}

/**
 * Lets a program that started after a request go, with nothing of it left.
 * @param {DriverState} d
 * @param {import("../agents/start.js").AgentHandle} handle
 */
async function abandon(d, handle) {
  d.ctx.limiter?.resumeAll();
  handle.close();
  await d.settleOrTimeout(handle.finished, d.timings.exitTimeout);
  await d.process.endTree(handle.pid, { graceMs: d.timings.killGrace }).catch(() => false);
  await d.settleOrTimeout(handle.finished, 2000);
}

/**
 * Writes a message to the program. `halted`: a pause or stop was requested, nothing was written.
 * @param {DriverState} d
 * @param {Proc} proc
 * @param {string} text
 * @returns {Promise<"sent" | "halted" | "failed">}
 */
async function send(d, proc, text) {
  if (d.halted()) {
    proc.halted = true;
    return "halted";
  }
  try {
    await proc.handle.sendUser(text);
  } catch {
    return "failed";
  }
  proc.tracker.messageSent(d.clock.now());
  return "sent";
}

/**
 * @param {DriverState} d
 * @param {Proc} proc
 * @param {number} pid
 */
function registerPid(d, proc, pid) {
  if (proc.known.has(pid)) return;
  proc.known.add(pid);
  d.ctx.registry?.add({ jobId: d.ctx.job.id, pid, startedAt: d.clock.now() }).catch(() => {});
}

/**
 * Looks at the process tree: new members are recorded, and the CPU of the model's own commands is
 * noted for the busy check.
 * @param {DriverState} d
 * @param {Proc} proc
 */
async function refreshTree(d, proc) {
  proc.lastTreeRefresh = d.clock.now();
  const root = proc.handle.pid;
  try {
    const pids = await d.process.listTree(root, [...proc.known]);
    for (const pid of pids) registerPid(d, proc, pid);
    await proc.workers.refresh(pids.filter((pid) => pid !== root));
  } catch {
    // A tree that cannot be read now is read at the next refresh.
  }
}

/**
 * Ends every process of the tree that is still alive and forgets it in the registry; returns
 * once the program's own end was reported (or a short time passed).
 * @param {DriverState} d
 * @param {Proc} proc
 */
async function endTree(d, proc) {
  const known = [...proc.known];
  const ended = await d.process
    .endTree(proc.handle.pid, { graceMs: d.timings.killGrace, knownPids: known })
    .catch(() => false);
  if (!ended) d.error("Some processes of this job could not be ended on the server.");
  for (const pid of known) await d.ctx.registry?.remove(pid).catch(() => {});
  proc.known.clear();
  await d.settleOrTimeout(proc.handle.finished, 2000);
}

/**
 * Reads the mailbox until `done`, the exit, a stop request or the deadline. A pause request is
 * ignored here (a pause or stop is already in progress).
 * @param {DriverState} d
 * @param {Proc} proc
 * @param {number} deadline
 * @param {(proc: Proc) => boolean} done
 * @returns {Promise<"done" | "exited" | "stop" | "timeout">}
 */
async function waitUntil(d, proc, deadline, done) {
  for (;;) {
    if (done(proc)) return "done";
    const left = deadline - d.clock.now();
    if (left <= 0) return "timeout";
    const message = await d.mailbox.recv(left);
    if (message.type === "event") {
      if (message.gen !== proc.gen) continue;
      if (message.event.type === "exited") return "exited";
      observeLine(d, proc, message.event.event);
    } else if (message.type === "stop") {
      return "stop";
    } else if (message.type === "timeout") {
      return "timeout";
    }
  }
}

/**
 * @param {DriverState} d
 * @param {Proc} proc
 * @param {import("../agents/claude/protocol.js").StreamEvent} event
 */
function observeLine(d, proc, event) {
  observe(d, proc, event, () => {
    void refreshTree(d, proc);
  });
}

/**
 * Closes the program's input, waits for it to exit (ending the tree when that takes too long),
 * then ends whatever is left of the tree.
 * @param {DriverState} d
 * @param {Proc} proc
 */
async function closeAndWait(d, proc) {
  await refreshTree(d, proc);
  d.ctx.limiter?.resumeAll();
  proc.handle.close();
  const waited = await waitUntil(d, proc, d.clock.now() + d.timings.exitTimeout, () => false);
  if (waited !== "exited") {
    await endTree(d, proc);
    await waitUntil(d, proc, d.clock.now() + 2000, () => false);
  }
  await endTree(d, proc);
}

/**
 * Pause: interrupt the turn, wait for the model to go idle, close the program.
 * @param {DriverState} d
 * @param {Proc} proc
 * @returns {Promise<ProcessEnd>}
 */
async function pause(d, proc) {
  d.status(
    `Pausing: asking ${d.ctx.agent.harness === "opencode2" ? "OpenCode 2" : "Claude"} to stop the current step`,
  );
  d.ctx.limiter?.resumeAll();
  try {
    proc.interrupting = proc.handle.interrupt();
  } catch {
    // The input is gone: the program is ending anyway.
    await closeAndWait(d, proc);
    return { kind: "paused" };
  }
  const waited = await waitUntil(
    d,
    proc,
    d.clock.now() + d.timings.interruptTimeout,
    (p) => p.interruptAnswered && p.tracker.activity().kind !== "working",
  );
  if (waited === "stop") return stop(d, proc);
  if (waited === "exited") {
    await endTree(d, proc);
    return { kind: "paused" };
  }
  await closeAndWait(d, proc);
  return { kind: "paused" };
}

/**
 * Stop: interrupt, then end the whole process tree.
 * @param {DriverState} d
 * @param {Proc} proc
 * @returns {Promise<ProcessEnd>}
 */
async function stop(d, proc) {
  d.status("Stopping");
  d.ctx.limiter?.resumeAll();
  try {
    proc.interrupting = proc.handle.interrupt();
    const deadline = d.clock.now() + Math.min(d.timings.interruptTimeout, 2000);
    const waited = await waitUntil(d, proc, deadline, (p) => p.interruptAnswered);
    if (waited === "exited") {
      await endTree(d, proc);
      return { kind: "stopped" };
    }
  } catch {
    // The input is gone: go on to ending the tree.
  }
  await refreshTree(d, proc);
  proc.handle.close();
  await endTree(d, proc);
  await waitUntil(d, proc, d.clock.now() + d.timings.killGrace + 2000, () => false);
  return { kind: "stopped" };
}

/**
 * The main loop of one program.
 * @param {DriverState} d
 * @param {Proc} proc
 * @param {boolean} resuming
 * @returns {Promise<ProcessEnd>}
 */
async function drive(d, proc, resuming) {
  const { timings } = d;
  const tick = Math.min(timings.progressInterval, 1000);
  for (;;) {
    const now = d.clock.now();
    let wake = now + tick;
    const settle = proc.tracker.settleDeadline(timings.settle);
    if (settle !== null && !proc.halted) wake = Math.min(wake, settle);
    const message = await d.mailbox.recv(wake - now);
    if (message.type === "event") {
      if (message.gen === proc.gen) {
        if (message.event.type === "exited") {
          await endTree(d, proc);
          return exitedByItself(d, proc, message.event.exit, resuming);
        }
        observeLine(d, proc, message.event.event);
      }
    } else if (message.type === "pause") {
      return pause(d, proc);
    } else if (message.type === "stop") {
      return stop(d, proc);
    }
    d.flushProgress(false);
    if (d.clock.now() - proc.lastTreeRefresh >= timings.treeRefresh) await refreshTree(d, proc);
    if (proc.error !== null) {
      const error = proc.error;
      proc.error = null;
      await closeAndWait(d, proc);
      if (resuming && isResumeNotFound(error)) return { kind: "resumeNotFound" };
      return errorEnd(d, error, proc.limit);
    }
    const at = d.clock.now();
    if (proc.tracker.isFinished(at, timings.settle) && !proc.halted) {
      const end = await idle(d, proc);
      if (end !== null) return end;
      continue;
    }
    // A tool call that was given a longer time limit is silent up to that limit.
    const stall = proc.tracker.stallLimit(timings.stallTimeout);
    if (
      proc.tracker.quietFor(at) >= stall &&
      proc.tracker.activity().kind !== "waitingForBackground"
    ) {
      // Silence in the middle of a turn is not a turn that ended early: the program is stuck.
      // Done only if the work is there.
      await closeAndWait(d, proc);
      const file = await d.ctx.deliverable();
      return file !== null
        ? { kind: "completed", file }
        : { kind: "failed", message: stalled(Math.floor(stall / 60_000), d.ctx.agent.harness) };
    }
  }
}

/**
 * The model went idle while the job keeps itself going: asks `keepgoing` whether the job is done,
 * and sends the next message in the same session when it is not. Returns how the program ended,
 * or `null` while it goes on.
 * @param {DriverState} d
 * @param {Proc} proc
 * @returns {Promise<ProcessEnd | null>}
 */
async function idle(d, proc) {
  if (d.halted()) {
    // A pause or stop is on its way; it ends this program.
    proc.halted = true;
    return null;
  }
  const { ctx } = d;
  const kind = ctx.job.kind;
  // Look at the output folder now, so the files of the turn that just ended count.
  ctx.tracker.probeNow();
  d.flushProgress(true);
  const deliverable = await ctx.deliverable();
  const gate = proc.workers.idle(deliverable !== null);
  if (gate.skip) return null;
  const decision = d.keeper.turnEnded(d.turn, {
    deliverable,
    extrasMissing:
      kind === "edit" && !ctx.tracker.isDone("extras_written") ? ["thumbnails", "meta.txt"] : [],
    milestones: ctx.tracker.workShown(),
    workersBusy: gate.workersBusy,
  });
  d.turn = { toolCalls: 0, marker: false };
  switch (decision.kind) {
    case "complete":
      return complete(d, proc, decision.deliverable);
    case "missingOutput":
      await closeAndWait(d, proc);
      return { kind: "failed", message: missingOutput(kind, ctx.agent.harness) };
    case "stuck":
      await closeAndWait(d, proc);
      return { kind: "failed", message: stuck(kind, decision.reason) };
    case "continue": {
      const message = d.texts.continuation(kind, decision.nudge, ctx.job.setup);
      const sent = await send(d, proc, message);
      if (sent === "sent") {
        if (decision.nudge.kind === "waitForWork") proc.workers.noteWaitMessage();
        const line = statusLine(kind, decision.nudge, decision.number);
        d.activity = firstLine(line.split(":")[0] ?? line);
        d.log(statusDraft(line, { detail: message }));
      }
      return null;
    }
  }
}

/**
 * The job looks done (the marker and the deliverable): the project is checked while the program is
 * still there to fix it. At most two fixes are asked for (docs/SPEC.md section 8).
 * @param {DriverState} d
 * @param {Proc} proc
 * @param {string} file
 * @returns {Promise<ProcessEnd | null>}
 */
async function complete(d, proc, file) {
  const { verify } = d.ctx;
  if (verify === undefined) {
    await closeAndWait(d, proc);
    return { kind: "completed", file };
  }
  const checking = (async () => {
    try {
      return { violations: await verify(), failure: null };
    } catch (error) {
      return { violations: [], failure: error instanceof Error ? error.message : String(error) };
    }
  })();
  const checked = await d.raceRequest(checking);
  if (!checked.done) return d.stopAsked ? stop(d, proc) : pause(d, proc);
  const { violations, failure } = checked.value;
  if (failure !== null) {
    await closeAndWait(d, proc);
    return { kind: "failed", message: `The project could not be checked: ${failure}` };
  }
  if (violations.length === 0) {
    await closeAndWait(d, proc);
    return { kind: "completed", file };
  }
  if (d.fixes >= MAX_FIXES) {
    await closeAndWait(d, proc);
    return { kind: "failed", message: d.texts.projectErrors(violations) };
  }
  d.fixes += 1;
  const message = d.texts.verifyFix(violations, d.fixes);
  const sent = await send(d, proc, message);
  if (sent === "sent") {
    d.activity = "Fixing the project errors";
    d.log(
      statusDraft(
        `The project has ${violations.length === 1 ? "an error" : `${violations.length} errors`}: asked to fix ${violations.length === 1 ? "it" : "them"} (${d.fixes} of ${MAX_FIXES})`,
        { detail: message },
      ),
    );
  }
  return null;
}

/** The most fixes asked for after a failed check. */
export const MAX_FIXES = 2;

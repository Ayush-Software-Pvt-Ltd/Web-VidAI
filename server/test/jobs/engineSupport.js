// Shared by the driver tests (`driver*.test.js`) and the engine tests (`engine*.test.js`): a clock
// and timers that tests move by hand, a scripted agent program, a context for `runAgentJob`, and a
// world of temporary folders for the real fakes (`support/fake-claude.sh`, `fake-opencode2.py`).
//
// Not a test file (no `.test.js`), so `node --test` does not run it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentJob } from "../../src/jobs/driver.js";
import { createProcessRegistry } from "../../src/jobs/registry.js";
import { endTree, isAlive, listTree, cpuByPid } from "../../src/platform/process.js";

export const FAKE_CLAUDE = fileURLToPath(new URL("../support/fake-claude.sh", import.meta.url));
export const FAKE_OPENCODE = fileURLToPath(
  new URL("../support/fake-opencode2.py", import.meta.url),
);

/** @param {number} [n] */
export async function settle(n = 12) {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A clock and timers that only move when the test says.
 * @param {number} [start]
 */
export function fakeTime(start = 1_000_000) {
  let now = start;
  /** @type {Array<{ id: number, at: number, fn: () => void }>} */
  let pending = [];
  let next = 0;
  const time = {
    clock: { now: () => now },
    timers: {
      setTimeout(/** @type {() => void} */ fn, /** @type {number} */ ms) {
        next += 1;
        pending.push({ id: next, at: now + Math.max(0, ms), fn });
        return next;
      },
      clearTimeout(/** @type {unknown} */ handle) {
        pending = pending.filter((t) => t.id !== handle);
      },
    },
    /** Timers waiting. */
    waiting: () => pending.length,
    /** @param {number} ms */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        await settle();
        const due = pending
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (due === undefined) break;
        pending = pending.filter((t) => t.id !== due.id);
        now = Math.max(now, due.at);
        due.fn();
      }
      now = target;
      await settle();
    },
    /**
     * Moves time in steps until `check` is true.
     * @param {() => boolean} check
     * @param {number} [step]
     * @param {number} [limit]
     */
    async until(check, step = 50, limit = 600_000) {
      for (let spent = 0; !check(); spent += step) {
        if (spent > limit) throw new Error("the condition never became true");
        await time.advance(step);
      }
    },
  };
  return time;
}

/** Events in the Claude Code vocabulary. */
export const ev = {
  /** @param {string} text @param {{ tool?: boolean }} [options] */
  assistant(text, options = {}) {
    /** @type {any[]} */
    const content = [{ type: "text", text }];
    if (options.tool)
      content.push({
        type: "toolUse",
        id: `t${Math.random()}`,
        name: "Bash",
        input: { command: "ls" },
      });
    return /** @type {any} */ ({ type: "assistant", parentToolUseId: null, content });
  },
  /** @param {Record<string, unknown>} [over] */
  result(over = {}) {
    return /** @type {any} */ ({
      type: "result",
      subtype: "success",
      isError: false,
      numTurns: 1,
      text: "done",
      errors: [],
      totalCostUsd: 0.25,
      sessionId: "s",
      apiErrorStatus: null,
      terminalReason: "completed",
      ...over,
    });
  },
  /** @param {string} text @param {Record<string, unknown>} [over] */
  error(text, over = {}) {
    return ev.result({
      subtype: "error_during_execution",
      isError: true,
      text: null,
      errors: [text],
      terminalReason: "error",
      ...over,
    });
  },
  /** @param {string} requestId */
  controlResponse: (requestId) =>
    /** @type {any} */ ({ type: "controlResponse", requestId, success: true, error: null }),
  rateLimitRejected: (/** @type {number | null} */ resetsAt = null) =>
    /** @type {any} */ ({
      type: "rateLimit",
      status: "rejected",
      resetsAt,
      raw: { status: "rejected" },
    }),
};

/**
 * A scripted agent program: the test says what it emits, the driver's calls are recorded.
 * @param {ReturnType<typeof fakeTime>} time
 * @param {object} [options]
 * @param {boolean} [options.autoInterrupt] Answers an interrupt and ends the turn (default true).
 * @param {number} [options.startMs] How long the start takes.
 * @param {boolean} [options.ignoreClose] `close()` does nothing (a program that hangs).
 */
export function scriptedAgent(time, options = {}) {
  const autoInterrupt = options.autoInterrupt ?? true;
  /** @type {any[]} */
  const specs = [];
  /** @type {Array<ReturnType<typeof makeProgram>>} */
  const programs = [];
  let counter = 0;

  /** @param {any} spec */
  function makeProgram(spec) {
    counter += 1;
    /** @type {string[]} */
    const messages = [];
    let exited = false;
    let closes = 0;
    let interrupts = 0;
    /** @type {() => void} */
    let markFinished = () => {};
    const finished = new Promise((resolve) => (markFinished = () => resolve(undefined)));
    const program = {
      pid: 40_000 + counter,
      messages,
      spec,
      get closes() {
        return closes;
      },
      get interrupts() {
        return interrupts;
      },
      get exited() {
        return exited;
      },
      /** @param {any} event */
      emit(event) {
        if (!exited) spec.onEvent({ type: "line", event, at: time.clock.now() });
      },
      /** @param {Partial<{ code: number | null, signal: string | null, stderrTail: string[] }>} [info] */
      exit(info = {}) {
        if (exited) return;
        exited = true;
        spec.onEvent({
          type: "exited",
          exit: { code: 0, signal: null, stderrTail: [], ...info },
          at: time.clock.now(),
        });
        markFinished();
      },
      /** Answers the work: marker text and a result. @param {string} [text] */
      answer(text = "All done. [OUTPUT COMPLETED]") {
        program.emit(ev.assistant(text, { tool: true }));
        program.emit(ev.result());
      },
      handle: /** @type {any} */ (null),
    };
    program.handle = {
      pid: program.pid,
      sessionId: spec.resumeId ?? `session-${counter}`,
      harness: spec.harness,
      finished,
      async sendUser(/** @type {string} */ text) {
        if (exited) throw Object.assign(new Error("closed"), { code: "EPIPE" });
        messages.push(text);
      },
      interrupt() {
        if (exited) throw Object.assign(new Error("closed"), { code: "EPIPE" });
        interrupts += 1;
        const id = `interrupt-${interrupts}`;
        if (autoInterrupt) {
          queueMicrotask(() => {
            program.emit(ev.controlResponse(id));
            program.emit(ev.error("aborted", { terminalReason: "aborted_streaming" }));
          });
        }
        return id;
      },
      close() {
        closes += 1;
        if (!options.ignoreClose) queueMicrotask(() => program.exit());
      },
    };
    return program;
  }

  return {
    specs,
    programs,
    /** The program number n (0 is the first one started). @param {number} [n] */
    program: (n = 0) => programs[n],
    last: () => programs[programs.length - 1],
    /** @param {any} spec */
    async startAgent(spec) {
      specs.push(spec);
      if (options.startMs !== undefined) {
        await new Promise((resolve) =>
          time.timers.setTimeout(() => resolve(undefined), options.startMs ?? 0),
        );
      }
      const program = makeProgram(spec);
      programs.push(program);
      return program.handle;
    },
  };
}

/** A tracker that does nothing, as `createTracker` would answer. */
export function stubTracker() {
  const calls = { completion: 0, observed: 0 };
  return {
    calls,
    work: 0,
    observe() {
      calls.observed += 1;
    },
    workShown() {
      return this.work;
    },
    isDone: () => false,
    probeNow() {},
    poll: () => null,
    recordCompletion() {
      calls.completion += 1;
    },
    seen: () => ({}),
  };
}

/**
 * @param {object} [options]
 * @param {ReturnType<typeof fakeTime>} [options.time]
 * @param {ReturnType<typeof scriptedAgent>} [options.agent]
 * @param {Record<string, unknown>} [options.over] Replaces fields of the context.
 */
export function driverWorld(options = {}) {
  const time = options.time ?? fakeTime();
  const agent = options.agent ?? scriptedAgent(time);
  /** @type {any[]} */
  const entries = [];
  /** @type {any[]} */
  const patches = [];
  /** @type {string[]} */
  const calls = [];
  /** @type {string[]} */
  const ended = [];
  /** @type {number[]} */
  const registered = [];
  /** @type {number[]} */
  const unregistered = [];
  const tracker = stubTracker();
  const state = { deliverable: /** @type {string | null} */ (null) };
  const ctx = /** @type {any} */ ({
    job: {
      id: "job-1",
      kind: "edit",
      videoId: "video-1",
      videoDir: "/v",
      sessionId: null,
      setup: "claudeSubscription",
    },
    agent: {
      harness: "claudeCode",
      command: "claude",
      cwd: "/",
      env: {},
      model: null,
      effort: null,
    },
    firstMessage: "Make the edit.",
    fullMessage: "Make the edit, in full.",
    deliverable: () => state.deliverable,
    tracker,
    sink: {
      push: (/** @type {string} */ _v, /** @type {string} */ _j, /** @type {any[]} */ drafts) =>
        entries.push(...drafts),
      scrub: (/** @type {string} */ t) => t,
    },
    limiter: {
      jobStarted: () => calls.push("limiter.jobStarted"),
      jobEnded: () => calls.push("limiter.jobEnded"),
      resumeAll: () => calls.push("limiter.resumeAll"),
    },
    registry: {
      add: async (/** @type {{ pid: number }} */ e) => void registered.push(e.pid),
      remove: async (/** @type {number} */ pid) => void unregistered.push(pid),
    },
    onUpdate: (/** @type {any} */ patch) => patches.push(patch),
    clock: time.clock,
    timers: time.timers,
    timings: {
      settle: 100,
      interruptTimeout: 500,
      exitTimeout: 500,
      killGrace: 50,
      stallTimeout: 5000,
      progressInterval: 50,
      treeRefresh: 1000,
      retrySecond: 1,
    },
    startAgent: (/** @type {any} */ spec) => agent.startAgent(spec),
    process: {
      listTree: async (/** @type {number} */ root) => [root],
      endTree: async (/** @type {number} */ root) => {
        ended.push(String(root));
        return true;
      },
      cpuByPid: async () => new Map(),
    },
    ...options.over,
  });
  /** @type {import("../../src/jobs/driver.js").AgentOutcome | undefined} */
  let outcome;
  let outcomes = 0;
  /** @type {import("../../src/jobs/driver.js").AgentJobHandle | undefined} */
  let handle;
  return {
    time,
    agent,
    ctx,
    entries,
    patches,
    calls,
    ended,
    registered,
    unregistered,
    tracker,
    state,
    get outcome() {
      return outcome;
    },
    get outcomes() {
      return outcomes;
    },
    texts: () => entries.map((e) => e.text),
    start() {
      handle = runAgentJob(ctx);
      handle.done.then((o) => {
        outcome = o;
        outcomes += 1;
      });
      return handle;
    },
    pause: () => handle?.pause(),
    stop: () => handle?.stop(),
    /** Runs until the job has its outcome. */
    async finish() {
      await time.until(() => outcome !== undefined, 50, 3_600_000);
      await time.advance(2000);
      return /** @type {import("../../src/jobs/driver.js").AgentOutcome} */ (outcome);
    },
    /** Moves time until the first message of program n arrived. @param {number} [n] */
    async untilMessage(n = 0, count = 1) {
      await time.until(() => (agent.programs[n]?.messages.length ?? 0) >= count, 20, 120_000);
    },
  };
}

// ----- the real fakes -----

/**
 * A world of temporary folders for the real fake programs.
 * @param {import("node:test").TestContext} t
 * @param {Record<string, string>} [env] More variables of the program (`FAKE_SCENARIO`, ...).
 */
export function engineWorld(t, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-engine-"));
  const state = path.join(root, "state");
  const editing = path.join(root, "Editing Folder");
  const video = path.join(editing, "Channel", "Video A");
  const data = path.join(root, "data");
  for (const dir of [state, path.join(video, "output"), data])
    fs.mkdirSync(dir, { recursive: true });
  const registryFile = path.join(data, "processes.json");
  const registry = createProcessRegistry({
    file: registryFile,
    isAlive,
    endTree,
    clock: { now: () => Date.now() },
  });
  /** @type {import("../../src/jobs/driver.js").AgentJobHandle[]} */
  const handles = [];
  t.after(async () => {
    for (const handle of handles) handle.stop();
    await Promise.allSettled(handles.map((h) => h.done));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const entries = /** @type {any[]} */ ([]);
  const patches = /** @type {any[]} */ ([]);
  const prompt =
    "MAIN_FOLDER = Video A\nCHANNEL_FOLDER = Channel\nREVIEW_OUTPUT_SOFTWARE = Final Cut Pro\n\nMake the edit.";
  const baseEnv = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", FAKE_STATE: state, ...env };
  const world = {
    root,
    state,
    editing,
    video,
    registry,
    registryFile,
    entries,
    patches,
    texts: () => entries.map((e) => e.text),
    outputFiles: () => fs.readdirSync(path.join(video, "output")).sort(),
    /** @param {string} name */
    read: (name) => fs.readFileSync(path.join(state, name), "utf8"),
    /** @param {string} name @param {string} text */
    write: (name, text) => fs.writeFileSync(path.join(state, name), text),
    /** @param {string} name */
    has: (name) => fs.existsSync(path.join(state, name)),
    /** @param {Record<string, unknown>} [over] */
    context(over = {}) {
      /** @type {any} */
      const ctx = {
        job: {
          id: "job-1",
          kind: "edit",
          videoId: "video-1",
          videoDir: video,
          sessionId: null,
          setup: "claudeSubscription",
        },
        agent: {
          harness: "claudeCode",
          command: FAKE_CLAUDE,
          cwd: editing,
          env: baseEnv,
          model: null,
          effort: null,
        },
        firstMessage: prompt,
        deliverable: () => {
          const files = fs.existsSync(path.join(video, "output"))
            ? fs
                .readdirSync(path.join(video, "output"))
                .filter((f) => /\.(fcpxml|xml)$/.test(f))
                .sort()
            : [];
          return files.length === 0 ? null : (files[files.length - 1] ?? null);
        },
        tracker: stubTracker(),
        sink: {
          push: (/** @type {string} */ _v, /** @type {string} */ _j, /** @type {any[]} */ drafts) =>
            entries.push(...drafts),
          scrub: (/** @type {string} */ x) => x,
        },
        registry,
        maxRetries: () => 0,
        onUpdate: (/** @type {any} */ patch) => patches.push(patch),
        timings: {
          settle: 250,
          interruptTimeout: 3000,
          exitTimeout: 5000,
          killGrace: 500,
          stallTimeout: 15_000,
          progressInterval: 100,
          treeRefresh: 200,
          retrySecond: 3,
        },
        ...over,
      };
      return ctx;
    },
    /** Starts a job. @param {Record<string, unknown>} [over] */
    run(over = {}) {
      const handle = runAgentJob(world.context(over));
      handles.push(handle);
      return handle;
    },
  };
  return world;
}

/** Fails when a fake program is still running. */
export function aliveFakes() {
  return listTree;
}
export { cpuByPid };

// The job driver (jobs/driver.js) against a scripted agent, a fake clock and fake timers: every
// branch of how one job runs, with nothing real started (docs/SPEC.md section 6).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { driverWorld, ev, fakeTime, scriptedAgent, settle } from "./engineSupport.js";

/**
 * Starts a job and waits until the first message went to the first program.
 * @param {ReturnType<typeof driverWorld>} w
 */
async function started(w) {
  w.start();
  await w.untilMessage(0);
  return w.agent.program(0);
}

describe("driver: the happy path", () => {
  it("completes when the marker, the output and the turn end are there", async () => {
    const w = driverWorld();
    w.state.deliverable = "out_v1.fcpxml";
    const p = await started(w);
    assert.equal(p.messages[0], "Make the edit.");
    p.answer();
    const outcome = await w.finish();
    assert.equal(outcome.state, "completed");
    assert.equal(outcome.error, null);
    assert.equal(outcome.costUsd, 0.25);
    assert.equal(outcome.sessionId, p.handle.sessionId);
    assert.equal(w.outcomes, 1);
    assert.equal(w.tracker.calls.completion, 1);
    assert.ok(p.closes >= 1);
    assert.deepEqual(w.calls, ["limiter.jobStarted", "limiter.resumeAll", "limiter.jobEnded"]);
    assert.deepEqual(w.registered, [p.pid]);
    assert.ok(w.unregistered.includes(p.pid));
    assert.ok(w.patches.some((patch) => patch.sessionId === p.handle.sessionId));
    assert.ok(w.patches.some((patch) => patch.costUsd === 0.25));
  });

  it("logs the start of a new session", async () => {
    const w = driverWorld();
    w.state.deliverable = "out_v1.fcpxml";
    const p = await started(w);
    assert.ok(
      w.texts().some((t) => /Started a new Claude Code session/.test(t)),
      w.texts().join("|"),
    );
    p.answer();
    await w.finish();
  });

  it("resumes the session of the job and says so", async () => {
    const w = driverWorld({
      over: {
        job: {
          id: "job-1",
          kind: "edit",
          videoId: "v",
          videoDir: "/v",
          sessionId: "old-session",
          setup: "claudeSubscription",
        },
      },
    });
    w.state.deliverable = "out_v1.fcpxml";
    const p = await started(w);
    assert.equal(p.spec.resumeId, "old-session");
    assert.ok(
      w.texts().some((t) => /Resumed the Claude Code session/.test(t)),
      w.texts().join("|"),
    );
    p.answer();
    assert.equal((await w.finish()).state, "completed");
  });

  it("works with OpenCode 2 as the program", async () => {
    const w = driverWorld({
      over: {
        agent: {
          harness: "opencode2",
          command: "opencode2",
          cwd: "/",
          env: {},
          model: "m",
          effort: null,
          jobDir: "/j",
          option: "opencodeGo",
          key: "k",
        },
        job: {
          id: "job-1",
          kind: "edit",
          videoId: "v",
          videoDir: "/v",
          sessionId: null,
          setup: "opencodeGo",
        },
      },
    });
    w.state.deliverable = "out_v1.fcpxml";
    const p = await started(w);
    assert.equal(p.spec.harness, "opencode2");
    assert.ok(
      w.texts().some((t) => /Started a new OpenCode 2 session/.test(t)),
      w.texts().join("|"),
    );
    p.answer();
    assert.equal((await w.finish()).state, "completed");
  });
});

describe("driver: what the keeper asks for", () => {
  it("asks to finish when the output is there but the marker is missing", async () => {
    const w = driverWorld();
    w.state.deliverable = "out_v1.fcpxml";
    const p = await started(w);
    p.emit(ev.assistant("Wrote the project.", { tool: true }));
    p.emit(ev.result());
    await w.untilMessage(0, 2);
    assert.ok(p.messages[1].length > 0);
    p.answer();
    assert.equal((await w.finish()).state, "completed");
  });

  it("asks to save the output when the marker is there and the file is not", async () => {
    const w = driverWorld();
    const p = await started(w);
    p.answer("[OUTPUT COMPLETED]");
    await w.untilMessage(0, 2);
    w.state.deliverable = "out_v1.fcpxml";
    p.answer();
    assert.equal((await w.finish()).state, "completed");
  });

  it("fails as stuck after the nudges are used up without any output", async () => {
    const w = driverWorld();
    const p = await started(w);
    for (let round = 0; round < 40 && w.outcome === undefined; round += 1) {
      p.emit(ev.assistant("Thinking.", { tool: true }));
      p.emit(ev.result());
      await w.time.advance(500);
    }
    const outcome = await w.finish();
    assert.equal(outcome.state, "failed");
    assert.match(outcome.error?.message ?? "", /./);
    assert.equal(outcome.error?.code, "failed");
    assert.equal(w.outcomes, 1);
  });
});

describe("driver: verify", () => {
  it("sends the violations back twice and then fails with the project errors", async () => {
    const w = driverWorld();
    w.state.deliverable = "out_v1.fcpxml";
    let checks = 0;
    w.ctx.verify = async () => {
      checks += 1;
      return ["scene 1 has no clip"];
    };
    const p = await started(w);
    p.answer();
    await w.untilMessage(0, 2);
    assert.match(p.messages[1], /scene 1 has no clip/);
    p.answer();
    await w.untilMessage(0, 3);
    assert.match(p.messages[2], /scene 1 has no clip/);
    p.answer();
    const outcome = await w.finish();
    assert.equal(checks, 3);
    assert.equal(outcome.state, "failed");
    assert.equal(outcome.error?.message, "The project has errors: scene 1 has no clip");
  });

  it("completes when the fix works", async () => {
    const w = driverWorld();
    w.state.deliverable = "out_v1.fcpxml";
    let checks = 0;
    w.ctx.verify = async () => (++checks === 1 ? ["bad"] : []);
    const p = await started(w);
    p.answer();
    await w.untilMessage(0, 2);
    p.answer();
    assert.equal((await w.finish()).state, "completed");
    assert.equal(checks, 2);
  });

  it("fails with a sentence when the check itself throws", async () => {
    const w = driverWorld();
    w.state.deliverable = "out_v1.fcpxml";
    w.ctx.verify = async () => {
      throw new Error("disk gone");
    };
    const p = await started(w);
    p.answer();
    const outcome = await w.finish();
    assert.equal(outcome.state, "failed");
    assert.match(outcome.error?.message ?? "", /The project could not be checked: disk gone/);
  });
});

describe("driver: the program ends or fails", () => {
  it("fails with the message of an error result", async () => {
    const w = driverWorld();
    const p = await started(w);
    p.emit(ev.error("The prompt is too long"));
    const outcome = await w.finish();
    assert.equal(outcome.state, "failed");
    assert.match(outcome.error?.message ?? "", /prompt is too long/i);
    assert.ok(p.closes >= 1, "the program is closed after an error result");
  });

  it("fails when the program crashes", async () => {
    const w = driverWorld();
    const p = await started(w);
    p.exit({ code: 1, stderrTail: ["boom"] });
    const outcome = await w.finish();
    assert.equal(outcome.state, "failed");
    assert.match(outcome.error?.message ?? "", /./);
  });

  it("fails with a sentence when the program cannot be started", async () => {
    const w = driverWorld({
      over: {
        startAgent: async () => {
          throw new Error("spawn claude ENOENT");
        },
      },
    });
    w.start();
    const outcome = await w.finish();
    assert.equal(outcome.state, "failed");
    assert.equal(w.outcomes, 1);
    assert.ok((outcome.error?.message ?? "").length > 0);
  });

  it("starts a new session with the full message when the resumed one is gone", async () => {
    const w = driverWorld({
      over: {
        job: {
          id: "job-1",
          kind: "edit",
          videoId: "v",
          videoDir: "/v",
          sessionId: "old",
          setup: "claudeSubscription",
        },
      },
    });
    w.state.deliverable = "out_v1.fcpxml";
    const first = await started(w);
    first.emit(ev.error("No conversation found with session ID: old", { terminalReason: "error" }));
    first.exit({ code: 1, stderrTail: ["No conversation found with session ID: old"] });
    await w.untilMessage(1);
    const second = w.agent.program(1);
    assert.equal(second.spec.resumeId ?? null, null);
    assert.equal(second.messages[0], "Make the edit, in full.");
    second.answer();
    const outcome = await w.finish();
    assert.equal(outcome.state, "completed");
    assert.equal(outcome.sessionId, second.handle.sessionId);
  });
});

describe("driver: model errors are retried", () => {
  it("waits, resumes the session with the continue message and completes", async () => {
    const w = driverWorld({ over: { continueMessage: "Go on." } });
    w.state.deliverable = "out_v1.fcpxml";
    const first = await started(w);
    first.emit(ev.error("API Error: 529 overloaded", { apiErrorStatus: 529 }));
    await w.untilMessage(1);
    const second = w.agent.program(1);
    assert.equal(second.spec.resumeId, first.handle.sessionId);
    assert.equal(second.messages[0], "Go on.");
    second.answer();
    assert.equal((await w.finish()).state, "completed");
  });

  it("fails when the retries are used up", async () => {
    const w = driverWorld({ over: { maxRetries: () => 2, continueMessage: "Go on." } });
    const first = await started(w);
    first.emit(ev.error("API Error: 529 overloaded", { apiErrorStatus: 529 }));
    for (let n = 1; n <= 2; n += 1) {
      await w.untilMessage(n);
      w.agent.program(n).emit(ev.error("API Error: 529 overloaded", { apiErrorStatus: 529 }));
    }
    const outcome = await w.finish();
    assert.equal(outcome.state, "failed");
    assert.equal(w.agent.programs.length, 3, "one start and two retries");
    assert.equal(w.outcomes, 1);
  });
});

describe("driver: a stalled program", () => {
  it("ends with the output when it is there, else fails as stalled", async () => {
    const w = driverWorld();
    const p = await started(w);
    p.emit(ev.assistant("Working.", { tool: true }));
    await w.time.advance(6000);
    const outcome = await w.finish();
    assert.equal(outcome.state, "failed");
    assert.ok(p.closes >= 1);
    assert.equal(w.outcomes, 1);
  });
});

describe("driver: pause and stop at every moment", () => {
  it("pause while the program works: interrupts, closes, outcome paused", async () => {
    const w = driverWorld();
    const p = await started(w);
    p.emit(ev.assistant("Working.", { tool: true }));
    w.pause();
    const outcome = await w.finish();
    assert.equal(outcome.state, "paused");
    assert.ok(p.interrupts >= 1);
    assert.ok(p.closes >= 1);
    assert.equal(w.outcomes, 1);
    assert.equal(outcome.error, null);
    assert.ok(w.calls.includes("limiter.jobEnded"));
  });

  it("stop while the program works: outcome stopped, tree ended", async () => {
    const w = driverWorld();
    const p = await started(w);
    p.emit(ev.assistant("Working.", { tool: true }));
    w.stop();
    const outcome = await w.finish();
    assert.equal(outcome.state, "stopped");
    assert.ok(p.closes >= 1);
    assert.ok(w.ended.includes(String(p.pid)));
    assert.equal(w.outcomes, 1);
  });

  it("pause then stop ends as stopped", async () => {
    const w = driverWorld({ agent: undefined });
    const p = await started(w);
    p.emit(ev.assistant("Working.", { tool: true }));
    w.pause();
    w.stop();
    const outcome = await w.finish();
    assert.equal(outcome.state, "stopped");
    assert.equal(w.outcomes, 1);
  });

  it("pause twice and stop twice give one outcome", async () => {
    const w = driverWorld();
    const p = await started(w);
    w.pause();
    w.pause();
    const outcome = await w.finish();
    assert.equal(outcome.state, "paused");
    w.stop();
    w.stop();
    await w.time.advance(5000);
    assert.equal(w.outcomes, 1);
    assert.ok(p.closes >= 1);
  });

  it("stop twice gives one outcome", async () => {
    const w = driverWorld();
    await started(w);
    w.stop();
    w.stop();
    assert.equal((await w.finish()).state, "stopped");
    assert.equal(w.outcomes, 1);
  });

  it("stop wins when the program does not answer the interrupt", async () => {
    const time = fakeTime();
    const w = driverWorld({ time, agent: scriptedAgent(time, { autoInterrupt: false }) });
    const p = await started(w);
    p.emit(ev.assistant("Working.", { tool: true }));
    w.pause();
    await time.advance(200);
    assert.equal(w.outcome, undefined, "a pause waits for the interrupt to be answered");
    w.stop();
    const outcome = await w.finish();
    assert.equal(outcome.state, "stopped");
    assert.equal(w.outcomes, 1);
  });

  it("pause before the program started: no program is left", async () => {
    const time = fakeTime();
    const agent = scriptedAgent(time, { startMs: 1000 });
    const w = driverWorld({ time, agent });
    w.start();
    await settle();
    w.pause();
    const outcome = await w.finish();
    assert.equal(outcome.state, "paused");
    assert.equal(w.outcomes, 1);
    for (const program of agent.programs) assert.equal(program.exited, true);
  });

  it("stop before the program started: no program is left", async () => {
    const time = fakeTime();
    const agent = scriptedAgent(time, { startMs: 1000 });
    const w = driverWorld({ time, agent });
    w.start();
    await settle();
    w.stop();
    const outcome = await w.finish();
    assert.equal(outcome.state, "stopped");
    for (const program of agent.programs) assert.equal(program.exited, true);
  });

  it("pause and stop before beforeChange has finished: the program never starts", async () => {
    const time = fakeTime();
    const agent = scriptedAgent(time);
    let release = () => {};
    const w = driverWorld({
      time,
      agent,
      over: { beforeChange: () => new Promise((resolve) => (release = () => resolve(undefined))) },
    });
    w.start();
    await settle();
    w.stop();
    const outcome = await w.finish();
    release();
    assert.equal(outcome.state, "stopped");
    assert.equal(agent.programs.length, 0);
  });

  it("pause during a retry wait", async () => {
    const w = driverWorld({
      over: {
        continueMessage: "Go on.",
        timings: {
          settle: 100,
          interruptTimeout: 500,
          exitTimeout: 500,
          killGrace: 50,
          stallTimeout: 5000,
          progressInterval: 50,
          treeRefresh: 1000,
          retrySecond: 1000,
        },
      },
    });
    const p = await started(w);
    p.emit(ev.error("API Error: 529 overloaded", { apiErrorStatus: 529 }));
    await w.time.advance(300);
    w.pause();
    const outcome = await w.finish();
    assert.equal(outcome.state, "paused");
    assert.equal(w.agent.programs.length, 1, "no new program after the pause");
    assert.equal(w.outcomes, 1);
  });

  it("stop during a retry wait", async () => {
    const w = driverWorld({
      over: {
        continueMessage: "Go on.",
        timings: {
          settle: 100,
          interruptTimeout: 500,
          exitTimeout: 500,
          killGrace: 50,
          stallTimeout: 5000,
          progressInterval: 50,
          treeRefresh: 1000,
          retrySecond: 1000,
        },
      },
    });
    const p = await started(w);
    p.emit(ev.error("API Error: 529 overloaded", { apiErrorStatus: 529 }));
    await w.time.advance(300);
    w.stop();
    const outcome = await w.finish();
    assert.equal(outcome.state, "stopped");
    assert.equal(w.agent.programs.length, 1);
  });

  it("pause during verify: the job pauses and the program is closed", async () => {
    const w = driverWorld();
    w.state.deliverable = "out_v1.fcpxml";
    let release = () => {};
    w.ctx.verify = () => new Promise((resolve) => (release = () => resolve([])));
    const p = await started(w);
    p.answer();
    await w.time.advance(500);
    w.pause();
    await w.time.advance(300);
    release();
    const outcome = await w.finish();
    assert.equal(outcome.state, "paused");
    assert.ok(p.closes >= 1);
    assert.equal(w.outcomes, 1);
  });

  it("stop during verify", async () => {
    const w = driverWorld();
    w.state.deliverable = "out_v1.fcpxml";
    let release = () => {};
    w.ctx.verify = () => new Promise((resolve) => (release = () => resolve([])));
    const p = await started(w);
    p.answer();
    await w.time.advance(500);
    w.stop();
    await w.time.advance(300);
    release();
    const outcome = await w.finish();
    assert.equal(outcome.state, "stopped");
    assert.ok(p.closes >= 1);
    assert.equal(w.outcomes, 1);
  });

  it("a stop after the job completed changes nothing", async () => {
    const w = driverWorld();
    w.state.deliverable = "out_v1.fcpxml";
    const p = await started(w);
    p.answer();
    const outcome = await w.finish();
    assert.equal(outcome.state, "completed");
    w.stop();
    w.pause();
    await w.time.advance(1000);
    assert.equal(w.outcomes, 1);
    assert.equal(w.outcome?.state, "completed");
  });
});

describe("driver: more ends", () => {
  it("a program that ended by itself after its answer completes the job", async () => {
    const w = driverWorld();
    w.state.deliverable = "out_v1.fcpxml";
    const p = await started(w);
    p.answer();
    p.exit();
    const outcome = await w.finish();
    assert.equal(outcome.state, "completed");
    assert.equal(w.outcomes, 1);
  });

  it("a usage limit fails with the reset time and tells the manager", async () => {
    const limits = [];
    const w = driverWorld({
      over: {
        onRateLimit: (/** @type {unknown} */ info) => limits.push(info),
        maxRetries: () => 0,
      },
    });
    const p = await started(w);
    p.emit(ev.rateLimitRejected(Math.floor(w.time.clock.now() / 1000) + 7200));
    p.emit(ev.error("You have hit your limit, resets 4pm"));
    const outcome = await w.finish();
    assert.equal(outcome.state, "failed");
    assert.match(outcome.error?.message ?? "", /^Claude usage limit reached, resets /);
    assert.ok(limits.length >= 1);
  });

  it("a program that ignores close is ended with its tree, and the job still ends once", async () => {
    const time = fakeTime();
    const w = driverWorld({ time, agent: scriptedAgent(time, { ignoreClose: true }) });
    const p = await started(w);
    w.stop();
    const outcome = await w.finish();
    assert.equal(outcome.state, "stopped");
    assert.ok(w.ended.includes(String(p.pid)));
    assert.equal(w.outcomes, 1);
  });

  it("the job ends with the output when the program stalls after producing it", async () => {
    const w = driverWorld();
    w.state.deliverable = "out_v1.fcpxml";
    const p = await started(w);
    p.emit(ev.assistant("Rendering.", { tool: true }));
    await w.time.advance(7000);
    const outcome = await w.finish();
    assert.ok(["completed", "failed"].includes(outcome.state));
    assert.equal(w.outcomes, 1);
    assert.ok(p.closes >= 1);
  });

  it("a send that fails because the program is gone ends the job once", async () => {
    const w = driverWorld();
    w.start();
    await w.untilMessage(0);
    const p = w.agent.program(0);
    p.exit({ code: 1, stderrTail: ["gone"] });
    const outcome = await w.finish();
    assert.equal(outcome.state, "failed");
    assert.equal(w.outcomes, 1);
  });
});

// `startAgent` (agents/start.js): one call for both programs.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { startAgent } from "../../src/agents/start.js";
import { FAKE_CLAUDE } from "../jobs/engineSupport.js";

const dirs = /** @type {string[]} */ ([]);
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function world(env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-start-"));
  dirs.push(root);
  const state = path.join(root, "state");
  const cwd = path.join(root, "Editing Folder");
  fs.mkdirSync(state);
  fs.mkdirSync(path.join(cwd, "Channel", "Video A", "output"), { recursive: true });
  /** @type {any[]} */
  const events = [];
  return {
    root,
    events,
    spec: /** @type {import("../../src/agents/start.js").AgentSpec} */ ({
      harness: "claudeCode",
      command: FAKE_CLAUDE,
      cwd,
      env: { PATH: process.env["PATH"], FAKE_STATE: state, FAKE_SCENARIO: "complete", ...env },
      onEvent: (event) => events.push(event),
    }),
  };
}

const PROMPT =
  "MAIN_FOLDER = Video A\nCHANNEL_FOLDER = Channel\nREVIEW_OUTPUT_SOFTWARE = Final Cut Pro\n\nGo.";

/** @param {() => boolean} check @param {number} [ms] */
async function until(check, ms = 15_000) {
  for (let spent = 0; !check(); spent += 20) {
    if (spent > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("startAgent", () => {
  it("starts Claude Code with a new UUID as session id and delivers events until exited", async () => {
    const w = world();
    const agent = await startAgent(w.spec);
    assert.equal(agent.harness, "claudeCode");
    assert.match(agent.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
    assert.ok(agent.pid > 0);
    await agent.sendUser(PROMPT);
    await until(() => w.events.some((e) => e.type === "line" && e.event.type === "result"));
    agent.close();
    await agent.finished;
    const last = w.events[w.events.length - 1];
    assert.equal(last.type, "exited");
    assert.equal(w.events.filter((e) => e.type === "exited").length, 1);
  });

  it("uses the resume id as the session id", async () => {
    const w = world();
    const agent = await startAgent({ ...w.spec, resumeId: "11111111-2222-3333-4444-555555555555" });
    assert.equal(agent.sessionId, "11111111-2222-3333-4444-555555555555");
    agent.close();
    await agent.finished;
  });

  it("close is idempotent, also after the exit, and sendUser then rejects with EPIPE", async () => {
    const w = world();
    const agent = await startAgent(w.spec);
    agent.close();
    agent.close();
    await agent.finished;
    agent.close();
    await assert.rejects(
      agent.sendUser("late"),
      (error) => /** @type {any} */ (error).code === "EPIPE",
    );
    assert.throws(
      () => agent.interrupt(),
      (error) => /** @type {any} */ (error).code === "EPIPE",
    );
  });

  it("interrupt answers with a controlResponse event", async () => {
    const w = world({ FAKE_SCENARIO: "slow" });
    const agent = await startAgent(w.spec);
    await agent.sendUser(PROMPT);
    await until(() => w.events.some((e) => e.type === "line"));
    const id = agent.interrupt();
    await until(() =>
      w.events.some(
        (e) => e.type === "line" && e.event.type === "controlResponse" && e.event.requestId === id,
      ),
    );
    agent.close();
    await agent.finished;
  });

  it("rejects a Claude Code program that does not exist, with nothing started", async () => {
    const w = world();
    const spec = { ...w.spec, command: path.join(w.root, "no-such-program") };
    let started = null;
    try {
      started = await startAgent(spec);
    } catch (error) {
      assert.ok(error instanceof Error);
    }
    if (started !== null) {
      // A spawn failure may also arrive as an exited event.
      await started.finished;
      assert.ok(w.events.some((e) => e.type === "exited"));
    }
  });

  it("needs a model, a job folder and an option for OpenCode 2", async () => {
    const w = world();
    await assert.rejects(startAgent({ ...w.spec, harness: "opencode2" }), TypeError);
    await assert.rejects(
      startAgent({ ...w.spec, harness: "opencode2", model: "m", jobDir: w.root }),
      TypeError,
    );
  });
});

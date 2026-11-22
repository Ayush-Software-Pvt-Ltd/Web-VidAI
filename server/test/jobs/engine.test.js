// The job driver against the real fake programs (`support/fake-claude.sh`, and once
// `support/fake-opencode2.py`) with shortened timings
// (docs/SPEC.md section 8). The queue, start delay and the manager's recovery are not here.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { isAlive } from "../../src/platform/process.js";
import { FAKE_OPENCODE, engineWorld } from "./engineSupport.js";

/** @param {() => boolean} check @param {string} [what] @param {number} [ms] */
async function waitFor(check, what = "the condition", ms = 30_000) {
  for (let spent = 0; !check(); spent += 20) {
    if (spent > ms) throw new Error(`${what} never happened`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * The recorded starts of the fake: mode, session, arguments and what was sent.
 * @param {ReturnType<typeof engineWorld>} w
 * @returns {Array<{ pid: number, mode?: string, sid?: string, stdin: string }>}
 */
function calls(w) {
  if (!w.has("calls")) return [];
  return w
    .read("calls")
    .split("\n")
    .filter(Boolean)
    .map((/** @type {string} */ pid) => {
      const fields = Object.fromEntries(
        w
          .read(`call.${pid}`)
          .split("\n")
          .filter((/** @type {string} */ l) => l.includes("="))
          .map((/** @type {string} */ l) => [
            l.slice(0, l.indexOf("=")),
            l.slice(l.indexOf("=") + 1),
          ]),
      );
      return { pid: Number(pid), ...fields, stdin: w.has(`in.${pid}`) ? w.read(`in.${pid}`) : "" };
    });
}

const edit = (/** @type {string} */ scenario) => ({ FAKE_SCENARIO: scenario });
const noErrors = (/** @type {any} */ w) =>
  assert.deepEqual(
    w.entries.filter((/** @type {{ kind: string }} */ e) => e.kind === "error"),
    [],
  );

describe("engine with the fake Claude Code", () => {
  it("an edit runs to completion and leaves nothing behind", async (t) => {
    const w = engineWorld(t, edit("complete"));
    const outcome = await w.run().done;
    assert.equal(outcome.state, "completed");
    assert.equal(outcome.error, null);
    assert.equal(outcome.deliverable, "Video A_v1.fcpxml");
    assert.equal(outcome.costUsd, 0.25);
    assert.match(outcome.sessionId ?? "", /^[0-9a-f-]{36}$/);
    assert.ok(w.outputFiles().includes("Video A_v1.fcpxml"));
    assert.deepEqual(w.registry.entries(), [], "the registry forgot the process");
    const [call] = calls(w);
    assert.equal(call?.mode, "new");
    assert.equal(isAlive(call?.pid ?? 0), false);
    noErrors(w);
    assert.ok(w.patches.some((p) => p.sessionId === outcome.sessionId));
    assert.ok(w.patches.some((p) => typeof p.lastActivity === "string"));
  });

  it("a background task after the first result keeps the job running", async (t) => {
    const w = engineWorld(t, edit("background"));
    const handle = w.run();
    await waitFor(
      () => w.texts().includes("Waiting for a background task: Render final"),
      "the wait line",
    );
    await waitFor(
      () => w.patches.some((p) => p.lastActivity === "Waiting for a background task: Render final"),
      "the activity",
    );
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(w.has("closed_early"), false);
    w.write("release.background", "");
    const outcome = await handle.done;
    assert.equal(outcome.state, "completed");
    assert.equal(w.has("closed_early"), false, "stdin was closed while the task ran");
    assert.equal(outcome.costUsd, 0.3);
    assert.ok(w.texts().includes("Background task completed: Render final"), w.texts().join("|"));
  });

  it("pause then continue resumes the same session", async (t) => {
    const w = engineWorld(t, edit("slow"));
    const first = w.run();
    await waitFor(() => w.texts().includes("Bash: Long step"), "the long step");
    first.pause();
    const paused = await first.done;
    assert.equal(paused.state, "paused");
    assert.equal(paused.error, null);
    assert.ok(paused.activeMs > 0);
    assert.equal(
      w.entries.filter((e) => e.kind === "error").length,
      0,
      "the interrupt is not an error",
    );
    const [one] = calls(w);
    assert.equal(one?.mode, "new");
    assert.match(one?.stdin ?? "", /"subtype":"interrupt"/);

    const second = w.run({
      job: {
        id: "job-1",
        kind: "edit",
        videoId: "video-1",
        videoDir: w.video,
        sessionId: paused.sessionId,
        setup: "claudeSubscription",
      },
      firstMessage:
        "MAIN_FOLDER = Video A\nCHANNEL_FOLDER = Channel\nREVIEW_OUTPUT_SOFTWARE = Final Cut Pro\n\nContinue the video edit from where it was paused.",
      fullMessage:
        "MAIN_FOLDER = Video A\nCHANNEL_FOLDER = Channel\nREVIEW_OUTPUT_SOFTWARE = Final Cut Pro\n\nStart.",
      env: undefined,
    });
    const done = await second.done;
    assert.equal(done.state, "completed");
    assert.equal(done.sessionId, paused.sessionId);
    const all = calls(w);
    assert.equal(all.length, 2);
    assert.equal(all[1]?.mode, "resume");
    assert.equal(all[1]?.sid, paused.sessionId);
  });

  it("a pause that cuts a running step reads as stopped, not as an error", async (t) => {
    const w = engineWorld(t, edit("slow"));
    const first = w.run();
    await waitFor(() => w.texts().includes("Bash: Long step"), "the long step");
    first.pause();
    assert.equal((await first.done).state, "paused");
    const cut = w.entries.find((e) => e.kind === "toolResult");
    assert.equal(cut?.text, "Stopped by the pause");
    assert.match(cut?.detail ?? "", /^\[1\/124\] {4}8\.19- {2}10\.87 Hello there\n\[2\/124\]/);
    assert.ok(w.texts().every((x) => !x.startsWith("Error")));
  });

  it("stop ends the whole process tree", async (t) => {
    const w = engineWorld(t, edit("tree"));
    const handle = w.run();
    await waitFor(() => w.has("tree.ready"), "the tree");
    const pids = w.read("tree.pids").split("\n").filter(Boolean).map(Number);
    assert.equal(pids.length, 3);
    assert.ok(pids.every(isAlive));
    await waitFor(() => w.registry.entries().length === 1, "the registered process");
    handle.stop();
    const outcome = await handle.done;
    assert.equal(outcome.state, "stopped");
    assert.deepEqual(pids.filter(isAlive), []);
    assert.deepEqual(w.registry.entries(), []);
  });

  it("a crash reports the last stderr line", async (t) => {
    const w = engineWorld(t, edit("crash"));
    const outcome = await w.run().done;
    assert.equal(outcome.state, "failed");
    assert.match(
      outcome.error?.message ?? "",
      /Claude Code stopped unexpectedly \(exit code 2\): Error: boom/,
    );
  });

  it("a failure without output fails as stuck", async (t) => {
    const w = engineWorld(t, edit("no_output"));
    const outcome = await w.run().done;
    assert.equal(outcome.state, "failed");
    assert.ok((outcome.error?.message ?? "").length > 0);
    assert.equal(w.outputFiles().filter((f) => f.endsWith(".fcpxml")).length, 0);
    assert.deepEqual(w.registry.entries(), []);
  });

  it("a usage limit is reported to the manager and fails the job", async (t) => {
    /** @type {unknown[]} */
    const limits = [];
    const w = engineWorld(t, edit("usage_limit"));
    const outcome = await w.run({ onRateLimit: (/** @type {unknown} */ info) => limits.push(info) })
      .done;
    assert.equal(outcome.state, "failed");
    assert.ok(limits.length >= 1);
    assert.match(outcome.error?.message ?? "", /^Claude usage limit reached, resets /);
    assert.ok(limits.some((l) => l && /** @type {any} */ (l).status === "rejected"));
  });

  it("a lost login is reported with the login text", async (t) => {
    const w = engineWorld(t, edit("logged_out"));
    const outcome = await w.run().done;
    assert.equal(outcome.state, "failed");
    assert.equal(
      outcome.error?.message,
      "Claude Code is logged out. Log in again (Settings, System), then press Continue Editing.",
    );
  });

  it("a model error without retries fails at once", async (t) => {
    const w = engineWorld(t, edit("model_error"));
    const outcome = await w.run({ maxRetries: () => 0 }).done;
    assert.equal(outcome.state, "failed");
    assert.equal(calls(w).length, 1);
    assert.match(outcome.error?.message ?? "", /529|overloaded/i);
  });

  it("a model error is retried in the same session until it works", async (t) => {
    const w = engineWorld(t, edit("model_error"));
    const outcome = await w.run({
      maxRetries: () => 5,
      continueMessage:
        "MAIN_FOLDER = Video A\nCHANNEL_FOLDER = Channel\nREVIEW_OUTPUT_SOFTWARE = Final Cut Pro\n\nGo on.",
    }).done;
    assert.equal(outcome.state, "completed");
    const all = calls(w);
    assert.equal(all.length, 3, "two failures and the run that works");
    assert.equal(all[0]?.mode, "new");
    assert.equal(all[1]?.mode, "resume");
    assert.equal(all[1]?.sid, outcome.sessionId);
    assert.equal(all[2]?.mode, "resume");
  });

  it("retries run out and the job fails saying so", async (t) => {
    const w = engineWorld(t, edit("model_error"));
    w.write("model_errors", "10");
    const outcome = await w.run({ maxRetries: () => 2 }).done;
    assert.equal(outcome.state, "failed");
    assert.equal(calls(w).length, 3);
    assert.match(outcome.error?.message ?? "", /2/);
  });

  it("a waiting retry can be paused", async (t) => {
    const w = engineWorld(t, edit("model_error"));
    const handle = w.run({
      maxRetries: () => 5,
      timings: {
        settle: 250,
        interruptTimeout: 3000,
        exitTimeout: 5000,
        killGrace: 500,
        stallTimeout: 15_000,
        progressInterval: 100,
        treeRefresh: 200,
        retrySecond: 60_000,
      },
    });
    await waitFor(() => w.texts().some((t) => /529|overloaded/i.test(t)), "the error");
    await waitFor(() => w.registry.entries().length === 0, "the first program gone");
    handle.pause();
    const outcome = await handle.done;
    assert.equal(outcome.state, "paused");
    assert.equal(calls(w).length, 1);
  });

  it("a quiet usage limit waits for its reset and can be stopped meanwhile", async (t) => {
    const w = engineWorld(t, edit("quiet_limit"));
    const handle = w.run({ maxRetries: () => 1 });
    await waitFor(() => w.texts().some((x) => x.includes("(retry 1 of 1)")), "the retry line");
    assert.equal(calls(w).length, 1);
    handle.stop();
    const outcome = await handle.done;
    assert.equal(outcome.state, "stopped");
    assert.equal(calls(w).length, 1, "no second program while it waits");
  });

  it("a resumed session that is gone goes on in a new one with the full message", async (t) => {
    const w = engineWorld(t, edit("resume_missing"));
    const outcome = await w.run({
      job: {
        id: "job-1",
        kind: "edit",
        videoId: "video-1",
        videoDir: w.video,
        sessionId: "00000000-0000-4000-8000-000000000000",
        setup: "claudeSubscription",
      },
      firstMessage:
        "MAIN_FOLDER = Video A\nCHANNEL_FOLDER = Channel\nREVIEW_OUTPUT_SOFTWARE = Final Cut Pro\n\nContinue.",
      fullMessage:
        "MAIN_FOLDER = Video A\nCHANNEL_FOLDER = Channel\nREVIEW_OUTPUT_SOFTWARE = Final Cut Pro\n\nFull edit.",
    }).done;
    assert.equal(outcome.state, "completed");
    const all = calls(w);
    assert.equal(all[0]?.mode, "resume");
    assert.equal(all[1]?.mode, "new");
    assert.match(all[1]?.stdin ?? "", /Full edit\./);
    assert.notEqual(outcome.sessionId, "00000000-0000-4000-8000-000000000000");
  });

  it("an edit that ends turns early keeps going until it is done", async (t) => {
    const w = engineWorld(t, edit("premature"));
    w.write("stops", "1 3");
    const outcome = await w.run().done;
    assert.equal(outcome.state, "completed");
    assert.equal(calls(w).length, 1, "one process, several messages");
    const sent =
      calls(w)[0]
        ?.stdin.split("\n")
        .filter((/** @type {string} */ l) => l.includes('"type":"user"')) ?? [];
    assert.ok(sent.length >= 3, `${sent.length} messages`);
    noErrors(w);
  });

  it("a model that only talks is stuck after the nudges", async (t) => {
    const w = engineWorld(t, edit("no_output"));
    const outcome = await w.run().done;
    assert.equal(outcome.state, "failed");
    assert.equal(outcome.error?.code, "failed");
  });

  it("a busy model without progress is stuck", async (t) => {
    const w = engineWorld(t, edit("spin"));
    const outcome = await w.run().done;
    assert.equal(outcome.state, "failed");
    assert.deepEqual(w.registry.entries(), []);
  });

  it("an API error stops at once without a continuation", async (t) => {
    const w = engineWorld(t, edit("api_error"));
    const outcome = await w.run().done;
    assert.equal(outcome.state, "failed");
    assert.equal(calls(w).length, 1);
    const sent =
      calls(w)[0]
        ?.stdin.split("\n")
        .filter((/** @type {string} */ l) => l.includes('"type":"user"')) ?? [];
    assert.equal(sent.length, 1);
  });

  it("stop right after an early end sends no continuation", async (t) => {
    const w = engineWorld(t, edit("premature"));
    w.write("stops", "2");
    const handle = w.run();
    await waitFor(
      () => fs.readdirSync(w.state).some((f) => f.startsWith("ended.")),
      "the early end",
      30_000,
    );
    handle.stop();
    const outcome = await handle.done;
    assert.ok(["stopped", "completed"].includes(outcome.state));
    assert.deepEqual(w.registry.entries(), []);
  });

  it("a render needs a new output file (the deliverable function decides)", async (t) => {
    const w = engineWorld(t, edit("complete"));
    const seen = [];
    const outcome = await w.run({
      deliverable: () => {
        const files = fs
          .readdirSync(path.join(w.video, "output"))
          .filter((f) => f.endsWith(".fcpxml"));
        seen.push(files.length);
        return files[0] ?? null;
      },
    }).done;
    assert.equal(outcome.state, "completed");
    assert.ok(seen.length > 0);
  });

  it("leaves no program of the fake running", async (t) => {
    const w = engineWorld(t, edit("complete"));
    await w.run().done;
    for (const call of calls(w)) assert.equal(isAlive(call.pid), false);
  });
});

describe("engine with the fake OpenCode 2", () => {
  it("an edit runs to completion on OpenCode 2", async (t) => {
    const w = engineWorld(t, { FAKE_SCENARIO: "complete" });
    const jobDir = path.join(w.root, "data", "opencode", "job-1");
    const outcome = await w.run({
      job: {
        id: "job-1",
        kind: "edit",
        videoId: "video-1",
        videoDir: w.video,
        sessionId: null,
        setup: "opencodeGo",
      },
      agent: {
        harness: "opencode2",
        command: FAKE_OPENCODE,
        cwd: w.editing,
        env: { PATH: process.env["PATH"], FAKE_STATE: w.state, FAKE_SCENARIO: "complete" },
        model: "glm-5.3",
        effort: null,
        jobDir,
        option: "opencodeGo",
        key: "sk-test-0123456789abcdef-not-a-real-key",
        timings: { startTimeoutMs: 20_000 },
      },
    }).done;
    assert.equal(outcome.state, "completed", JSON.stringify(outcome.error));
    assert.ok(w.outputFiles().some((f) => f.endsWith(".fcpxml")));
    assert.equal(fs.existsSync(jobDir), false, "the job folder is removed");
    assert.deepEqual(w.registry.entries(), []);
  });

  it("a pause that cuts a running step reads as stopped, not as an error", async (t) => {
    const w = engineWorld(t, { FAKE_SCENARIO: "hold" });
    const jobDir = path.join(w.root, "data", "opencode", "job-1");
    const handle = w.run({
      job: {
        id: "job-1",
        kind: "edit",
        videoId: "video-1",
        videoDir: w.video,
        sessionId: null,
        setup: "opencodeGo",
      },
      agent: {
        harness: "opencode2",
        command: FAKE_OPENCODE,
        cwd: w.editing,
        env: { PATH: process.env["PATH"], FAKE_STATE: w.state, FAKE_SCENARIO: "hold" },
        model: "glm-5.3",
        effort: null,
        jobDir,
        option: "opencodeGo",
        key: "sk-test-0123456789abcdef-not-a-real-key",
        timings: { startTimeoutMs: 20_000 },
      },
    });
    await waitFor(() => w.has("started.Video A"), "the held command");
    handle.pause();
    assert.equal((await handle.done).state, "paused");
    const results = w.entries.filter((e) => e.kind === "toolResult");
    const cut = results.at(-1);
    assert.equal(cut?.text, "Stopped by the pause");
    assert.match(cut?.detail ?? "", /\[1\/124\] {4}8\.19- {2}10\.87 Hello there/);
    assert.match(cut?.detail ?? "", /Tool execution interrupted/);
    assert.ok(
      w.texts().every((x) => !x.startsWith("Error")),
      w.texts().join("|"),
    );
  });
});

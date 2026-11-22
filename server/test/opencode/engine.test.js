// The session part of `src-tauri/tests/opencode2_engine.rs`, against the fake OpenCode 2: what the
// server is started with, the model and effort of the messages, early ends, pause and continue,
// background work, the tool tree, permissions and questions, limits and crashes.
//
// Left out on purpose (they test the job manager, not the driver): queueing of a second edit, two
// videos never sharing a session, re-edit and render prompts, the program fallback of a resumed
// job, a restart keeping the session, log texts, the continuation text and `no_output` (the job
// engine counts continuations), and the real OpenCode smoke test. The `echo_key` scrubbing of tool
// output is the engine's job too: the driver scrubs what it says itself (see `server.test.js`).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { QUESTION_CANCELLED } from "../../src/agents/opencode/events.js";
import { isAlive } from "../../src/platform/process.js";
import { KEY, MODEL, editPrompt, makeWorld, pidsOf, until, untilDead } from "./engineSupport.js";

const OPENAI_ADDRESS = "https://opencode.ai/inference/go/v1";

/** @param {import("./engineSupport.js").World} world */
const firstModel = (world) => {
  const [session] = world.files("prompts.").map(([name]) => name);
  assert.ok(session, "a message was sent");
  return world.prompts(session)[0]?.["model"];
};

/** @param {import("./engineSupport.js").World} world @param {string} id */
const controlResponse = (world, id) =>
  until("the interrupt's answer", () =>
    world.events.find(
      (e) => e.type === "line" && e.event.type === "controlResponse" && e.event.requestId === id,
    ),
  );

test("an edit runs to completion on one server and reports like Claude Code", async (t) => {
  const world = makeWorld(t);
  const session = await world.start();
  await session.sendUser(editPrompt());
  await world.results(2);
  const types = new Set(world.events.map((e) => (e.type === "line" ? e.event.type : e.type)));
  for (const type of /** @type {const} */ (["system", "assistant", "user", "result"])) {
    assert.ok(types.has(type), type);
  }
  assert.equal(world.calls().length, 1, "one server");
  const sent = world.prompts(session.sessionId);
  assert.equal(sent.length, 1);
  assert.ok(sent[0]?.["text"].startsWith("MAIN_FOLDER = Video A\n"));
  assert.equal(sent[0]?.["directory"], world.editing);
  const final = world.resultEvents().at(-1);
  assert.equal(final?.isError, false);
  assert.ok((final?.totalCostUsd ?? 0) > 0);
  session.close();
  await session.finished;
  await untilDead([session.pid]);
});

test("the server's environment and configuration are the ones the setup asks for", async (t) => {
  const world = makeWorld(t, {
    // Variables that would change a run, or belong to Claude Code only.
    OPENCODE_PASSWORD: "someone-elses",
    ANTHROPIC_BASE_URL: "http://claude.only",
  });
  const session = await world.start();
  const [call] = world.calls();
  assert.ok(call);
  assert.equal(call["args"], "serve --stdio --hostname 127.0.0.1 --port 0");
  assert.equal(call["cwd"], fs.realpathSync(world.editing));
  assert.equal(call["OPENCODE_API_KEY"], KEY);
  assert.equal(call["OPENCODE_SERVER_PASSWORD"], "<set>");
  assert.equal(call["OPENCODE_PASSWORD"], "<unset>");
  assert.equal(call["OPENCODE_DISABLE_AUTOUPDATE"], "1");
  assert.equal(call["ANTHROPIC_BASE_URL"], "<unset>");
  const config = JSON.parse(call["OPENCODE_CONFIG_CONTENT"] ?? "{}");
  assert.equal(config.snapshots, false);
  assert.equal(config.instructions[0], path.join(world.editing, "CLAUDE.md"));
  assert.equal(config.providers.vidai.settings.apiKey, "{env:OPENCODE_API_KEY}");
  assert.ok(!(call["OPENCODE_CONFIG_CONTENT"] ?? "").includes(KEY));
  await session.sendUser(editPrompt());
  assert.deepEqual(firstModel(world), { providerID: "opencode-go", id: MODEL });
});

test("the Go address runs on OpenCode's own provider only with VidAI's key", async (t) => {
  const world = makeWorld(t);
  const first = await world.start();
  await first.sendUser(editPrompt());
  assert.deepEqual(firstModel(world), { providerID: "opencode-go", id: MODEL });
  assert.equal(first.model, "opencode-go/glm-5.3");
  await world.results(2);
  first.close();
  await first.finished;

  // A login stored in OpenCode would be used instead of VidAI's key: the resumed session moves to
  // VidAI's own provider.
  world.env["FAKE_OPENCODE2_LOGIN"] = "stored";
  const second = await world.start({
    baseUrl: null,
    title: undefined,
    resumeId: first.sessionId,
  });
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.model, "vidai/glm-5.3");
  const switched = world.files("model.").map(([session, model]) => [session, JSON.parse(model)]);
  assert.deepEqual(switched, [[first.sessionId, { providerID: "vidai", id: MODEL }]]);
  await second.sendUser("Cut the intro.");
  assert.deepEqual(world.prompts(first.sessionId)[1]?.["model"], {
    providerID: "vidai",
    id: MODEL,
  });
});

test("a model OpenCode's catalog does not list runs on VidAI's provider", async (t) => {
  const world = makeWorld(t, { FAKE_OPENCODE_MODELS: "kimi-k3" });
  const session = await world.start();
  await session.sendUser(editPrompt());
  assert.deepEqual(firstModel(world), { providerID: "vidai", id: MODEL });
});

test("an OpenAI-compatible edit runs on VidAI's provider with its own key variable", async (t) => {
  for (const address of ["http://127.0.0.1:9/v1", OPENAI_ADDRESS]) {
    const world = makeWorld(t, {
      FAKE_OPENCODE2_LOGIN: "stored",
      VIDAI_API_KEY: "the-users-own-key",
      OPENCODE_API_KEY: "the-users-own-opencode-key",
    });
    const session = await world.start({ option: "openaiApi", baseUrl: address });
    await session.sendUser(editPrompt());
    assert.deepEqual(firstModel(world), { providerID: "vidai", id: MODEL }, address);
    const [call] = world.calls();
    assert.ok(call);
    assert.equal(call["VIDAI_API_KEY"], KEY);
    assert.equal(call["OPENCODE_API_KEY"], "<unset>");
    const config = JSON.parse(call["OPENCODE_CONFIG_CONTENT"] ?? "{}");
    assert.deepEqual(config.providers, {
      vidai: {
        name: "OpenAI Compatible API (VidAI)",
        package: "@ai-sdk/openai-compatible",
        settings: { baseURL: address, apiKey: "{env:VIDAI_API_KEY}" },
        models: { [MODEL]: { name: MODEL } },
      },
    });
    for (const text of [call["args"], call["OPENCODE_CONFIG_CONTENT"]]) {
      assert.ok(!(text ?? "").includes(KEY));
    }
  }
});

test("an OpenAI-compatible edit without a key starts with no key at all", async (t) => {
  const world = makeWorld(t, { VIDAI_API_KEY: "the-users-own-key", OPENCODE_API_KEY: "own" });
  const session = await world.start({
    option: "openaiApi",
    baseUrl: "http://127.0.0.1:9/v1",
    key: null,
  });
  const [call] = world.calls();
  assert.ok(call);
  assert.equal(call["VIDAI_API_KEY"], "<unset>");
  assert.equal(call["OPENCODE_API_KEY"], "<unset>");
  const config = JSON.parse(call["OPENCODE_CONFIG_CONTENT"] ?? "{}");
  assert.equal(config.providers.vidai.settings.apiKey, undefined);
  await session.sendUser(editPrompt());
  await world.results(2);
});

test("an effort the model offers reaches the session as its variant", async (t) => {
  const world = makeWorld(t);
  const session = await world.start({ effort: "high" });
  await session.sendUser(editPrompt());
  assert.deepEqual(firstModel(world), { providerID: "opencode-go", id: MODEL, variant: "high" });
  assert.ok(world.statuses.every((text) => !text.includes("does not offer")));
});

test("an effort the model does not offer is left out and said", async (t) => {
  const world = makeWorld(t);
  const session = await world.start({ effort: "xhigh" });
  await session.sendUser(editPrompt());
  assert.deepEqual(firstModel(world), { providerID: "opencode-go", id: MODEL });
  assert.ok(
    world.statuses.some((text) => text.includes("does not offer the reasoning effort xhigh")),
  );
});

test("no effort sends no variant", async (t) => {
  const world = makeWorld(t);
  const session = await world.start({ effort: null });
  await session.sendUser(editPrompt());
  assert.equal(/** @type {any} */ (firstModel(world)).variant, undefined);
});

test("a turn that ends early is continued in the same session and server", async (t) => {
  const world = makeWorld(t, { FAKE_SCENARIO: "early_end" });
  const session = await world.start();
  await session.sendUser(editPrompt());
  await world.results(1);
  assert.equal(world.resultEvents()[0]?.isError, false);
  await session.sendUser("Keep working.");
  await world.results(2);
  assert.equal(world.prompts(session.sessionId).length, 2);
  assert.equal(world.calls().length, 1, "the same live server");
});

test("background work is waited for: the first busy period is no final result", async (t) => {
  const world = makeWorld(t);
  const session = await world.start();
  await session.sendUser(editPrompt());
  await world.results(2);
  assert.equal(world.prompts(session.sessionId).length, 1, "no continuation was needed");
  const [first] = world.resultEvents();
  assert.match(String(first?.text), /built in the background/);
});

test("interrupt answers at once, ends the turn without an error, and a new server resumes the session", async (t) => {
  const world = makeWorld(t, { FAKE_SCENARIO: "hold" });
  const session = await world.start();
  await session.sendUser(editPrompt());
  await until("the held command", () => world.has("started.Video A"));
  const asked = Date.now();
  const id = session.interrupt();
  assert.match(id, /^vidai-interrupt-\d+$/);
  const answer = await controlResponse(world, id);
  assert.ok(Date.now() - asked < 10_000);
  assert.equal(
    answer.type === "line" && answer.event.type === "controlResponse" && answer.event.success,
    true,
  );
  assert.ok(world.has(`interrupt.${session.sessionId}`));
  await until("the interrupted turn's result", () => world.resultEvents().length >= 1);
  assert.ok(
    world.resultEvents().every((r) => r.terminalReason === "aborted"),
    "the interrupted turn ends as aborted, not as a failure",
  );
  session.close();
  await session.finished;
  await untilDead([session.pid]);

  const resumed = await world.start({ title: undefined, resumeId: session.sessionId });
  assert.equal(resumed.sessionId, session.sessionId);
  assert.equal(world.calls().length, 2, "a new server for the same session");
  await resumed.sendUser("Continue the edit.");
  await until("the command again", () => world.has("started.Video A"));
  fs.writeFileSync(path.join(world.state, "release.Video A"), "");
  await until("the end of the turn", () => world.resultEvents().some((r) => r.isError === false));
  assert.equal(world.prompts(session.sessionId).length, 2);
});

test("an interrupt stops background commands and sub-agents too", async (t) => {
  const world = makeWorld(t, { FAKE_SCENARIO: "background_hold" });
  const session = await world.start();
  await session.sendUser(editPrompt());
  await until("the background command", () => world.has("started.Video A"));
  const pids = pidsOf(world, "tree.pids");
  assert.equal(pids.length, 1);
  assert.ok(isAlive(/** @type {number} */ (pids[0])));
  const id = session.interrupt();
  await controlResponse(world, id);
  await untilDead(pids);
  const deleted = world.files("deleted.");
  assert.equal(deleted.length, 1, JSON.stringify(deleted));
  assert.equal(fs.realpathSync(String(deleted[0]?.[1]).trim()), fs.realpathSync(world.editing));
  const interrupted = world.files("interrupt.");
  assert.ok(interrupted.length >= 2, JSON.stringify(interrupted));
  assert.ok(interrupted.some(([name]) => name === session.sessionId));
  assert.ok(
    world.resultEvents().every((r) => r.isError !== true || r.terminalReason === "aborted"),
    "an interrupt is no failure",
  );
});

test("closing ends the whole process tree", async (t) => {
  const world = makeWorld(t, { FAKE_SCENARIO: "tree" });
  const session = await world.start();
  await session.sendUser(editPrompt());
  await until("the tree", () => world.has("tree.ready"));
  const pids = pidsOf(world, "tree.pids");
  session.close();
  await session.finished;
  await untilDead([session.pid, ...pids]);
});

test("a session the program no longer has is reported as Claude Code reports it", async (t) => {
  const world = makeWorld(t);
  const first = await world.start();
  await first.sendUser(editPrompt());
  await world.results(2);
  first.close();
  await first.finished;
  fs.rmSync(path.join(world.state, "opencode2-sessions"), { recursive: true, force: true });
  world.events.length = 0;
  const second = await world.start({ title: undefined, resumeId: first.sessionId });
  await world.exited();
  await second.finished;
  const [result] = world.resultEvents();
  assert.equal(result?.isError, true);
  assert.match(String(result?.errors.join(" ")), /No conversation found with session ID: ses_/);
});

test("a failing step ends the turn with an error result", async (t) => {
  for (const scenario of ["api_error", "usage_limit", "usage_limit_retry"]) {
    const world = makeWorld(t, { FAKE_SCENARIO: scenario });
    const session = await world.start();
    await session.sendUser(editPrompt());
    await until(`${scenario}: an error result`, () =>
      world.resultEvents().find((r) => r.isError === true),
    );
    session.close();
    await session.finished;
    await untilDead([session.pid]);
  }
});

test("a permission request is answered without a person", async (t) => {
  const world = makeWorld(t, { FAKE_SCENARIO: "permission" });
  const session = await world.start();
  await session.sendUser(editPrompt());
  await world.results(1);
  assert.deepEqual(
    world.files("permission.per_").map(([, answer]) => answer),
    ["once"],
  );
});

test("a question is cancelled with the text that tells the model to go on", async (t) => {
  const world = makeWorld(t, { FAKE_SCENARIO: "question" });
  const session = await world.start();
  await session.sendUser(editPrompt());
  await world.results(1);
  const forms = world.files("form.frm_");
  assert.equal(forms.length, 1);
  assert.equal(forms[0]?.[1], QUESTION_CANCELLED);
});

test("a crash reports the last line of the program", async (t) => {
  const world = makeWorld(t, { FAKE_SCENARIO: "crash" });
  const session = await world.start();
  await session.sendUser(editPrompt()).catch(() => {});
  await world.exited();
  const exit = world.events.find((e) => e.type === "exited");
  assert.ok(exit && exit.type === "exited");
  assert.ok(exit.exit.stderrTail.join("\n").includes("Error: boom"));
  assert.notEqual(exit.exit.code, 0);
});

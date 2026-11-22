// `startOpencodeSession`: the arguments it accepts and the contract it keeps with the job engine
// (an `AgentProcess` that reports `line` events and then `exited` once).

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { startOpencodeSession } from "../../src/agents/opencode/session.js";
import { editPrompt, makeWorld, until, untilDead } from "./engineSupport.js";

/** @param {Record<string, unknown>} over */
const options = (over) =>
  /** @type {any} */ ({
    command: "/nonexistent/opencode2",
    cwd: "/tmp",
    env: {},
    jobDir: "/tmp/vidai-never-made",
    option: "opencodeGo",
    key: "k",
    baseUrl: null,
    model: "glm-5.3",
    effort: null,
    title: "T",
    onEvent: () => {},
    ...over,
  });

test("an option the program cannot run, or a bad choice of title and resumeId, is a TypeError", async () => {
  await assert.rejects(startOpencodeSession(options({ option: "claudeSubscription" })), TypeError);
  await assert.rejects(startOpencodeSession(options({ option: "anthropicApi" })), TypeError);
  await assert.rejects(startOpencodeSession(options({ title: undefined })), TypeError);
  await assert.rejects(startOpencodeSession(options({ resumeId: "ses_1" })), TypeError);
  assert.equal(fs.existsSync("/tmp/vidai-never-made"), false);
});

test("a new session has the id OpenCode chose and the model it runs", async (t) => {
  const world = makeWorld(t);
  const session = await world.start();
  assert.match(session.sessionId, /^ses_/);
  assert.equal(session.model, "opencode-go/glm-5.3");
  assert.ok(Number.isInteger(session.pid) && session.pid > 0);
  assert.equal(typeof session.sendUser, "function");
  assert.equal(typeof session.interrupt, "function");
  assert.equal(typeof session.close, "function");
});

test("a session is resumed by its id and keeps it", async (t) => {
  const world = makeWorld(t);
  const first = await world.start();
  await first.sendUser(editPrompt());
  await world.results(2);
  first.close();
  await first.finished;
  const second = await world.start({ title: undefined, resumeId: first.sessionId });
  assert.equal(second.sessionId, first.sessionId);
  await second.sendUser("More.");
  assert.equal(world.prompts(first.sessionId).length, 2);
  assert.equal(world.calls().length, 2);
});

test("a resume of a session OpenCode does not have reports it and ends", async (t) => {
  const world = makeWorld(t);
  const session = await world.start({ title: undefined, resumeId: "ses_does_not_exist" });
  await world.exited();
  await session.finished;
  const [result] = world.resultEvents();
  assert.equal(result?.isError, true);
  assert.deepEqual(result?.errors, ["No conversation found with session ID: ses_does_not_exist"]);
  await untilDead([session.pid]);
  assert.throws(() => session.interrupt());
});

test("events come in order, the exit comes once and last, and nothing follows it", async (t) => {
  const world = makeWorld(t);
  const session = await world.start();
  await session.sendUser(editPrompt());
  await world.results(2);
  session.close();
  await session.finished;
  await new Promise((resolve) => setTimeout(resolve, 200));
  const exits = world.events.filter((e) => e.type === "exited");
  assert.equal(exits.length, 1);
  assert.equal(world.events.at(-1)?.type, "exited");
  const times = world.events.map((e) => e.at);
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
  );
  assert.equal(world.resultEvents().length, 2);
});

test("close is idempotent, and sendUser and interrupt after it fail like a closed pipe", async (t) => {
  const world = makeWorld(t);
  const session = await world.start();
  session.close();
  session.close();
  assert.throws(() => session.sendUser("x"), { code: "EPIPE" });
  assert.throws(() => session.interrupt(), { code: "EPIPE" });
  await session.finished;
  await untilDead([session.pid]);
});

test("an interrupt of an idle session still answers", async (t) => {
  const world = makeWorld(t);
  const session = await world.start();
  const id = session.interrupt();
  await until("the answer", () =>
    world.events.find(
      (e) => e.type === "line" && e.event.type === "controlResponse" && e.event.requestId === id,
    ),
  );
  assert.equal(session.interrupt(), "vidai-interrupt-2");
});

test("a callback that throws never takes the session down", async (t) => {
  const world = makeWorld(t);
  const session = await world.start({
    onEvent: () => {
      throw new Error("boom in the engine");
    },
    onStatus: () => {
      throw new Error("boom");
    },
  });
  await session.sendUser(editPrompt());
  await until("the work to be done", () => world.has("opencode2.calls") || undefined);
  session.close();
  await session.finished;
});

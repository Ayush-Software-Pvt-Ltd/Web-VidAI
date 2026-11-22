// Queues, Pause, Continue and Stop through the real server (SPEC sections 8 and 14).
import assert from "node:assert/strict";
import { test } from "node:test";
import { startWorld, until } from "./world.js";

test("limit 1: two users' jobs run one after the other, Urgent goes first; Pause, Continue, Stop", async () => {
  const w = await startWorld({ settings: { maxEdits: 1 } });
  try {
    w.scenario("hold");
    const alice = await w.addUser({ name: "alice" });
    const bob = await w.addUser({ name: "bob" });
    const a1 = await w.addVideo(alice, { folder: "A1" });
    const a2 = await w.addVideo(alice, { channel: "Second", folder: "A2" });
    const b1 = await w.addVideo(bob, { folder: "B1" });
    for (const v of [a1, a2, b1]) w.writesProject(v);
    const watch = await w.admin.openStream();
    const marks = { A1: w.signals(a1), A2: w.signals(a2), B1: w.signals(b1) };
    const started = (/** @type {"A1" | "A2" | "B1"} */ folder) => marks[folder].started();
    const release = (/** @type {"A1" | "A2" | "B1"} */ folder) => marks[folder].release();

    const j1 = (await alice.client.rpc("startEdit", { videoId: a1.videoId })).json.id;
    await until(() => started("A1"));
    const startedBob = await bob.client.rpc("startEdit", { videoId: b1.videoId });
    assert.equal(startedBob.status, 200, startedBob.text);
    const jb = startedBob.json.id;
    const startedA2 = await alice.client.rpc("startEdit", { videoId: a2.videoId });
    assert.equal(startedA2.status, 200, startedA2.text);
    const j2 = startedA2.json.id;
    assert.equal(w.stateOf(jb), "queued");
    assert.equal(w.stateOf(j2), "queued");
    assert.equal(started("B1"), false, "the limit of 1 holds");

    // The admin marks Alice's second job Urgent: it goes before Bob's, which waited longer.
    const urgent = await w.admin.rpc("adminSetJobUrgent", { jobId: j2, urgent: true });
    assert.equal(urgent.status, 200, urgent.text);
    release("A1");
    await w.waitState(j1, "completed");
    await until(() => started("A2"));
    assert.equal(started("B1"), false);
    release("A2");
    await w.waitState(j2, "completed");
    await until(() => started("B1"));

    // The admin saw every job; the order of "running" is the order the jobs ran in.
    const order = watch
      .messages()
      .filter((m) => m.event === "job-updated" && m.payload.state === "running")
      .map((m) => m.payload.id)
      .filter((id, index, all) => all.indexOf(id) === index);
    assert.deepEqual(order, [j1, j2, jb]);

    const paused = await bob.client.rpc("pauseJob", { jobId: jb });
    assert.equal(paused.status, 200, paused.text);
    await w.waitState(jb, "paused");
    const continued = await bob.client.rpc("continueJob", { jobId: jb });
    assert.equal(continued.status, 200, continued.text);
    await w.waitState(jb, "running");
    const stopped = await bob.client.rpc("stopJob", { jobId: jb });
    assert.equal(stopped.status, 200, stopped.text);
    await w.waitState(jb, "stopped");
    // The edit log line follows the new state a moment later: wait for the lines.
    /** @type {string} */
    let lines = "";
    for (let tries = 0; tries < 500; tries += 1) {
      lines = JSON.stringify((await bob.client.rpc("getEditLog", {})).json);
      if (["paused", "continued", "stopped"].every((word) => lines.includes(word))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const word of ["paused", "continued", "stopped"]) assert.match(lines, new RegExp(word));
  } finally {
    await w.close();
  }
});

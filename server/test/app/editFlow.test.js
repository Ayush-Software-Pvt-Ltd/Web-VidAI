// The story of an edit through the real server (SPEC sections 2, 8, 14): accounts, a channel, a
// video, Start Editing to completed, the events, the job log and the edit log.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startWorld, until } from "./world.js";

test("setup link, sign in, a user, a channel, Start Editing runs to completed", async () => {
  const w = await startWorld();
  try {
    const user = await w.addUser({ name: "alice" });
    const video = await w.addVideo(user);
    w.writesProject(video.projectDir);
    const stream = await user.client.openStream();
    const library = await user.client.rpc("getLibrary");
    assert.equal(library.status, 200);
    assert.ok(JSON.stringify(library.json).includes(video.videoId), "the library lists the video");

    const started = await user.client.rpc("startEdit", { videoId: video.videoId });
    assert.equal(started.status, 200, started.text);
    const jobId = started.json.id;
    await w.waitState(jobId, "completed");

    // The events of the job reach its owner, in order, ending in completed.
    await until(() =>
      stream.messages().some((m) => m.event === "job-updated" && m.payload.state === "completed"),
    );
    const states = stream
      .messages()
      .filter((m) => m.event === "job-updated" && m.payload.id === jobId)
      .map((m) => m.payload.state);
    assert.equal(states.at(-1), "completed");
    assert.ok(states.indexOf("running") < states.indexOf("completed"), states.join(","));

    const log = await user.client.rpc("getJobLog", { jobId });
    assert.equal(log.status, 200, log.text);
    assert.ok(JSON.stringify(log.json).length > 20, "the job log has lines");

    const lines = await user.client.rpc("getEditLog", {});
    assert.equal(lines.status, 200, lines.text);
    const events = JSON.stringify(lines.json);
    assert.match(events, /started/);
    assert.match(events, /completed/);
  } finally {
    await w.close();
  }
});

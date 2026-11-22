// Shutdown with a job running, a second start on the same data directory, and deleting a user
// who has jobs (SPEC sections 4, 8 Recovery).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ADMIN_EMAIL, startWorld, until } from "./world.js";

/**
 * The fake programs of this world that still run (empty when none). Scoped by the world's temp
 * folder (it is in their environment), so tests of other files running at the same time do not count.
 * @param {string} root
 * @returns {string}
 */
function leftovers(root) {
  const all = execFileSync("ps", ["-Eww", "-axo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return all
    .split("\n")
    .filter((line) => line.includes(root) && /fake-claude|fake-hyperframes/.test(line))
    .map((line) => line.slice(0, 120))
    .join("\n");
}

test("stopping the server pauses a running job; the next start shows it paused and Continue finishes it", async () => {
  const first = await startWorld();
  /** @type {Awaited<ReturnType<typeof startWorld>> | null} */
  let second = null;
  try {
    first.scenario("hold");
    const user = await first.addUser({ name: "alice" });
    const video = await first.addVideo(user);
    first.writesProject(video);
    const marks = first.signals(video);
    const started = await user.client.rpc("startEdit", { videoId: video.videoId });
    assert.equal(started.status, 200, started.text);
    const jobId = started.json.id;
    await until(() => marks.started());
    await first.waitState(jobId, "running");

    await first.stopApp();
    const stateAfterStop = () => {
      const db = new DatabaseSync(`${first.root}/data/vidai.db`);
      try {
        return String(db.prepare("SELECT state FROM jobs WHERE id = ?").get(jobId)?.["state"]);
      } finally {
        db.close();
      }
    };
    assert.equal(stateAfterStop(), "paused", "shutdown pauses the running job");
    assert.equal(leftovers(first.root), "", "no fake program is left after shutdown");

    second = await startWorld({ base: first });
    assert.equal(second.stateOf(jobId), "paused", "the next start still shows it paused");
    // Sessions live in the data directory: the user is still signed in with the old cookie.
    const again = second.client();
    again.jar.set("vidai_session", user.client.sessionCookie ?? "");
    const queue = await again.rpc("getQueue");
    assert.equal(queue.status, 200, queue.text);
    marks.release();
    const continued = await again.rpc("continueJob", { jobId });
    assert.equal(continued.status, 200, continued.text);
    await second.waitState(jobId, "completed");
  } finally {
    await second?.close();
    await first.close();
  }
  assert.equal(leftovers(first.root), "", "no fake program is left at the end");
});

test("deleting a user stops their jobs and removes their sessions", async () => {
  const w = await startWorld();
  try {
    w.scenario("hold");
    const user = await w.addUser({ name: "alice" });
    const video = await w.addVideo(user);
    const marks = w.signals(video);
    const stream = await user.client.openStream();
    const started = await user.client.rpc("startEdit", { videoId: video.videoId });
    assert.equal(started.status, 200, started.text);
    const jobId = started.json.id;
    await until(() => marks.started());

    const removed = await w.admin.rpc("adminDeleteUser", { id: user.id });
    assert.equal(removed.status, 200, removed.text);
    await stream.ended;
    assert.ok(stream.messages().some((m) => m.event === "session-ended"));
    assert.equal((await user.client.rpc("getSession")).json.user, null, "the session is gone");
    await until(() => leftovers(w.root) === "");
    const row = w.app.db.get("SELECT state FROM jobs WHERE id = ?", jobId);
    assert.ok(!row || row["state"] === "stopped", `the job of a deleted user: ${row?.["state"]}`);
    assert.equal((await w.admin.rpc("getSession")).json.user.email, ADMIN_EMAIL);
  } finally {
    await w.close();
  }
});

// Disk Cleanup and the System page through the real server (SPEC sections 13, 14).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { startWorld, until } from "./world.js";

test("Disk Cleanup measures a video folder and cleans its working files", async () => {
  const w = await startWorld();
  try {
    const user = await w.addUser({ name: "alice" });
    const video = await w.addVideo(user);
    const working = path.join(video.dir, "CLAUDE_VE");
    fs.mkdirSync(path.join(working, "cache"), { recursive: true });
    fs.writeFileSync(path.join(working, "cache", "scratch.bin"), Buffer.alloc(4096, 1));
    const stream = await user.client.openStream();

    await user.client.rpc("getDiskUse");
    // The measuring runs in the background and tells the page with an event.
    await until(
      () =>
        stream
          .messages()
          .some(
            (m) =>
              m.event === "disk-use-changed" &&
              !m.payload.measuring &&
              m.payload.totals.working >= 4096,
          ),
      20_000,
    );
    const measured = (await user.client.rpc("getDiskUse")).json;
    assert.ok(measured.totals.working >= 4096, JSON.stringify(measured.totals));
    assert.equal(measured.videos[0].videoId, video.videoId);

    const cleaned = await user.client.rpc("cleanWorkingFiles", { videoId: video.videoId });
    assert.equal(cleaned.status, 200, cleaned.text);
    assert.ok(cleaned.json.freedBytes >= 4096);
    assert.deepEqual(fs.readdirSync(working), [], "CLAUDE_VE is emptied, not removed");
    assert.ok(fs.existsSync(path.join(video.dir, "clip.mp4")), "the A-roll stays");
    const lines = (await user.client.rpc("getEditLog", {})).json;
    assert.match(JSON.stringify(lines), /Disk Cleanup freed/);

    // Somebody else's video is not found (an admin may clean it).
    const other = await w.addUser({ name: "bob" });
    const refused = await other.client.rpc("cleanWorkingFiles", { videoId: video.videoId });
    assert.equal(refused.status, 404, refused.text);
  } finally {
    await w.close();
  }
});

test("the System page answers the admin and is forbidden for a user", async () => {
  const w = await startWorld();
  try {
    const user = await w.addUser({ name: "alice" });
    const page = await w.admin.rpc("adminGetSystem");
    assert.equal(page.status, 200, page.text);
    assert.ok(page.json && typeof page.json === "object");
    assert.ok(JSON.stringify(page.json).length > 50, "the page carries the parts of the server");
    const refused = await user.client.rpc("adminGetSystem");
    assert.equal(refused.status, 403);
  } finally {
    await w.close();
  }
});

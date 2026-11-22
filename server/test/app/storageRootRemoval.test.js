// Through the real server: a storage folder that holds channels cannot be taken out of the admin's
// list (SPEC sections 5 and 6), and the default storage folder is always there.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { startWorld } from "./world.js";

test("the admin cannot remove a storage folder with channels in it, until they are gone", async () => {
  const w = await startWorld();
  try {
    fs.mkdirSync(path.join(w.root, "share"));
    const share = fs.realpathSync(path.join(w.root, "share"));
    const alice = await w.addUser({ name: "alice" });
    const set = await w.admin.rpc("adminUpdateSettings", { storageRoots: [share] });
    assert.equal(set.status, 200, set.text);

    const made = await alice.client.rpc("createChannel", {
      name: "Shared",
      videoType: "auto",
      location: { kind: "new", parent: share, folderName: null },
    });
    assert.equal(made.status, 200, made.text);

    const refused = await w.admin.rpc("adminUpdateSettings", { storageRoots: [] });
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.json, {
      code: "conflict",
      message: `1 channel of 1 user is in ${share}. Move or remove it first.`,
    });
    const kept = await w.admin.rpc("adminGetSettings");
    assert.deepEqual(kept.json.storageRoots, [share]);

    // Emptying the list of the default folder is not a thing: it is never in the list.
    const removed = await alice.client.rpc("removeChannel", { id: made.json.id });
    assert.equal(removed.status, 200, removed.text);
    const allowed = await w.admin.rpc("adminUpdateSettings", { storageRoots: [] });
    assert.equal(allowed.status, 200, allowed.text);
    assert.deepEqual(allowed.json.storageRoots, []);
  } finally {
    await w.close();
  }
});

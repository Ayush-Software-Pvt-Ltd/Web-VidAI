// renderFinal (docs/SPEC.md sections 12 and 14): what it refuses and what it queues.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { AppError } from "../../src/errors.js";
import { renderFunctions } from "../../src/rpc/render.js";
import { writeProject } from "../render/helpers.js";
import { createTestApp, rejectsWith } from "./support.js";

const GB = 1024 ** 3;
/** @type {string[]} */
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** @param {{ active?: boolean, notes?: number, project?: boolean, violations?: string[], free?: number | "unreadable", seconds?: number, owner?: boolean }} [o] */
function setup({
  active = false,
  notes = 0,
  project = true,
  violations = [],
  free = 100 * GB,
  seconds = 2,
  owner = true,
} = {}) {
  const app = createTestApp();
  const ann = app.makeUser("ann@example.com");
  const bob = app.makeUser("bob@example.com");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vidai-rpc-render-"));
  dirs.push(root);
  const projectDir = path.join(root, "output", "V.hf");
  if (project) writeProject(projectDir, { seconds });
  /** @type {unknown[]} */
  const queued = [];
  /** @type {unknown[]} */
  const asked = [];
  app.rpc.register(
    renderFunctions({
      library: {
        async videoByWireId(userId, wireId) {
          if (userId !== (owner ? ann.id : bob.id) || wireId !== "c1/V") {
            throw new AppError("notFound", "That video does not exist.");
          }
          return { key: "k".repeat(32), dir: root, folderName: "V" };
        },
        async resolveVideoType() {
          return { videoType: "short" };
        },
      },
      timeline: {
        projectDir: async () => projectDir,
        projectExists: async () => project,
        check: async () => ({ violations }),
        pendingNotes: () => Array.from({ length: notes }, () => ({})),
      },
      activeJob: () => (active ? { id: "j0", kind: "edit" } : null),
      enqueue: (job) => {
        queued.push(job);
        return /** @type {never} */ ({ id: "j1", kind: "render" });
      },
      renderCacheDir: path.join(root, "cache", "render"),
      freeBytes: async (dir) => {
        asked.push(dir);
        if (free === "unreadable") throw new Error("no df");
        return free;
      },
    }),
  );
  return {
    app,
    ann,
    bob,
    queued,
    asked,
    call: (/** @type {unknown} */ input, /** @type {{ id: string } | null} */ user = ann) =>
      app.call("renderFinal", input, app.contextFor(user)),
  };
}

describe("renderFinal", () => {
  it("queues a render job with the resolution and returns the job", async () => {
    const t = setup();
    const view = await t.call({ videoId: "c1/V", resolution: 2160 });
    assert.deepEqual(view, { id: "j1", kind: "render" });
    assert.deepEqual(t.queued, [
      {
        videoKey: "k".repeat(32),
        userId: t.ann.id,
        kind: "render",
        videoType: "short",
        request: { resolution: 2160 },
      },
    ]);
  });

  it("defaults to 1080", async () => {
    const t = setup();
    await t.call({ videoId: "c1/V" });
    assert.deepEqual(/** @type {{ request: unknown }} */ (t.queued[0]).request, {
      resolution: 1080,
    });
  });

  it("refuses a resolution that is not offered and bad input", async () => {
    const t = setup();
    await rejectsWith(t.call({ videoId: "c1/V", resolution: 720 }), "invalidInput");
    await rejectsWith(t.call({ videoId: 5 }), "invalidInput");
    await rejectsWith(t.call({}), "invalidInput");
    assert.deepEqual(t.queued, []);
  });

  it("needs a session", async () => {
    const t = setup();
    await rejectsWith(t.call({ videoId: "c1/V" }, null), "unauthenticated");
  });

  it("does not show another user's video", async () => {
    const t = setup({ owner: false });
    await rejectsWith(t.call({ videoId: "c1/V" }), "notFound");
    assert.deepEqual(t.queued, []);
  });

  it("refuses while the video has an active job", async () => {
    const t = setup({ active: true });
    await rejectsWith(
      t.call({ videoId: "c1/V" }),
      "conflict",
      /already has a job running or waiting/u,
    );
    assert.deepEqual(t.queued, []);
  });

  it("refuses while change requests are pending", async () => {
    const t = setup({ notes: 2 });
    await rejectsWith(
      t.call({ videoId: "c1/V" }),
      "conflict",
      /change requests that are not applied/u,
    );
  });

  it("refuses a video without a project", async () => {
    const t = setup({ project: false });
    await rejectsWith(t.call({ videoId: "c1/V" }), "notReady", /no project yet/u);
  });

  it("names the first errors of a failing project check", async () => {
    const t = setup({
      violations: ["Error one.", "Error two.", "Error three.", "Error four.", "Error five."],
    });
    await rejectsWith(
      t.call({ videoId: "c1/V" }),
      "invalidInput",
      /errors, so it cannot be rendered: Error one\. Error two\. Error three\. \(and 2 more\)$/u,
    );
    const few = setup({ violations: ["Only one."] });
    await rejectsWith(few.call({ videoId: "c1/V" }), "invalidInput", /: Only one\.$/u);
    assert.deepEqual(t.queued, []);
  });

  it("refuses too little disk and names both numbers, asking the disk of cache/render", async () => {
    const t = setup({ free: 3 * GB, seconds: 600 });
    await rejectsWith(
      t.call({ videoId: "c1/V" }),
      "conflict",
      /needs 15\.0 GB \(1 GB for each minute of its 10:00 plus 5 GB\) and only 3\.0 GB are free/u,
    );
    assert.match(String(t.asked[0]), /cache[\\/]render$/u);
    assert.deepEqual(t.queued, []);
  });

  it("queues when the free space cannot be read (the runner checks again)", async () => {
    const t = setup({ free: "unreadable" });
    await t.call({ videoId: "c1/V" });
    assert.equal(t.queued.length, 1);
  });

  it("explains a project whose root cannot be read", async () => {
    const t = setup({ project: false });
    // The project folder exists for the timeline's sake but has no usable index.html.
    const t2 = setup();
    fs.writeFileSync(
      path.join(/** @type {string} */ (dirs.at(-1)), "output", "V.hf", "index.html"),
      "<html></html>",
    );
    await rejectsWith(t2.call({ videoId: "c1/V" }), "invalidInput", /no root composition/u);
    assert.equal(t.queued.length, 0);
  });
});

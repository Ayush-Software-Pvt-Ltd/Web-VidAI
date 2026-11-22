/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index into seeded lists they just checked */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobView, Library, VideoView } from "../types";
import { adminQueue, adminSetJobUrgent, adminStartJobNow } from "./areas/queue";
import { MockBackend } from "./backend";
import type { ScenarioName } from "./scenarios";
import type { World } from "./world";

const backends: MockBackend[] = [];
function make(
  scenarios: ScenarioName[] = ["default"],
  as: "admin" | "user" = "admin",
  world?: World,
): MockBackend {
  const backend = new MockBackend({
    scenarios,
    latencyMs: 0,
    autoTick: false,
    as,
    ...(world ? { world } : {}),
  });
  backends.push(backend);
  return backend;
}
afterEach(() => {
  vi.useRealTimers();
  for (const backend of backends.splice(0)) backend.dispose();
});

async function video(backend: MockBackend, prefix: string): Promise<VideoView> {
  const library = await backend.getLibrary();
  const found = library.channels
    .flatMap((c) => c.videos)
    .find((v) => v.folderName.startsWith(prefix));
  if (!found) throw new Error(`No video ${prefix}`);
  return found;
}

async function jobOf(backend: MockBackend, prefix: string): Promise<JobView> {
  const job = (await video(backend, prefix)).job;
  if (!job) throw new Error(`No job on ${prefix}`);
  return job;
}

/** Ticks until the job of the video leaves `running`/`pausing`/`stopping` (at most 100 ticks). */
async function finish(backend: MockBackend, prefix: string): Promise<JobView> {
  for (let n = 0; n < 100; n += 1) {
    const job = await jobOf(backend, prefix);
    if (!["running", "pausing", "stopping"].includes(job.state)) return job;
    backend.tick();
  }
  throw new Error("The job did not finish");
}

describe("channels", () => {
  it("updates, orders, exports and imports the owner's own channels", async () => {
    const backend = make();
    const [first] = (await backend.getWorkspace()).channels;
    const updated = await backend.updateChannel({
      id: first!.id,
      update: { videoType: "short", long: null, short: null },
    });
    expect(updated).toMatchObject({ id: first!.id, name: first!.name, videoType: "short" });
    expect(updated.long.prompts).toHaveLength(5);

    const before = (await backend.getWorkspace()).channels.map((c) => c.id);
    const reordered = await backend.reorderChannels({ ids: [...before].reverse() });
    expect(reordered.map((c) => c.id)).toEqual([...before].reverse());

    const document = await backend.exportChannels();
    expect(document).toMatchObject({ format: "vidai-channels", version: 1 });
    expect(document.channels).toHaveLength(2);
    const result = await backend.importChannels({
      document: {
        ...document,
        channels: [
          ...document.channels,
          { ...document.channels[0]!, name: "Brand New" },
          { ...document.channels[0]!, name: "Another One" },
        ],
      },
    });
    // Import never makes a channel: the names that match none come back as skipped.
    expect(result).toEqual({ updated: 2, skipped: ["Brand New", "Another One"] });
    expect((await backend.getWorkspace()).channels).toHaveLength(2);
    expect(await backend.getDefaultPrompt()).toMatch(/\w/);
  });

  it("has no function to make, rename or remove a channel for a user", () => {
    const backend = make();
    for (const name of ["createChannel", "removeChannel", "createVideo"]) {
      expect(name in backend).toBe(false);
    }
  });

  it("refuses with the server's codes", async () => {
    const backend = make();
    const [first] = (await backend.getWorkspace()).channels;
    await expect(backend.reorderChannels({ ids: [first!.id] })).rejects.toMatchObject({
      code: "invalidInput",
    });
    await expect(
      backend.importChannels({ document: { format: "nope" } as never }),
    ).rejects.toMatchObject({ code: "invalidInput" });
    await expect(
      backend.updateChannel({
        id: first!.id,
        update: {
          videoType: null,
          long: { prompts: [], styles: [] },
          short: null,
        },
      }),
    ).rejects.toMatchObject({ code: "invalidInput" });
  });

  it("keeps users apart: another user's channel, video and job do not exist", async () => {
    const admin = make();
    const user = make(["default"], "user", admin.world);
    const adminVideo = await video(admin, "Hair Oil");
    const job = await admin.startEdit({ videoId: adminVideo.id, urgent: false });
    const notFound = { code: "notFound" };
    await expect(
      user.updateChannel({
        id: adminVideo.channelId,
        update: { videoType: "long", long: null, short: null },
      }),
    ).rejects.toMatchObject(notFound);
    await expect(user.startEdit({ videoId: adminVideo.id, urgent: false })).rejects.toMatchObject(
      notFound,
    );
    await expect(user.archiveVideo({ videoId: adminVideo.id })).rejects.toMatchObject(notFound);
    await expect(user.getVideoInputs({ videoId: adminVideo.id })).rejects.toMatchObject(notFound);
    await expect(user.getJobLog({ jobId: job.id, after: null })).rejects.toMatchObject(notFound);
    await expect(user.pauseJob({ jobId: job.id })).rejects.toMatchObject(notFound);
    expect((await user.getQueue()).jobs).toEqual([]);
    expect(
      (await user.getLibrary()).channels.flatMap((c) => c.videos.map((v) => v.job)),
    ).not.toContain(expect.objectContaining({ id: job.id }));
  });
});

describe("library", () => {
  it("never lists a channel's upload folder as a video", async () => {
    const backend = make();
    const [row] = backend.world.videos;
    for (const folderName of ["upload", "Upload"]) {
      backend.world.videos.push({ ...row!, folderName, archivedAt: null });
    }
    const names = (await backend.getLibrary()).channels.flatMap((c) =>
      c.videos.map((v) => v.folderName),
    );
    expect(names.length).toBeGreaterThan(0);
    expect(names.map((name) => name.toLowerCase())).not.toContain("upload");
  });

  it("sets the type override and the inputs", async () => {
    const backend = make();
    const row = await video(backend, "Hair Oil");
    const view = await backend.setVideoTypeOverride({ videoId: row.id, videoType: "short" });
    expect(view).toMatchObject({ videoType: "short", typeSource: "override" });
    expect(
      (await backend.setVideoTypeOverride({ videoId: row.id, videoType: null })).typeSource,
    ).toBe("detected");
    const inputs = {
      productLinks: "https://example.com/a",
      notes: "n",
      promptSlot: 1,
      styleSlot: 2,
    };
    expect(await backend.setVideoInputs({ videoId: row.id, inputs })).toEqual(inputs);
    expect(await backend.getVideoInputs({ videoId: row.id })).toEqual(inputs);
    await expect(
      backend.setVideoInputs({ videoId: row.id, inputs: { ...inputs, promptSlot: 9 } }),
    ).rejects.toMatchObject({ code: "invalidInput" });
  });

  it("archives and unarchives, and refuses while a job is active", async () => {
    const backend = make();
    const row = await video(backend, "Serum Launch");
    await backend.archiveVideo({ videoId: row.id });
    expect((await backend.getArchived()).map((a) => a.folderName)).toContain("Serum Launch");
    expect(await video(backend, "Serum Launch").catch(() => null)).toBeNull();
    await backend.unarchiveVideo({ videoId: row.id });
    expect((await video(backend, "Serum Launch")).folderName).toBe("Serum Launch");
    await expect(backend.unarchiveVideo({ videoId: row.id })).rejects.toMatchObject({
      code: "conflict",
    });
    const fresh = await video(backend, "Hair Oil");
    await backend.startEdit({ videoId: fresh.id, urgent: false });
    await expect(backend.archiveVideo({ videoId: fresh.id })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("sends library-changed with the full library to the owner only", async () => {
    const admin = make();
    const user = make(["default"], "user", admin.world);
    const adminSeen = vi.fn<(library: Library | null) => void>();
    const userSeen = vi.fn();
    admin.on.libraryChanged(adminSeen);
    user.on.libraryChanged(userSeen);
    const row = await video(admin, "Hair Oil");
    await admin.setVideoTypeOverride({ videoId: row.id, videoType: "short" });
    expect(adminSeen).toHaveBeenCalledTimes(1);
    expect(adminSeen.mock.calls[0]![0]?.channels.length).toBe(2);
    expect(userSeen).not.toHaveBeenCalled();
  });
});

describe("jobs", () => {
  it("runs an edit to the end: log, progress, cost, project, then Re-Edit and Render Final", async () => {
    const backend = make();
    const row = await video(backend, "Hair Oil");
    const started = await backend.startEdit({ videoId: row.id, urgent: false });
    expect(started).toMatchObject({ kind: "edit", queue: "edits", state: "running" });
    backend.tick();
    backend.tick();
    const mid = await jobOf(backend, "Hair Oil");
    expect(mid.progress?.percent).toBeGreaterThan(0);
    expect(mid.costUsd).toBeGreaterThan(0);
    const log = await backend.getJobLog({ jobId: mid.id, after: null });
    expect(log.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect((await backend.getJobLog({ jobId: mid.id, after: 1 })).entries).toHaveLength(1);

    const done = await finish(backend, "Hair Oil");
    expect(done).toMatchObject({ state: "completed", progress: { percent: 100 } });
    const after = await video(backend, "Hair Oil");
    expect(after.edited).toBe(true);
    expect(after.output.project).not.toBeNull();
    expect(after.actions).toEqual(expect.arrayContaining(["reEdit", "renderFinal", "review"]));

    await expect(
      backend.reEdit({ videoId: row.id, text: "  ", urgent: false }),
    ).rejects.toMatchObject({
      code: "invalidInput",
    });
    await expect(
      backend.reEdit({ videoId: row.id, text: "x".repeat(8001), urgent: false }),
    ).rejects.toMatchObject({ code: "invalidInput" });
    const again = await backend.reEdit({ videoId: row.id, text: "Shorter intro", urgent: false });
    expect(again.kind).toBe("reEdit");
    expect((await finish(backend, "Hair Oil")).state).toBe("completed");

    const render = await backend.renderFinal({ videoId: row.id, resolution: 2160 });
    expect(render).toMatchObject({ kind: "render", queue: "renders" });
    await finish(backend, "Hair Oil");
    const final = await video(backend, "Hair Oil");
    expect(final.finalRendered).toBe(true);
    expect(final.output.finals.map((f) => f.name)).toEqual(["Hair Oil Review_final_v1.mp4"]);
  });

  it("refuses starts with the manager's codes", async () => {
    const backend = make();
    const none = await video(backend, "Draft Without");
    await expect(backend.startEdit({ videoId: none.id, urgent: false })).rejects.toMatchObject({
      code: "invalidInput",
    });
    const edited = await video(backend, "Serum Launch");
    await expect(backend.startEdit({ videoId: edited.id, urgent: false })).rejects.toMatchObject({
      code: "conflict",
    });
    const fresh = await video(backend, "Hair Oil");
    await expect(
      backend.reEdit({ videoId: fresh.id, text: "change", urgent: false }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      backend.renderFinal({ videoId: fresh.id, resolution: 1080 }),
    ).rejects.toMatchObject({
      code: "notReady",
    });
    await backend.startEdit({ videoId: fresh.id, urgent: false });
    await expect(backend.startEdit({ videoId: fresh.id, urgent: false })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(backend.getJobLog({ jobId: "nope", after: null })).rejects.toMatchObject({
      code: "notFound",
    });
    backend.world.readinessUser = { problem: "claudeMissing", message: "Claude Code is missing." };
    const other = await video(backend, "Night Cream");
    await expect(backend.startEdit({ videoId: other.id, urgent: false })).rejects.toMatchObject({
      code: "notReady",
    });
  });

  it("refuses an empty prompt and Urgent from a user who may not", async () => {
    const backend = make();
    const row = await video(backend, "Night Cream");
    const channel = backend.world.channels.find((c) => c.id === row.channelId)!;
    channel.long.prompts[0]!.text = "  ";
    await expect(backend.startEdit({ videoId: row.id, urgent: false })).rejects.toMatchObject({
      code: "invalidInput",
    });
    const user = make(["default"], "user", backend.world);
    const own = await video(user, "Lisbon");
    await expect(user.startEdit({ videoId: own.id, urgent: true })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("pauses, continues and stops from every state", async () => {
    const backend = make();
    const row = await video(backend, "Hair Oil");
    const job = await backend.startEdit({ videoId: row.id, urgent: false });
    backend.tick();
    backend.tick();
    expect((await backend.pauseJob({ jobId: job.id })).state).toBe("pausing");
    await expect(backend.pauseJob({ jobId: job.id })).rejects.toMatchObject({ code: "conflict" });
    backend.tick();
    const paused = await jobOf(backend, "Hair Oil");
    expect(paused.state).toBe("paused");
    expect(paused.activeMs).toBeGreaterThanOrEqual(0);
    const stepsBefore = (await backend.getJobLog({ jobId: job.id, after: null })).entries.length;

    const continued = await backend.continueJob({ jobId: job.id });
    expect(continued.state).toBe("running");
    backend.tick();
    expect((await backend.getJobLog({ jobId: job.id, after: null })).entries.length).toBe(
      stepsBefore + 1,
    );

    expect((await backend.stopJob({ jobId: job.id })).state).toBe("stopping");
    expect((await backend.stopJob({ jobId: job.id })).state).toBe("stopping");
    backend.tick();
    expect((await jobOf(backend, "Hair Oil")).state).toBe("stopped");
    await expect(backend.stopJob({ jobId: job.id })).rejects.toMatchObject({ code: "conflict" });
    await expect(backend.continueJob({ jobId: job.id })).rejects.toMatchObject({
      code: "conflict",
    });

    // A paused job stops at once; a waiting one too.
    const second = await backend.startEdit({ videoId: row.id, urgent: false });
    await backend.pauseJob({ jobId: second.id });
    backend.tick();
    expect((await backend.stopJob({ jobId: second.id })).state).toBe("stopped");
  });

  it("does not pause a render and fails with the scenario's sentence, then continues", async () => {
    const backend = make();
    const row = await video(backend, "Serum Launch");
    const render = await backend.renderFinal({ videoId: row.id, resolution: 1080 });
    await expect(backend.pauseJob({ jobId: render.id })).rejects.toMatchObject({
      code: "conflict",
    });
    await backend.stopJob({ jobId: render.id });
    backend.tick();

    backend.world.failJobsWith = "The editing program ran out of credit.";
    const fresh = await video(backend, "Hair Oil");
    await backend.startEdit({ videoId: fresh.id, urgent: false });
    const failed = await finish(backend, "Hair Oil");
    expect(failed).toMatchObject({
      state: "failed",
      error: "The editing program ran out of credit.",
    });
    expect((await video(backend, "Hair Oil")).actions).toEqual(
      expect.arrayContaining(["continue", "startEdit"]),
    );
    const resumed = await backend.continueJob({ jobId: failed.id });
    expect(resumed).toMatchObject({ state: "running", error: null });
    expect((await finish(backend, "Hair Oil")).state).toBe("completed");
  });

  it("keeps the three queues apart", async () => {
    const backend = make();
    backend.world.adminSettings.startDelayMinutes = 0;
    backend.world.adminSettings.maxRenders = 1;
    const a = await video(backend, "Serum Launch");
    const b = await video(backend, "Lip Balm");
    const r1 = await backend.renderFinal({ videoId: a.id, resolution: 1080 });
    const r2 = await backend.renderFinal({ videoId: b.id, resolution: 1080 });
    expect(r1.state).toBe("running");
    expect(r2).toMatchObject({ state: "queued", position: 1 });
    const edit = await backend.startEdit({
      videoId: (await video(backend, "Hair Oil")).id,
      urgent: false,
    });
    expect(edit.state).toBe("running");
    const queue = await backend.getQueue();
    expect(queue.queues.find((q) => q.queue === "renders")).toMatchObject({
      running: 1,
      waiting: 1,
    });
    expect(queue.queues.find((q) => q.queue === "edits")).toMatchObject({ running: 1, waiting: 0 });
  });

  it("holds an edit back by the start delay until it passes or an admin says now", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    const backend = make();
    backend.world.adminSettings.maxEditsPerUser = 0;
    const first = await video(backend, "Hair Oil");
    const second = await video(backend, "Night Cream");
    const third = await video(backend, "Phone Camera");
    await backend.startEdit({ videoId: first.id, urgent: false });
    const held = await backend.startEdit({ videoId: second.id, urgent: false });
    expect(held.state).toBe("queued");
    expect(held.startsAt).toBe(Date.now() + 10 * backend.ctx.clock.minuteMs);
    expect(held.lastActivity).toBe("Waiting for the start delay");
    expect((await video(backend, "Night Cream")).actions).toContain("startNow");

    adminStartJobNow(backend.ctx, held.id);
    expect((await jobOf(backend, "Night Cream")).state).toBe("running");
    expect(() => adminStartJobNow(backend.ctx, held.id)).toThrow(/not waiting/);

    // The delay also opens by itself.
    const next = await backend.startEdit({ videoId: third.id, urgent: false });
    expect(next.state).toBe("queued");
    vi.setSystemTime(Date.now() + 11 * backend.ctx.clock.minuteMs);
    backend.tick();
    expect((await jobOf(backend, "Phone Camera")).state).toBe("running");
  });

  it("applies the per-user limit but lets other users go first", async () => {
    const backend = make(["default"]);
    backend.world.adminSettings.startDelayMinutes = 0;
    backend.world.adminSettings.maxEdits = 3;
    backend.world.adminSettings.maxEditsPerUser = 2;
    const ids: string[] = [];
    for (const prefix of ["Hair Oil", "Night Cream", "Phone Camera"]) {
      ids.push((await video(backend, prefix)).id);
    }
    const states: string[] = [];
    for (const videoId of ids)
      states.push((await backend.startEdit({ videoId, urgent: false })).state);
    expect(states).toEqual(["running", "running", "queued"]);
    const user = make(["default"], "user", backend.world);
    const own = await user.startEdit({ videoId: (await video(user, "Lisbon")).id, urgent: false });
    expect(own.state).toBe("running");
    const waiting = (await backend.getQueue()).jobs.find((e) => e.job.state === "queued");
    expect(waiting?.job.position).toBe(1);
    expect(waiting?.ahead).toBe(0);
  });

  it("orders the line Urgent first and lets an admin change it", () => {
    const backend = make(["urgent"]);
    const view = adminQueue(backend.ctx);
    const plain = view.jobs.find((j) => j.folderName === "Desk Lamp Review")!;
    expect(view.jobs.find((j) => j.state === "queued")?.folderName).toBe("Webcam Comparison");
    adminSetJobUrgent(backend.ctx, plain.jobId, true);
    const next = adminQueue(backend.ctx).jobs.filter((j) => j.state === "queued");
    expect(next.map((j) => j.folderName)).toEqual([
      "Desk Lamp Review",
      "Webcam Comparison",
      "Porto Food Tour",
    ]);
    expect(() => adminSetJobUrgent(backend.ctx, "nope", true)).toThrow(/does not exist/);
    const running = view.jobs.find((j) => j.state === "running")!;
    expect(() => adminSetJobUrgent(backend.ctx, running.jobId, true)).toThrow(
      /waiting in the line/,
    );
  });

  it("sends job events to the owner and admins, and queue events to everybody", async () => {
    const admin = make();
    const user = make(["default"], "user", admin.world);
    const other = make(["default"], "user", admin.world);
    const adminJobs = vi.fn();
    const userJobs = vi.fn();
    const userQueue = vi.fn();
    const adminLog = vi.fn();
    const userLog = vi.fn();
    admin.on.jobUpdated(adminJobs);
    user.on.jobUpdated(userJobs);
    user.on.queueChanged(userQueue);
    admin.on.jobLog(adminLog);
    user.on.jobLog(userLog);
    // Both "user" browsers are the same account; a job of the admin goes to neither.
    await admin.startEdit({ videoId: (await video(admin, "Hair Oil")).id, urgent: false });
    admin.tick();
    expect(adminJobs).toHaveBeenCalled();
    expect(adminLog).toHaveBeenCalledTimes(1);
    expect(userJobs).not.toHaveBeenCalled();
    expect(userLog).not.toHaveBeenCalled();
    expect(userQueue).toHaveBeenCalledWith({ queue: "edits" });

    // A user's job reaches the user and the admin.
    adminJobs.mockClear();
    await user.startEdit({ videoId: (await video(user, "Lisbon")).id, urgent: false });
    expect(userJobs).toHaveBeenCalled();
    expect(adminJobs).toHaveBeenCalled();
    expect(other).toBeDefined();
  });
});

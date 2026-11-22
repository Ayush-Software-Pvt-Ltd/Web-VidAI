/**
 * A channel whose folder cannot be reached (an unplugged drive): everything that needs the folder
 * answers `conflict` with the sentence of the server's `folders.channelDir`
 * (`server/src/storage/videoFolder.js`); what does not need it still works.
 */
import { describe, expect, it } from "vitest";
import { makeVideoId } from "../../videoId";
import type { JobView } from "../../types";
import { MockBackend } from "../backend";
import { CHANNEL_UNREACHABLE } from "../rules";
import { ADMIN_CHANNEL_BEAUTY, ADMIN_CHANNEL_TECH } from "../seed/workspace";

const options = { latencyMs: 0, autoTick: false } as const;
const LOST = makeVideoId(ADMIN_CHANNEL_TECH, "Phone Camera Test");
const REFUSED = { code: "conflict", message: CHANNEL_UNREACHABLE };

function lostBackend(): MockBackend {
  return new MockBackend({ ...options, scenarios: ["unreachable-channel"] });
}

/** A default backend after its Beauty channel lost its folder. */
function loseBeauty(backend: MockBackend): void {
  const channel = backend.world.channels.find((c) => c.id === ADMIN_CHANNEL_BEAUTY);
  if (!channel) throw new Error("Expected the Beauty channel.");
  channel.available = false;
}

describe("mock: operations that need the folder of an unreachable channel", () => {
  it("says the sentence of the server", () => {
    expect(CHANNEL_UNREACHABLE).toBe("This channel's folder cannot be reached right now.");
  });

  const calls: Array<[string, (backend: MockBackend) => Promise<unknown>]> = [
    ["getVideoInputs", (b: MockBackend) => b.getVideoInputs({ videoId: LOST })],
    [
      "setVideoInputs",
      async (b: MockBackend) => {
        const inputs = await b.getVideoInputs({ videoId: LOST }).catch(() => null);
        return b.setVideoInputs({
          videoId: LOST,
          inputs: inputs ?? { promptSlot: 0, styleSlot: 0, productLinks: "", notes: "" },
        });
      },
    ],
    [
      "setVideoTypeOverride",
      (b: MockBackend) => b.setVideoTypeOverride({ videoId: LOST, videoType: "short" }),
    ],
    ["archiveVideo", (b: MockBackend) => b.archiveVideo({ videoId: LOST })],
    ["startEdit", (b: MockBackend) => b.startEdit({ videoId: LOST, urgent: false })],
    ["reEdit", (b: MockBackend) => b.reEdit({ videoId: LOST, text: "Cut it", urgent: false })],
    [
      "renderFinal",
      (b: MockBackend) => b.renderFinal({ videoId: LOST, resolution: "1080p" as never }),
    ],
    ["cleanWorkingFiles", (b: MockBackend) => b.cleanWorkingFiles({ videoId: LOST })],
    [
      "createUpload into the video",
      (b: MockBackend) =>
        b.createUpload({ target: { kind: "video", videoId: LOST }, name: "clip.mp4", size: 1000 }),
    ],
    [
      "createUpload into the channel",
      (b: MockBackend) =>
        b.createUpload({
          target: { kind: "channel", channelId: ADMIN_CHANNEL_TECH },
          name: "clip.mp4",
          size: 1000,
        }),
    ],
    [
      "listUploads of the video",
      (b: MockBackend) => b.listUploads({ target: { kind: "video", videoId: LOST } }),
    ],
    [
      "listUploads of the channel",
      (b: MockBackend) =>
        b.listUploads({ target: { kind: "channel", channelId: ADMIN_CHANNEL_TECH } }),
    ],
    ["openTimeline", (b: MockBackend) => b.openTimeline({ videoId: LOST })],
    ["getTimeline", (b: MockBackend) => b.getTimeline({ videoId: LOST })],
    [
      "editTimeline",
      (b: MockBackend) =>
        b.editTimeline({
          videoId: LOST,
          revision: 1,
          op: { type: "delete", clipId: "clip" },
        }),
    ],
    ["undoTimeline", (b: MockBackend) => b.undoTimeline({ videoId: LOST })],
    ["redoTimeline", (b: MockBackend) => b.redoTimeline({ videoId: LOST })],
    ["listRevisions", (b: MockBackend) => b.listRevisions({ videoId: LOST })],
    ["restoreRevision", (b: MockBackend) => b.restoreRevision({ videoId: LOST, n: 1 })],
    [
      "addTimelineNote",
      (b: MockBackend) =>
        b.addTimelineNote({
          videoId: LOST,
          frame: 0,
          shape: null,
          elementId: null,
          prompt: "Tighter",
        }),
    ],
    [
      "deleteTimelineNote",
      (b: MockBackend) => b.deleteTimelineNote({ videoId: LOST, noteId: "n" }),
    ],
    ["retryTimelineNote", (b: MockBackend) => b.retryTimelineNote({ videoId: LOST, noteId: "n" })],
  ];

  it.each(calls)("%s is refused with conflict", async (_name, call) => {
    const backend = lostBackend();
    await expect(Promise.resolve().then(() => call(backend))).rejects.toMatchObject(REFUSED);
    backend.dispose();
  });

  it("refuses a video of a reachable channel only for its own reasons", async () => {
    const backend = lostBackend();
    const beauty = makeVideoId(ADMIN_CHANNEL_BEAUTY, "Night Cream");
    await expect(backend.getVideoInputs({ videoId: beauty })).resolves.toBeDefined();
    await expect(
      backend.createUpload({
        target: { kind: "channel", channelId: ADMIN_CHANNEL_BEAUTY },
        name: "fresh.zip",
        size: 10,
      }),
    ).resolves.toMatchObject({ name: "fresh.zip" });
    backend.dispose();
  });

  it("answers notFound, not conflict, for a video that does not exist", async () => {
    const backend = lostBackend();
    const missing = makeVideoId(ADMIN_CHANNEL_TECH, "No Such Video");
    await expect(backend.getVideoInputs({ videoId: missing })).rejects.toMatchObject({
      code: "notFound",
    });
    backend.dispose();
  });

  it("lists the channel without videos and its archived videos nowhere", async () => {
    const backend = lostBackend();
    const lost = (await backend.getLibrary()).channels.find(
      (c) => c.channelId === ADMIN_CHANNEL_TECH,
    );
    expect(lost).toMatchObject({ available: false, videos: [] });
    backend.dispose();

    const archived = new MockBackend({ ...options });
    const before = (await archived.getArchived()).map((a) => a.videoId);
    expect(before.length).toBeGreaterThan(0);
    loseBeauty(archived);
    expect(await archived.getArchived()).toEqual([]);
    archived.dispose();
  });

  it("does not refuse Unarchive, which only flips the row", async () => {
    const backend = new MockBackend({ ...options });
    const [first] = await backend.getArchived();
    if (!first) throw new Error("Expected an archived video.");
    loseBeauty(backend);
    await expect(backend.unarchiveVideo({ videoId: first.videoId })).resolves.toBeNull();
    backend.dispose();
  });

  it("does not refuse Stop, Pause, Continue or the log of a job in the channel", async () => {
    const backend = new MockBackend({ ...options, scenarios: ["busy"] });
    const running = backend.world.jobs.find((j) => j.view.state === "running");
    if (!running) throw new Error("Expected a running job.");
    const channelId = running.view.videoId.slice(0, running.view.videoId.indexOf("/"));
    const channel = backend.world.channels.find((c) => c.id === channelId);
    if (!channel) throw new Error("Expected the channel of the job.");
    channel.available = false;
    const id = running.view.id;
    await expect(backend.getJobLog({ jobId: id, after: null })).resolves.toBeDefined();
    if (running.view.kind !== "render") {
      await expect(backend.pauseJob({ jobId: id })).resolves.toMatchObject({ state: "pausing" });
    }
    await expect(backend.stopJob({ jobId: id })).resolves.toBeDefined();
    backend.dispose();
  });

  it("refuses the state and the chunks of an upload that began before the folder was lost", async () => {
    const backend = new MockBackend({ ...options });
    const videoId = makeVideoId(ADMIN_CHANNEL_BEAUTY, "Night Cream");
    const ticket = await backend.createUpload({
      target: { kind: "video", videoId },
      name: "clip.mp4",
      size: 1000,
    });
    loseBeauty(backend);
    await expect(backend.uploads.state(ticket.id)).rejects.toMatchObject(REFUSED);
    await expect(backend.uploads.send(ticket, new Blob(["x"]))).rejects.toMatchObject(REFUSED);
    // Cancel never needs the folder: the server drops the row either way.
    await expect(backend.cancelUpload({ id: ticket.id })).resolves.toBeNull();
    backend.dispose();
  });
});

describe("mock: Render Final refuses in the order of the server", () => {
  const SERUM = makeVideoId(ADMIN_CHANNEL_BEAUTY, "Serum Launch");
  const FRESH = makeVideoId(ADMIN_CHANNEL_BEAUTY, "Hair Oil Review");

  it("answers notReady for a render that is not ready before it looks at the video", async () => {
    const backend = lostBackend();
    backend.world.system.prepare.renderReady = false;
    const notReady = {
      code: "notReady",
      message:
        "Rendering is not ready on this server yet: Prepare on the System page has not finished fetching the render browser and testing it. Ask an admin.",
    };
    await expect(backend.renderFinal({ videoId: LOST, resolution: 1080 })).rejects.toMatchObject(
      notReady,
    );
    await expect(
      backend.renderFinal({ videoId: makeVideoId(ADMIN_CHANNEL_TECH, "Nope"), resolution: 1080 }),
    ).rejects.toMatchObject(notReady);
    backend.dispose();
  });

  it("then answers notFound, unreachable, busy, no project, in the server's order", async () => {
    const backend = lostBackend();
    await expect(
      backend.renderFinal({ videoId: makeVideoId(ADMIN_CHANNEL_TECH, "Nope"), resolution: 1080 }),
    ).rejects.toMatchObject({ code: "notFound" });
    await expect(backend.renderFinal({ videoId: LOST, resolution: 1080 })).rejects.toMatchObject(
      REFUSED,
    );
    await expect(backend.renderFinal({ videoId: FRESH, resolution: 1080 })).rejects.toMatchObject({
      code: "notReady",
      message: "This video has no project yet. Start an edit first.",
    });
    await backend.renderFinal({ videoId: SERUM, resolution: 1080 });
    await expect(backend.renderFinal({ videoId: SERUM, resolution: 1080 })).rejects.toMatchObject({
      code: "conflict",
      message:
        "This video already has a job running or waiting. Wait for it to finish, or stop it, before rendering.",
    });
    backend.dispose();
  });

  it("does not need an agent program to be ready", async () => {
    const backend = new MockBackend({ ...options, scenarios: ["not-ready"] });
    await expect(backend.renderFinal({ videoId: SERUM, resolution: 1080 })).resolves.toMatchObject({
      kind: "render",
    });
    backend.dispose();
  });
});

describe("mock: a waiting job whose channel becomes unreachable before it starts", () => {
  const SERUM = makeVideoId(ADMIN_CHANNEL_BEAUTY, "Serum Launch");
  const LIP_BALM = makeVideoId(ADMIN_CHANNEL_BEAUTY, "Lip Balm Haul");
  const LAPTOP = makeVideoId(ADMIN_CHANNEL_TECH, "Laptop Teardown");

  it("fails at launch, writes the edit log lines and starts the next waiting job", async () => {
    const backend = new MockBackend({ ...options });
    backend.world.adminSettings.maxRenders = 1;
    const first = await backend.renderFinal({ videoId: SERUM, resolution: 1080 });
    const second = await backend.renderFinal({ videoId: LIP_BALM, resolution: 1080 });
    const third = await backend.renderFinal({ videoId: LAPTOP, resolution: 1080 });
    expect([first.state, second.state, third.state]).toEqual(["running", "queued", "queued"]);

    loseBeauty(backend);
    const updates: JobView[] = [];
    backend.on.jobUpdated((job) => updates.push(job));
    await backend.stopJob({ jobId: first.id });
    backend.tick();

    const jobs = (await backend.getLibrary()).channels.flatMap((c) => c.videos).map((v) => v.job);
    expect(jobs.find((j) => j?.id === third.id)).toMatchObject({ state: "running" });
    expect(updates.filter((j) => j.id === second.id).map((j) => j.state)).toEqual([
      "running",
      "failed",
    ]);
    const failed = backend.world.jobs.find((j) => j.view.id === second.id)?.view;
    expect(failed).toMatchObject({
      state: "failed",
      error: CHANNEL_UNREACHABLE,
      activeMs: 0,
      runningSince: null,
    });
    expect(failed?.startedAt).not.toBeNull();
    expect(failed?.endedAt).not.toBeNull();
    expect(backend.world.jobLogs[second.id] ?? []).toEqual([]);

    const lines = (await backend.getEditLog()).entries
      .filter((e) => e.videoLabel.endsWith("Lip Balm Haul"))
      .map((e) => e.message)
      .reverse();
    expect(lines).toEqual(["Render started", `Needs attention: ${CHANNEL_UNREACHABLE}`]);
    backend.dispose();
  });

  it("fails an edit the same way, with the name of its program", async () => {
    const backend = new MockBackend({ ...options });
    backend.world.adminSettings.startDelayMinutes = 0;
    backend.world.adminSettings.maxEditsPerUser = 1;
    const channel = backend.world.channels.find((c) => c.id === ADMIN_CHANNEL_BEAUTY);
    if (!channel) throw new Error("Expected the Beauty channel.");
    const edit = await backend.reEdit({ videoId: SERUM, text: "Cut it", urgent: false });
    const waiting = await backend.reEdit({ videoId: LIP_BALM, text: "Cut it", urgent: false });
    expect(waiting.state).toBe("queued");
    channel.available = false;
    await backend.stopJob({ jobId: edit.id });
    backend.tick();
    const job = backend.world.jobs.find((j) => j.view.id === waiting.id)?.view;
    expect(job).toMatchObject({ state: "failed", error: CHANNEL_UNREACHABLE });
    const lines = (await backend.getEditLog()).entries
      .filter((e) => e.videoLabel.endsWith("Lip Balm Haul"))
      .map((e) => e.message)
      .reverse();
    expect(lines[0]).toMatch(/^Re-Edit started \((Claude Code|OpenCode 2)\)$/);
    expect(lines[1]).toBe(`Needs attention: ${CHANNEL_UNREACHABLE}`);
    backend.dispose();
  });
});

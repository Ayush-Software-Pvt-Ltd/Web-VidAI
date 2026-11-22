import { afterEach, describe, expect, it } from "vitest";
import { adminQueue } from "./areas/queue";
import { MockBackend } from "./backend";
import { SCENARIO_NAMES, SCENARIOS, type ScenarioName } from "./scenarios";

const backends: MockBackend[] = [];
function make(scenarios: ScenarioName[], as?: "admin" | "user"): MockBackend {
  const backend = new MockBackend({
    scenarios,
    latencyMs: 0,
    autoTick: false,
    ...(as ? { as } : {}),
  });
  backends.push(backend);
  return backend;
}
afterEach(() => {
  for (const backend of backends.splice(0)) backend.dispose();
});

describe("scenarios", () => {
  it.each(SCENARIO_NAMES.filter((name) => name !== "needs-setup" && name !== "signed-out"))(
    "%s loads the workspace, the library and the queue",
    async (name) => {
      const backend = make([name]);
      expect((await backend.getWorkspace()).channels).toBeDefined();
      if (name === "library-error") {
        await expect(backend.getLibrary()).rejects.toMatchObject({ code: "io" });
      } else {
        expect((await backend.getLibrary()).channels).toBeDefined();
      }
      expect((await backend.getQueue()).queues).toHaveLength(3);
    },
  );

  it("has a description and an owner for every scenario", () => {
    for (const def of Object.values(SCENARIOS)) {
      expect(def.description.length).toBeGreaterThan(10);
      expect(def.owner).not.toBe("");
    }
  });

  it("no-channels has no channel and no video", async () => {
    const backend = make(["no-channels"]);
    expect((await backend.getWorkspace()).channels).toEqual([]);
    expect((await backend.getLibrary()).channels).toEqual([]);
  });

  it("the default library shows every kind of row", async () => {
    const library = await make(["default"]).getLibrary();
    const videos = library.channels.flatMap((c) => c.videos);
    expect(videos.some((v) => v.arollCount === 0)).toBe(true);
    expect(videos.some((v) => v.edited && v.output.project !== null)).toBe(true);
    expect(videos.some((v) => v.finalRendered && v.output.finals.length === 2)).toBe(true);
    expect(videos.find((v) => v.job?.state === "failed")?.job?.error).toMatch(/\.$/);
    expect(videos.some((v) => v.job?.state === "stopped")).toBe(true);
    expect(videos.some((v) => v.detectedType === "short")).toBe(true);
    expect(videos.some((v) => v.typeSource === "override")).toBe(true);
    expect(videos.some((v) => v.id.includes("/") && v.folderName.length > 0)).toBe(true);
    const archived = await make(["default"]).getArchived();
    expect(archived.map((a) => a.folderName)).toEqual(["Old Reel"]);
  });

  it("busy has running, pausing, paused and queued jobs with positions", async () => {
    const queue = await make(["busy"]).getQueue();
    const states = queue.jobs.map((entry) => entry.job.state);
    expect(states).toEqual(expect.arrayContaining(["running", "pausing", "paused", "queued"]));
    const waiting = queue.jobs.filter((e) => e.job.state === "queued");
    expect(waiting.map((e) => e.job.position)).toEqual([1, 2]);
    expect(queue.queues[0]).toMatchObject({ queue: "edits", running: 3, waiting: 3, slots: 3 });
  });

  it("queue-full takes every slot of the three queues", () => {
    const admin = adminQueue(make(["queue-full"]).ctx);
    for (const summary of admin.queues) {
      expect(summary.running).toBe(summary.slots);
      expect(summary.waiting).toBeGreaterThan(0);
    }
    expect(new Set(admin.jobs.map((j) => j.userId)).size).toBe(2);
  });

  it("urgent puts the Urgent edit first in line", () => {
    const admin = adminQueue(make(["urgent"]).ctx);
    const waiting = admin.jobs.filter((j) => j.state === "queued");
    expect(waiting[0]).toMatchObject({
      folderName: "Webcam Comparison",
      urgent: true,
      position: 1,
    });
    expect(waiting.map((j) => j.position)).toEqual([1, 2, 3]);
    expect(waiting.map((j) => j.folderName)).toEqual([
      "Webcam Comparison",
      "Desk Lamp Review",
      "Porto Food Tour",
    ]);
    expect(admin.jobs.filter((j) => j.state === "running")).toHaveLength(1);
    expect(waiting[0]?.startsAt).not.toBeNull();
  });

  it("unreachable-channel reports a channel without videos and refuses an upload into it", async () => {
    const backend = make(["unreachable-channel"]);
    const { channels } = await backend.getLibrary();
    const lostEntries = channels.filter((c) => !c.available);
    expect(lostEntries).toHaveLength(1);
    expect(lostEntries[0]?.videos).toEqual([]);
    expect(channels.some((c) => c.available && c.videos.length > 0)).toBe(true);
    const workspace = await backend.getWorkspace();
    const lost = workspace.channels.find((c) => !c.available);
    expect(lost?.name).toBe("Tech Reviews");
    await expect(
      backend.createUpload({
        target: { kind: "channel", channelId: lost?.id ?? "" },
        name: "a.png",
        size: 5,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This channel's folder cannot be reached right now.",
    });
  });

  it("start-delay holds a waiting edit and offers Start now to the admin", async () => {
    const backend = make(["start-delay"]);
    const admin = adminQueue(backend.ctx);
    const held = admin.jobs.find((j) => j.position === 1);
    expect(held?.startsAt).not.toBeNull();
    const library = await backend.getLibrary();
    const row = library.channels.flatMap((c) => c.videos).find((v) => v.folderName === "Held B");
    expect(row?.actions).toContain("stop");
  });
});

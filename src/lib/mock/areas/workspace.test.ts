import { afterEach, describe, expect, it } from "vitest";
import { MockBackend } from "../backend";
import { profile } from "../seed/workspace";

const options = { latencyMs: 0, autoTick: false } as const;
const backends: MockBackend[] = [];

function make(as: "admin" | "user" = "user", world?: MockBackend["world"]) {
  const backend = new MockBackend({
    ...options,
    scenarios: ["default"],
    as,
    ...(world ? { world } : {}),
  });
  backends.push(backend);
  return backend;
}

afterEach(() => {
  for (const backend of backends.splice(0)) backend.dispose();
});

describe("mock workspace area: the owner's own channel functions", () => {
  it("changes only what the owner may: video type, prompts and styles", async () => {
    const backend = make();
    const [channel] = (await backend.getWorkspace()).channels;
    if (!channel) throw new Error("seed channel missing");
    const long = profile("edited long");
    const updated = await backend.updateChannel({
      id: channel.id,
      update: { videoType: "long", long, short: null },
    });
    expect(updated).toMatchObject({
      name: channel.name,
      dir: channel.dir,
      videoType: "long",
      long,
      short: channel.short,
    });
    // Nothing given: nothing changes.
    expect(
      await backend.updateChannel({
        id: channel.id,
        update: { videoType: null, long: null, short: null },
      }),
    ).toEqual(updated);
  });

  it("imports into channels of the same name without regard to case, and skips the others", async () => {
    const backend = make();
    const document = await backend.exportChannels();
    const [entry] = document.channels;
    if (!entry) throw new Error("seed channel missing");
    const long = profile("imported long");
    const result = await backend.importChannels({
      document: {
        ...document,
        channels: [
          { ...entry, name: entry.name.toUpperCase(), videoType: "short", long },
          { ...entry, name: "Not Mine" },
          { ...entry, name: "Also Not Mine" },
        ],
      },
    });
    expect(result).toEqual({ updated: 1, skipped: ["Not Mine", "Also Not Mine"] });
    const channels = (await backend.getWorkspace()).channels;
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ name: entry.name, videoType: "short", long });
  });

  it("never touches another user's channel by name when importing", async () => {
    const admin = make("admin");
    const user = make("user", admin.world);
    const adminBefore = await admin.getWorkspace();
    const document = await admin.exportChannels();
    const result = await user.importChannels({
      document: {
        ...document,
        channels: document.channels.map((channel) => ({ ...channel, videoType: "short" })),
      },
    });
    // The user has "Travel Diary" only; the admin's names match none of theirs.
    expect(result).toEqual({
      updated: 0,
      skipped: document.channels.map((channel) => channel.name),
    });
    expect(await admin.getWorkspace()).toEqual(adminBefore);
  });

  it("keeps users apart on update and order", async () => {
    const admin = make("admin");
    const user = make("user", admin.world);
    const [adminChannel] = (await admin.getWorkspace()).channels;
    if (!adminChannel) throw new Error("seed channel missing");
    await expect(
      user.updateChannel({
        id: adminChannel.id,
        update: { videoType: "short", long: null, short: null },
      }),
    ).rejects.toMatchObject({ code: "notFound" });
    await expect(user.reorderChannels({ ids: [adminChannel.id] })).rejects.toMatchObject({
      code: "notFound",
    });
  });
});

describe("mock workspace area: a user without channels", () => {
  it("has an empty workspace and library while the admin's page lists none", async () => {
    const backend = new MockBackend({ ...options, scenarios: ["no-channels"], as: "user" });
    backends.push(backend);
    expect((await backend.getWorkspace()).channels).toEqual([]);
    expect((await backend.getLibrary()).channels).toEqual([]);
    expect(await backend.exportChannels()).toMatchObject({ channels: [] });
  });
});

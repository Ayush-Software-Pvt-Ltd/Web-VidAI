import { describe, expect, it } from "vitest";
import { MockBackend } from "../backend";
import { ADMIN_ID, USER_ID } from "../seed/session";
import { FOOTAGE_ROOT, SHARE_ROOT, makeUnreachable } from "../seed/storage";
import { MEDIA_ROOT, personalFolder } from "./workspace";

const options = { latencyMs: 0, autoTick: false } as const;

function backendOf(as: "admin" | "user" = "admin") {
  return new MockBackend({ ...options, scenarios: ["default"], as });
}

const names = (listing: { entries: { name: string }[] }) => listing.entries.map((e) => e.name);

describe("mock storage area: fsPlaces", () => {
  it("lists the personal folder first, then the storage folders", async () => {
    const backend = backendOf();
    expect(await backend.fsPlaces()).toEqual([
      { name: "My folder", path: personalFolder(ADMIN_ID), kind: "personal", available: true },
      { name: "Server storage", path: MEDIA_ROOT, kind: "storage", available: true },
      { name: "footage", path: FOOTAGE_ROOT, kind: "storage", available: true },
      { name: "shoots", path: SHARE_ROOT, kind: "storage", available: true },
    ]);
    backend.dispose();
  });

  it("marks a storage folder that cannot be reached", async () => {
    const backend = backendOf();
    makeUnreachable(backend.world, SHARE_ROOT);
    const places = await backend.fsPlaces();
    expect(places.find((place) => place.path === SHARE_ROOT)?.available).toBe(false);
    expect(places.find((place) => place.path === FOOTAGE_ROOT)?.available).toBe(true);
    await expect(backend.fsList({ path: SHARE_ROOT })).rejects.toMatchObject({
      code: "forbidden",
    });
    backend.dispose();
  });

  it("needs a signed-in user", async () => {
    const backend = new MockBackend({ ...options, scenarios: ["signed-out"] });
    await expect(backend.fsPlaces()).rejects.toMatchObject({ code: "unauthenticated" });
    backend.dispose();
  });
});

describe("mock storage area: fsList", () => {
  it("lists the personal folder when no path is given, with taken channel folders", async () => {
    const backend = backendOf();
    const listing = await backend.fsList();
    expect(listing.path).toBe(personalFolder(ADMIN_ID));
    expect(listing.parent).toBe(MEDIA_ROOT);
    expect(listing.entries).toEqual([
      { name: "Beauty Channel", path: `${personalFolder(ADMIN_ID)}/Beauty Channel`, taken: true },
      { name: "Raw footage", path: `${personalFolder(ADMIN_ID)}/Raw footage`, taken: false },
      { name: "Tech Reviews", path: `${personalFolder(ADMIN_ID)}/Tech Reviews`, taken: true },
    ]);
    backend.dispose();
  });

  it("sorts in natural order, counts videos and leaves hidden folders out", async () => {
    const backend = backendOf();
    const raw = await backend.fsList({ path: `${personalFolder(ADMIN_ID)}/Raw footage` });
    expect(names(raw)).toEqual(["Day 1", "Day 2", "Day 10"]);
    expect(raw.videoCount).toBe(2);
    expect(raw.entries.every((entry) => !entry.taken)).toBe(true);
    const footage = await backend.fsList({ path: FOOTAGE_ROOT });
    expect(names(footage)).toEqual(["Campaigns", "Interviews"]);
    expect(footage.parent).toBeNull();
    const day = await backend.fsList({ path: `${personalFolder(ADMIN_ID)}/Raw footage/Day 2` });
    expect(day.videoCount).toBe(12);
    expect(day.entries).toEqual([]);
    backend.dispose();
  });

  it("flags a folder that contains a channel, and lists the media folder with only my own folder", async () => {
    const backend = backendOf();
    const media = await backend.fsList({ path: MEDIA_ROOT });
    expect(media.parent).toBeNull();
    expect(media.entries).toEqual([
      { name: ADMIN_ID, path: personalFolder(ADMIN_ID), taken: true },
    ]);
    backend.dispose();
  });

  it("flags a folder made into a channel directory later", async () => {
    const backend = backendOf();
    const dir = `${FOOTAGE_ROOT}/Campaigns/Spring launch`;
    const channel = backend.world.channels[0];
    if (!channel) throw new Error("seed channel missing");
    channel.dir = dir;
    const campaigns = await backend.fsList({ path: `${FOOTAGE_ROOT}/Campaigns` });
    expect(campaigns.entries.map((e) => [e.name, e.taken])).toEqual([
      ["Spring launch", true],
      ["Summer sale", false],
    ]);
    expect((await backend.fsList({ path: FOOTAGE_ROOT })).entries[0]).toMatchObject({
      name: "Campaigns",
      taken: true,
    });
    backend.dispose();
  });

  it("refuses what the server refuses, with its sentences", async () => {
    const backend = backendOf();
    await expect(backend.fsList({ path: "/etc" })).rejects.toMatchObject({
      code: "forbidden",
      message: "This folder is outside the storage folders the admin allows.",
    });
    await expect(backend.fsList({ path: `${FOOTAGE_ROOT}/../etc` })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(backend.fsList({ path: "Movies" })).rejects.toMatchObject({
      code: "invalidInput",
      message: "Give the full path of the folder, starting at the top of the disk.",
    });
    await expect(backend.fsList({ path: `${FOOTAGE_ROOT}/Nope` })).rejects.toMatchObject({
      code: "invalidInput",
      message: "This folder does not exist.",
    });
    backend.dispose();
  });

  it("keeps two users apart", async () => {
    const admin = backendOf("admin");
    const user = new MockBackend({
      ...options,
      scenarios: ["default"],
      as: "user",
      world: admin.world,
    });
    expect(names(await user.fsList())).toEqual(["Travel Diary", "Trips"]);
    expect(names(await user.fsList({ path: MEDIA_ROOT }))).toEqual([USER_ID]);
    await expect(user.fsList({ path: personalFolder(ADMIN_ID) })).rejects.toMatchObject({
      code: "forbidden",
      message: "You do not have access to this folder.",
    });
    await expect(
      user.fsCreateFolder({ parent: personalFolder(ADMIN_ID), name: "Mine" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // A folder inside a stranger's channel is a conflict, with the same sentence as a taken one.
    const strangers = admin.world.channels.find((c) => c.userId === ADMIN_ID);
    if (!strangers) throw new Error("seed channel missing");
    strangers.dir = `${FOOTAGE_ROOT}/Interviews`;
    await expect(user.fsList({ path: `${FOOTAGE_ROOT}/Interviews` })).rejects.toMatchObject({
      code: "conflict",
      message: "This folder already belongs to a channel.",
    });
    // The owner may look inside their own channel.
    expect(await admin.fsList({ path: `${FOOTAGE_ROOT}/Interviews` })).toMatchObject({
      entries: [],
    });
    admin.dispose();
    user.dispose();
  });
});

describe("mock storage area: fsCreateFolder", () => {
  it("makes a folder that is then listed, empty and not taken", async () => {
    const backend = backendOf();
    const made = await backend.fsCreateFolder({ parent: FOOTAGE_ROOT, name: "New shoot" });
    expect(made).toEqual({ path: `${FOOTAGE_ROOT}/New shoot` });
    const listing = await backend.fsList({ path: FOOTAGE_ROOT });
    expect(names(listing)).toEqual(["Campaigns", "Interviews", "New shoot"]);
    expect(await backend.fsList({ path: made.path })).toMatchObject({
      path: made.path,
      parent: FOOTAGE_ROOT,
      videoCount: 0,
      entries: [],
    });
    backend.dispose();
  });

  it("refuses a bad name with the reason", async () => {
    const backend = backendOf();
    const bad: [string, string][] = [
      ["", "A name cannot be empty."],
      ["..", 'A name cannot be "." or "..".'],
      ["a/b", "A name cannot contain a slash."],
      [".hidden", "A name cannot start with a dot."],
      [" padded", "A name cannot start or end with a space."],
      ["x".repeat(121), "A name can have at most 120 characters."],
    ];
    for (const [name, message] of bad) {
      await expect(backend.fsCreateFolder({ parent: FOOTAGE_ROOT, name })).rejects.toMatchObject({
        code: "invalidInput",
        message,
      });
    }
    backend.dispose();
  });

  it("refuses a name that exists, a place outside the storage folders and a missing parent", async () => {
    const backend = backendOf();
    await expect(
      backend.fsCreateFolder({ parent: FOOTAGE_ROOT, name: "Interviews" }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "A folder with this name already exists here.",
    });
    await expect(backend.fsCreateFolder({ parent: "/tmp", name: "x" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      backend.fsCreateFolder({ parent: `${FOOTAGE_ROOT}/Gone`, name: "x" }),
    ).rejects.toMatchObject({
      code: "invalidInput",
      message: "The folder to put it in does not exist.",
    });
    backend.dispose();
  });

  it("refuses a folder inside a channel directory", async () => {
    const backend = backendOf();
    await expect(
      backend.fsCreateFolder({ parent: `${personalFolder(ADMIN_ID)}/Beauty Channel`, name: "x" }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This folder already belongs to a channel.",
    });
    backend.dispose();
  });
});

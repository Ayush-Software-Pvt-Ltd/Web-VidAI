import { afterEach, describe, expect, it } from "vitest";
import { MockBackend } from "../backend";
import {
  BEAUTY_DIR,
  DATA_DIR,
  HOME,
  OFFLINE_VOLUME,
  SSD,
  TECH_DIR,
  TRAVEL_DIR,
  makeVolumeUnavailable,
} from "../seed/storage";

const options = { latencyMs: 0, autoTick: false } as const;
const backends: MockBackend[] = [];

function backendOf(as: "admin" | "user" = "admin", world?: MockBackend["world"]) {
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

const names = (listing: { entries: { name: string }[] }) => listing.entries.map((e) => e.name);

describe("mock storage area: fsPlaces", () => {
  it("lists home first, then the drive, then the volumes, one of them unavailable", async () => {
    const backend = backendOf();
    expect(await backend.fsPlaces()).toEqual([
      { name: "Home", path: HOME, kind: "home", available: true },
      { name: "Macintosh HD", path: "/", kind: "drive", available: true },
      { name: "Footage SSD", path: SSD, kind: "volume", available: true },
      { name: "Backup NAS", path: OFFLINE_VOLUME, kind: "volume", available: false },
    ]);
  });

  it("marks a volume that cannot be reached and cannot list it", async () => {
    const backend = backendOf();
    makeVolumeUnavailable(backend.world, SSD);
    const places = await backend.fsPlaces();
    expect(places.find((place) => place.path === SSD)?.available).toBe(false);
    await expect(backend.fsList({ path: SSD })).rejects.toMatchObject({ code: "notFound" });
    await expect(backend.fsList({ path: OFFLINE_VOLUME })).rejects.toMatchObject({
      code: "notFound",
    });
    // The unavailable volume is not in the listing of /Volumes either.
    expect(names(await backend.fsList({ path: "/Volumes" }))).toEqual([]);
  });

  it("needs a signed-in account", async () => {
    const backend = new MockBackend({ ...options, scenarios: ["signed-out"] });
    backends.push(backend);
    await expect(backend.fsPlaces()).rejects.toMatchObject({ code: "unauthenticated" });
  });
});

describe("mock storage area: fsList", () => {
  it("lists the home folder when no path is given, with the channel folders taken", async () => {
    const backend = backendOf();
    const listing = await backend.fsList();
    expect(listing.path).toBe(HOME);
    expect(listing.parent).toBe("/Users");
    expect(listing.entries.map((e) => [e.name, e.taken])).toEqual([
      ["Desktop", false],
      ["Documents", false],
      ["Downloads", false],
      // Holds the Tech Reviews and Travel Diary channels.
      ["Footage", true],
      ["Movies", false],
      // The server's own data directory.
      ["VidAI Data", true],
    ]);
  });

  it("shows the tops of the drive and of a volume, whose parent is null", async () => {
    const backend = backendOf();
    const drive = await backend.fsList({ path: "/" });
    expect(drive.parent).toBeNull();
    expect(names(drive)).toEqual(["Applications", "Library", "System", "Users", "Volumes"]);
    expect(names(await backend.fsList({ path: "/Volumes" }))).toEqual(["Footage SSD"]);
    const ssd = await backend.fsList({ path: SSD });
    expect(ssd.parent).toBeNull();
    expect(ssd.entries.map((e) => [e.name, e.taken])).toEqual([
      ["Beauty Channel", true],
      ["Beauty Channel Backup", false],
      ["Client Shoots", false],
      ["Spare", false],
    ]);
  });

  it("sorts in natural order, counts videos and leaves hidden folders out", async () => {
    const backend = backendOf();
    const shoots = await backend.fsList({ path: `${SSD}/Client Shoots` });
    expect(names(shoots)).toEqual(["Spring launch", "Summer sale"]);
    expect((await backend.fsList({ path: `${SSD}/Client Shoots/Spring launch` })).videoCount).toBe(
      9,
    );
    expect(names(await backend.fsList({ path: `${HOME}/Footage` }))).toEqual([
      "Archive 2024",
      "Archive 2025",
      "Interviews",
      "Tech Reviews",
      "Travel Diary",
    ]);
    // `.cache` and `.Trashes` exist but are not listed.
    expect(names(await backend.fsList({ path: HOME }))).not.toContain(".cache");
    expect(names(await backend.fsList({ path: SSD }))).not.toContain(".Trashes");
  });

  it("lists the video and upload folders inside a channel directory", async () => {
    const backend = backendOf();
    const beauty = await backend.fsList({ path: BEAUTY_DIR });
    expect(names(beauty)).toContain("Hair Oil Review");
    expect(names(beauty)).toContain("upload");
    const video = await backend.fsList({ path: `${BEAUTY_DIR}/Hair Oil Review` });
    expect(names(video)).toEqual(["upload"]);
    expect(video.videoCount).toBe(1);
  });

  it("flags a folder made into a channel directory later, and anything in the data directory", async () => {
    const backend = backendOf();
    const channel = backend.world.channels[0];
    if (!channel) throw new Error("seed channel missing");
    channel.dir = `${SSD}/Client Shoots/Spring launch`;
    const shoots = await backend.fsList({ path: `${SSD}/Client Shoots` });
    expect(shoots.entries.map((e) => [e.name, e.taken])).toEqual([
      ["Spring launch", true],
      ["Summer sale", false],
    ]);
    expect(
      (await backend.fsList({ path: SSD })).entries.find((e) => e.name === "Client Shoots"),
    ).toMatchObject({ taken: true });
    const data = await backend.fsList({ path: DATA_DIR });
    expect(data.entries).toEqual([{ name: "projects", path: `${DATA_DIR}/projects`, taken: true }]);
  });

  it("resolves .. and trailing slashes and refuses what the server refuses", async () => {
    const backend = backendOf();
    expect((await backend.fsList({ path: `${HOME}/Footage/../Movies/` })).path).toBe(
      `${HOME}/Movies`,
    );
    await expect(backend.fsList({ path: "Movies" })).rejects.toMatchObject({
      code: "invalidInput",
      message: "Give the full path of the folder, starting at the top of the disk.",
    });
    await expect(backend.fsList({ path: `${HOME}/Nope` })).rejects.toMatchObject({
      code: "notFound",
      message: "This folder does not exist or cannot be read.",
    });
  });

  it("answers forbidden to a user, for every path", async () => {
    const admin = backendOf("admin");
    const user = backendOf("user", admin.world);
    await expect(user.fsPlaces()).rejects.toMatchObject({ code: "forbidden" });
    await expect(user.fsList()).rejects.toMatchObject({ code: "forbidden" });
    await expect(user.fsList({ path: TRAVEL_DIR })).rejects.toMatchObject({ code: "forbidden" });
    await expect(user.fsList({ path: TECH_DIR })).rejects.toMatchObject({ code: "forbidden" });
    await expect(user.fsCreateFolder({ parent: HOME, name: "Mine" })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(admin.world.fs.some((folder) => folder.path === `${HOME}/Mine`)).toBe(false);
  });
});

describe("mock storage area: fsCreateFolder", () => {
  it("makes a folder that is then listed, empty and not taken", async () => {
    const backend = backendOf();
    const made = await backend.fsCreateFolder({ parent: SSD, name: "New shoot" });
    expect(made).toEqual({ path: `${SSD}/New shoot` });
    expect(names(await backend.fsList({ path: SSD }))).toContain("New shoot");
    expect(await backend.fsList({ path: made.path })).toMatchObject({
      path: made.path,
      parent: SSD,
      videoCount: 0,
      entries: [],
    });
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
      await expect(backend.fsCreateFolder({ parent: HOME, name })).rejects.toMatchObject({
        code: "invalidInput",
        message,
      });
    }
  });

  it("refuses a name that exists and a parent that is missing or on an unavailable volume", async () => {
    const backend = backendOf();
    await expect(backend.fsCreateFolder({ parent: HOME, name: "Movies" })).rejects.toMatchObject({
      code: "conflict",
      message: "A folder with this name already exists here.",
    });
    await expect(
      backend.fsCreateFolder({ parent: `${HOME}/Gone`, name: "x" }),
    ).rejects.toMatchObject({
      code: "notFound",
      message: "The folder to put it in does not exist.",
    });
    await expect(
      backend.fsCreateFolder({ parent: OFFLINE_VOLUME, name: "x" }),
    ).rejects.toMatchObject({ code: "notFound" });
  });

  it("may make a folder anywhere on the disk, also on the drive's own folders", async () => {
    const backend = backendOf();
    expect(await backend.fsCreateFolder({ parent: "/Users/Shared", name: "Clips" })).toEqual({
      path: "/Users/Shared/Clips",
    });
  });
});

/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests index into seeded lists they just checked */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockBackend } from "../backend";
import type { Library } from "../../types";
import type { ScenarioName } from "../scenarios";
import {
  ANA_EMAIL,
  BEN_EMAIL,
  CHESS_ID,
  COOKING_DIR,
  COOKING_ID,
  GARDEN_ID,
  RETRO_ID,
} from "../seed/adminChannels";
import { ADMIN_ID, USER_ID } from "../seed/session";
import {
  BEAUTY_BACKUP_DIR,
  BEAUTY_DIR,
  DATA_DIR,
  HOME,
  OFFLINE_VOLUME,
  SSD,
  TECH_DIR,
  TRAVEL_DIR,
} from "../seed/storage";
import { ADMIN_CHANNEL_BEAUTY, ADMIN_CHANNEL_TECH, USER_CHANNEL_TRAVEL } from "../seed/workspace";
import type { World } from "../world";

const backends: MockBackend[] = [];
function make(
  as: "admin" | "user" = "admin",
  world?: World,
  scenarios: ScenarioName[] = ["default"],
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
  for (const backend of backends.splice(0)) backend.dispose();
});

const channelNames = async (backend: MockBackend) =>
  (await backend.getWorkspace()).channels.map((c) => c.name);

describe("admin channels: who may call them", () => {
  it("answers forbidden to a user and changes nothing", async () => {
    const admin = make();
    const user = make("user", admin.world);
    const before = structuredClone(admin.world.channels);
    const forbidden = { code: "forbidden" };
    await expect(user.adminListChannels()).rejects.toMatchObject(forbidden);
    await expect(
      user.adminCreateChannel({
        name: "Mine",
        userId: USER_ID,
        dir: `${HOME}/Movies`,
        videoType: "auto",
      }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      user.adminUpdateChannel({
        id: USER_CHANNEL_TRAVEL,
        update: { name: "Renamed", userId: null, dir: null, videoType: null },
      }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      user.adminUpdateChannel({
        id: ADMIN_CHANNEL_BEAUTY,
        update: { name: null, userId: USER_ID, dir: null, videoType: null },
      }),
    ).rejects.toMatchObject(forbidden);
    await expect(user.adminRemoveChannel({ id: USER_CHANNEL_TRAVEL })).rejects.toMatchObject(
      forbidden,
    );
    expect(admin.world.channels).toEqual(before);
  });

  it("needs a signed-in account", async () => {
    const backend = new MockBackend({ scenarios: ["signed-out"], latencyMs: 0, autoTick: false });
    backends.push(backend);
    await expect(backend.adminListChannels()).rejects.toMatchObject({ code: "unauthenticated" });
  });
});

describe("admin channels: listing", () => {
  it("lists every user's channels by owner email, then name", async () => {
    const backend = make();
    const channels = await backend.adminListChannels();
    expect(channels.map((c) => [c.userEmail, c.name])).toEqual([
      ["admin@example.com", "Beauty Channel"],
      ["admin@example.com", "Tech Reviews"],
      ["user@example.com", "Travel Diary"],
    ]);
    expect(channels[0]).toEqual({
      id: ADMIN_CHANNEL_BEAUTY,
      name: "Beauty Channel",
      dir: BEAUTY_DIR,
      userId: ADMIN_ID,
      userEmail: "admin@example.com",
      videoType: "auto",
      available: true,
      videoCount: 9,
      busy: false,
    });
  });

  it("shows busy, unavailable and the video count of the admin-channels scenario", async () => {
    const backend = make("admin", undefined, ["admin-channels"]);
    const channels = await backend.adminListChannels();
    const by = (id: string) => channels.find((c) => c.id === id)!;
    expect(channels.map((c) => c.userEmail)).toEqual(
      [...channels.map((c) => c.userEmail)].sort((a, b) => a.localeCompare(b)),
    );
    expect(by(COOKING_ID)).toMatchObject({ userEmail: ANA_EMAIL, busy: true, videoCount: 3 });
    expect(by(GARDEN_ID)).toMatchObject({ userEmail: ANA_EMAIL, busy: false, videoCount: 1 });
    expect(by(RETRO_ID)).toMatchObject({
      userEmail: BEN_EMAIL,
      available: false,
      videoCount: 0,
      dir: `${OFFLINE_VOLUME}/Retro Games`,
    });
    expect(by(CHESS_ID)).toMatchObject({ available: true, busy: false, videoCount: 2 });
  });
});

describe("admin channels: creating", () => {
  it("gives a channel to a user, last in their order, and tells that user", async () => {
    const admin = make();
    const user = make("user", admin.world);
    const other = make("admin", admin.world);
    const workspaceSeen = vi.fn();
    const librarySeen = vi.fn<(library: Library | null) => void>();
    const otherSeen = vi.fn();
    user.on.workspaceChanged(workspaceSeen);
    user.on.libraryChanged(librarySeen);
    other.on.workspaceChanged(otherSeen);
    const folder = await admin.fsCreateFolder({ parent: SSD, name: "Cooking" });
    const created = await admin.adminCreateChannel({
      name: "  Cooking ",
      userId: USER_ID,
      dir: `${folder.path}/`,
      videoType: "short",
    });
    expect(created).toMatchObject({
      name: "Cooking",
      userId: USER_ID,
      userEmail: "user@example.com",
      dir: folder.path,
      videoType: "short",
      available: true,
      videoCount: 0,
      busy: false,
    });
    expect(await channelNames(user)).toEqual(["Travel Diary", "Cooking"]);
    const mine = (await user.getWorkspace()).channels.at(-1)!;
    expect(mine.long.prompts).toHaveLength(5);
    expect(mine.long.prompts[0]!.name).toBe("Default");
    expect(workspaceSeen).toHaveBeenCalledTimes(1);
    expect(librarySeen).toHaveBeenCalledTimes(1);
    expect(librarySeen.mock.calls[0]![0]?.channels.map((c) => c.channelId)).toContain(created.id);
    // The admin's own account is not the owner: nothing for it.
    expect(otherSeen).not.toHaveBeenCalled();
    expect(await channelNames(admin)).toEqual(["Beauty Channel", "Tech Reviews"]);
  });

  it("refuses a bad name, an unknown owner and a bad video type with the field", async () => {
    const backend = make();
    const input = {
      name: "Fine",
      userId: USER_ID,
      dir: `${HOME}/Movies`,
      videoType: "auto",
    } as const;
    await expect(backend.adminCreateChannel({ ...input, name: "   " })).rejects.toMatchObject({
      code: "invalidInput",
      field: "name",
    });
    await expect(
      backend.adminCreateChannel({ ...input, name: "x".repeat(61) }),
    ).rejects.toMatchObject({ code: "invalidInput", field: "name" });
    await expect(backend.adminCreateChannel({ ...input, userId: "nobody" })).rejects.toMatchObject({
      code: "notFound",
      field: "userId",
    });
    await expect(
      backend.adminCreateChannel({ ...input, videoType: "wide" as never }),
    ).rejects.toMatchObject({ code: "invalidInput", field: "videoType" });
    expect(await backend.adminListChannels()).toHaveLength(3);
  });

  it("keeps a name unique per owner without regard to case, and free for another owner", async () => {
    const backend = make();
    await expect(
      backend.adminCreateChannel({
        name: "TRAVEL diary",
        userId: USER_ID,
        dir: `${HOME}/Movies`,
        videoType: "auto",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This user already has a channel with that name.",
      field: "name",
    });
    const same = await backend.adminCreateChannel({
      name: "Travel Diary",
      userId: ADMIN_ID,
      dir: `${HOME}/Movies`,
      videoType: "auto",
    });
    expect(same.userId).toBe(ADMIN_ID);
  });

  it("checks the folder: it must exist, stay out of VidAI's data and not overlap a channel", async () => {
    const backend = make();
    const create = (dir: string) =>
      backend.adminCreateChannel({ name: "New", userId: USER_ID, dir, videoType: "auto" });
    for (const dir of [`${HOME}/Nope`, OFFLINE_VOLUME, `${OFFLINE_VOLUME}/Archive`]) {
      await expect(create(dir)).rejects.toMatchObject({
        code: "invalidInput",
        message: "This folder does not exist.",
        field: "dir",
      });
    }
    for (const dir of ["relative/dir", ""]) {
      await expect(create(dir)).rejects.toMatchObject({ code: "invalidInput", field: "dir" });
    }
    // The data directory, a folder inside it and a folder that contains it.
    for (const dir of [DATA_DIR, `${DATA_DIR}/projects`, HOME, "/Users", "/"]) {
      await expect(create(dir)).rejects.toMatchObject({
        code: "invalidInput",
        message: "This folder belongs to VidAI's own data.",
        field: "dir",
      });
    }
    // The same folder as, inside and around another channel's, also another user's.
    const taken = {
      code: "conflict",
      message: "This folder already belongs to a channel.",
      field: "dir",
    };
    await expect(create(TECH_DIR)).rejects.toMatchObject(taken);
    await expect(create(`${TECH_DIR}/Phone Camera Test`)).rejects.toMatchObject(taken);
    await expect(create(`${HOME}/Footage`)).rejects.toMatchObject(taken);
    await expect(create(`${SSD}/Beauty Channel/../Beauty Channel`)).rejects.toMatchObject(taken);
    // A sibling whose name only starts the same is fine.
    expect((await create(BEAUTY_BACKUP_DIR)).dir).toBe(BEAUTY_BACKUP_DIR);
  });
});

describe("admin channels: changing", () => {
  it("renames and changes the video type, also while the channel is busy", async () => {
    const backend = make("admin", undefined, ["admin-channels"]);
    const updated = await backend.adminUpdateChannel({
      id: COOKING_ID,
      update: { name: "Cooking Show", userId: null, dir: null, videoType: "long" },
    });
    expect(updated).toMatchObject({ name: "Cooking Show", videoType: "long", busy: true });
    // The same name in other letters is the channel's own.
    await backend.adminUpdateChannel({
      id: COOKING_ID,
      update: { name: "COOKING SHOW", userId: null, dir: null, videoType: null },
    });
    const owner = make("user", backend.world);
    backend.world.sessions.clear();
    expect(owner).toBeDefined();
  });

  it("refuses a name the owner already has, with the field", async () => {
    const backend = make("admin", undefined, ["admin-channels"]);
    await expect(
      backend.adminUpdateChannel({
        id: GARDEN_ID,
        update: { name: "cooking basics", userId: null, dir: null, videoType: null },
      }),
    ).rejects.toMatchObject({ code: "conflict", field: "name" });
    // The name of Ben's channel is free for Ana's.
    const renamed = await backend.adminUpdateChannel({
      id: GARDEN_ID,
      update: { name: "Chess Club", userId: null, dir: null, videoType: null },
    });
    expect(renamed.name).toBe("Chess Club");
  });

  it("refuses an unknown channel, owner and folder", async () => {
    const backend = make();
    const none = { name: null, userId: null, dir: null, videoType: null };
    await expect(
      backend.adminUpdateChannel({ id: "nope", update: { ...none, name: "x" } }),
    ).rejects.toMatchObject({ code: "notFound" });
    await expect(
      backend.adminUpdateChannel({ id: ADMIN_CHANNEL_TECH, update: { ...none, userId: "nobody" } }),
    ).rejects.toMatchObject({ code: "notFound", field: "userId" });
    await expect(
      backend.adminUpdateChannel({
        id: ADMIN_CHANNEL_TECH,
        update: { ...none, dir: `${HOME}/Nope` },
      }),
    ).rejects.toMatchObject({ code: "invalidInput", field: "dir" });
    await expect(
      backend.adminUpdateChannel({ id: ADMIN_CHANNEL_TECH, update: { ...none, dir: DATA_DIR } }),
    ).rejects.toMatchObject({ code: "invalidInput", field: "dir" });
    await expect(
      backend.adminUpdateChannel({ id: ADMIN_CHANNEL_TECH, update: { ...none, dir: TRAVEL_DIR } }),
    ).rejects.toMatchObject({ code: "conflict", field: "dir" });
  });

  it("moves a channel to a new owner: last in their order, with its videos, events to both", async () => {
    const admin = make();
    const user = make("user", admin.world);
    const userWorkspace = vi.fn();
    const userLibrary = vi.fn();
    const adminWorkspace = vi.fn();
    user.on.workspaceChanged(userWorkspace);
    user.on.libraryChanged(userLibrary);
    admin.on.workspaceChanged(adminWorkspace);

    const before = await user.getLibrary();
    expect(before.channels.map((c) => c.channelId)).toEqual([USER_CHANNEL_TRAVEL]);
    const moved = await admin.adminUpdateChannel({
      id: ADMIN_CHANNEL_TECH,
      update: { name: null, userId: USER_ID, dir: null, videoType: null },
    });
    expect(moved).toMatchObject({ userId: USER_ID, userEmail: "user@example.com" });

    expect(await channelNames(user)).toEqual(["Travel Diary", "Tech Reviews"]);
    expect(await channelNames(admin)).toEqual(["Beauty Channel"]);
    const library = await user.getLibrary();
    expect(library.channels.map((c) => c.channelId)).toEqual([
      USER_CHANNEL_TRAVEL,
      ADMIN_CHANNEL_TECH,
    ]);
    const tech = library.channels[1]!;
    expect(tech.videos.map((v) => v.folderName)).toContain("Phone Camera Test");
    // The new owner works on the videos, the old one no longer reaches them.
    const videoId = tech.videos[0]!.id;
    await user.setVideoTypeOverride({ videoId, videoType: "short" });
    await expect(admin.setVideoTypeOverride({ videoId, videoType: "long" })).rejects.toMatchObject({
      code: "notFound",
    });
    // The old owner (here: the admin) and the new one are told.
    expect(userWorkspace).toHaveBeenCalledTimes(1);
    expect(adminWorkspace).toHaveBeenCalledTimes(1);
    expect(userLibrary).toHaveBeenCalled();
  });

  it("keeps finished jobs with the user who made them", async () => {
    const admin = make();
    const user = make("user", admin.world);
    const ended = admin.world.jobs.filter((job) =>
      job.view.videoId.startsWith(`${ADMIN_CHANNEL_BEAUTY}/`),
    );
    expect(ended.length).toBeGreaterThan(0);
    await admin.adminUpdateChannel({
      id: ADMIN_CHANNEL_BEAUTY,
      update: { name: null, userId: USER_ID, dir: null, videoType: null },
    });
    for (const job of ended) expect(job.view.userId).toBe(ADMIN_ID);
    expect(admin.world.jobs).toEqual(expect.arrayContaining(ended));
    expect((await user.getQueue()).jobs.every((entry) => entry.job.userId === USER_ID)).toBe(true);
  });

  it("cancels unfinished uploads into the channel on an owner change, keeps finished files", async () => {
    const admin = make("admin", undefined, ["uploading"]);
    const unfinished = admin.world.uploads.filter((u) => !u.done);
    expect(unfinished).toHaveLength(1);
    const finishedBefore = admin.world.uploads.filter(
      (u) => u.done && u.channelId === ADMIN_CHANNEL_BEAUTY,
    ).length;
    await admin.adminUpdateChannel({
      id: ADMIN_CHANNEL_BEAUTY,
      update: { name: null, userId: USER_ID, dir: null, videoType: null },
    });
    expect(admin.world.uploads.some((u) => !u.done)).toBe(false);
    expect(
      admin.world.uploads.filter((u) => u.done && u.channelId === ADMIN_CHANNEL_BEAUTY),
    ).toHaveLength(finishedBefore);
    const user = make("user", admin.world);
    expect(
      (
        await user.listUploads({ target: { kind: "channel", channelId: ADMIN_CHANNEL_BEAUTY } })
      ).map((f) => f.name),
    ).toEqual(["brand-kit.zip", "intro-jingle.wav"]);
    await expect(
      admin.listUploads({ target: { kind: "channel", channelId: ADMIN_CHANNEL_BEAUTY } }),
    ).rejects.toMatchObject({ code: "notFound" });
  });

  it("puts the new owner's name rule first when the owner changes", async () => {
    const backend = make();
    const created = await backend.adminCreateChannel({
      name: "Travel Diary",
      userId: ADMIN_ID,
      dir: `${HOME}/Movies`,
      videoType: "auto",
    });
    await expect(
      backend.adminUpdateChannel({
        id: created.id,
        update: { name: null, userId: USER_ID, dir: null, videoType: null },
      }),
    ).rejects.toMatchObject({ code: "conflict", field: "name" });
  });

  it("refuses an owner or folder change while a job waits, runs or is paused, not a rename", async () => {
    const backend = make("admin", undefined, ["admin-channels"]);
    const busy = {
      code: "conflict",
      message: "Stop the running edits of this channel's videos first.",
    };
    const spare = await backend.fsCreateFolder({ parent: SSD, name: "Elsewhere" });
    await expect(
      backend.adminUpdateChannel({
        id: COOKING_ID,
        update: { name: null, userId: USER_ID, dir: null, videoType: null },
      }),
    ).rejects.toMatchObject(busy);
    await expect(
      backend.adminUpdateChannel({
        id: COOKING_ID,
        update: { name: null, userId: null, dir: spare.path, videoType: null },
      }),
    ).rejects.toMatchObject(busy);
    const channel = (await backend.adminListChannels()).find((c) => c.id === COOKING_ID)!;
    expect(channel).toMatchObject({ dir: COOKING_DIR, busy: true });
    // After the job is stopped the change goes through.
    for (const job of backend.world.jobs) job.view.state = "stopped";
    const moved = await backend.adminUpdateChannel({
      id: COOKING_ID,
      update: { name: null, userId: null, dir: spare.path, videoType: null },
    });
    expect(moved).toMatchObject({ dir: spare.path, busy: false });
  });

  it("keeps the video rows whose folder of the same name lies in the new folder", async () => {
    const backend = make();
    const before = await backend.getLibrary();
    const beauty = before.channels.find((c) => c.channelId === ADMIN_CHANNEL_BEAUTY)!;
    expect(beauty.videos.length).toBeGreaterThan(2);
    const inputs = {
      productLinks: "https://example.com/x",
      notes: "keep me",
      promptSlot: 2,
      styleSlot: 1,
    };
    const hair = beauty.videos.find((v) => v.folderName === "Hair Oil Review")!;
    await backend.setVideoInputs({ videoId: hair.id, inputs });
    const moved = await backend.adminUpdateChannel({
      id: ADMIN_CHANNEL_BEAUTY,
      update: { name: null, userId: null, dir: BEAUTY_BACKUP_DIR, videoType: null },
    });
    expect(moved).toMatchObject({ dir: BEAUTY_BACKUP_DIR, videoCount: 2 });
    const after = (await backend.getLibrary()).channels.find(
      (c) => c.channelId === ADMIN_CHANNEL_BEAUTY,
    )!;
    expect(after.videos.map((v) => v.folderName).sort()).toEqual([
      "Hair Oil Review",
      "Night Cream",
    ]);
    expect(await backend.getVideoInputs({ videoId: hair.id })).toEqual(inputs);
    // The rows of the other folders went with their jobs, archive entries and uploads.
    const left = new Set(after.videos.map((v) => v.id));
    expect(backend.world.videos.filter((v) => v.channelId === ADMIN_CHANNEL_BEAUTY)).toHaveLength(
      2,
    );
    expect(
      backend.world.jobs.every(
        (j) => !j.view.videoId.startsWith(`${ADMIN_CHANNEL_BEAUTY}/`) || left.has(j.view.videoId),
      ),
    ).toBe(true);
    expect((await backend.getArchived()).map((a) => a.folderName)).not.toContain("Old Reel");
    expect(
      backend.world.uploads.some(
        (u) =>
          u.videoId !== null &&
          u.videoId.startsWith(`${ADMIN_CHANNEL_BEAUTY}/`) &&
          !left.has(u.videoId),
      ),
    ).toBe(false);
  });

  it("leaves the old folder on the disk, free to become another channel", async () => {
    const backend = make();
    await backend.adminUpdateChannel({
      id: ADMIN_CHANNEL_BEAUTY,
      update: { name: null, userId: null, dir: BEAUTY_BACKUP_DIR, videoType: null },
    });
    const listing = await backend.fsList({ path: BEAUTY_DIR });
    expect(listing.entries.map((e) => e.name)).toEqual(
      expect.arrayContaining(["Hair Oil Review", "Night Cream", "upload"]),
    );
    expect(listing.entries.every((e) => !e.taken)).toBe(true);
    const again = await backend.adminCreateChannel({
      name: "Beauty Again",
      userId: ADMIN_ID,
      dir: BEAUTY_DIR,
      videoType: "auto",
    });
    expect(again.dir).toBe(BEAUTY_DIR);
    expect(again.videoCount).toBe(0);
  });

  it("makes an unavailable channel available once it has a folder that can be reached", async () => {
    const backend = make("admin", undefined, ["admin-channels"]);
    const target = await backend.fsCreateFolder({ parent: SSD, name: "Retro" });
    const moved = await backend.adminUpdateChannel({
      id: RETRO_ID,
      update: { name: null, userId: null, dir: target.path, videoType: null },
    });
    expect(moved).toMatchObject({ available: true, videoCount: 0 });
  });
});

describe("admin channels: removing", () => {
  it("removes the rows and keeps the folder and its files", async () => {
    const admin = make();
    const user = make("user", admin.world);
    const workspaceSeen = vi.fn();
    user.on.workspaceChanged(workspaceSeen);
    expect(await admin.adminRemoveChannel({ id: USER_CHANNEL_TRAVEL })).toBeNull();
    expect((await admin.adminListChannels()).map((c) => c.id)).not.toContain(USER_CHANNEL_TRAVEL);
    expect((await user.getWorkspace()).channels).toEqual([]);
    expect((await user.getLibrary()).channels).toEqual([]);
    expect(workspaceSeen).toHaveBeenCalledTimes(1);
    // Videos, jobs and uploads of the channel are gone from the server's tables.
    expect(admin.world.videos.some((v) => v.channelId === USER_CHANNEL_TRAVEL)).toBe(false);
    expect(admin.world.jobs.some((j) => j.view.videoId.startsWith(`${USER_CHANNEL_TRAVEL}/`))).toBe(
      false,
    );
    expect(admin.world.uploads.some((u) => u.channelId === USER_CHANNEL_TRAVEL)).toBe(false);
    // The folder and everything in it stay: still listed, no longer taken.
    const folder = await admin.fsList({ path: TRAVEL_DIR });
    expect(folder.entries.map((e) => e.name)).toEqual(
      expect.arrayContaining(["Lisbon Day 1", "upload"]),
    );
    expect(
      (await admin.fsList({ path: `${HOME}/Footage` })).entries.find(
        (e) => e.name === "Travel Diary",
      ),
    ).toMatchObject({ taken: false });
    await expect(admin.adminRemoveChannel({ id: USER_CHANNEL_TRAVEL })).rejects.toMatchObject({
      code: "notFound",
    });
  });

  it("refuses while a job of one of its videos waits, runs or is paused", async () => {
    const backend = make("admin", undefined, ["admin-channels"]);
    const busy = {
      code: "conflict",
      message: "Stop the running edits of this channel's videos first.",
    };
    await expect(backend.adminRemoveChannel({ id: COOKING_ID })).rejects.toMatchObject(busy);
    const row = backend.world.jobs.find((j) => j.view.videoId.startsWith(`${COOKING_ID}/`))!;
    for (const state of ["queued", "paused"] as const) {
      row.view.state = state;
      await expect(backend.adminRemoveChannel({ id: COOKING_ID })).rejects.toMatchObject(busy);
    }
    row.view.state = "stopped";
    await backend.adminRemoveChannel({ id: COOKING_ID });
    expect((await backend.adminListChannels()).map((c) => c.id)).not.toContain(COOKING_ID);
  });

  it("does not remove the account's other data: the edit log and the accounts stay", async () => {
    const backend = make();
    const entries = backend.world.editLog.length;
    expect(entries).toBeGreaterThan(0);
    await backend.adminRemoveChannel({ id: ADMIN_CHANNEL_BEAUTY });
    expect(backend.world.editLog).toHaveLength(entries);
    expect(backend.world.users).toHaveLength(2);
  });
});

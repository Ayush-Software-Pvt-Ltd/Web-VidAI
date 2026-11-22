import { describe, expect, it } from "vitest";
import type { DiskUse, EditLogEntry, Library } from "../../types";
import { makeVideoId } from "../../videoId";
import { MockBackend } from "../backend";
import { ADMIN_EMAIL, USER_EMAIL, USER_ID } from "../seed/session";
import { ADMIN_CHANNEL_BEAUTY, ADMIN_CHANNEL_TECH, USER_CHANNEL_TRAVEL } from "../seed/workspace";

const options = { latencyMs: 0, autoTick: false } as const;
const GB = 1024 ** 3;
const SERUM = makeVideoId(ADMIN_CHANNEL_BEAUTY, "Serum Launch");
const NIGHT_CREAM = makeVideoId(ADMIN_CHANNEL_BEAUTY, "Night Cream");
const OLD_REEL = makeVideoId(ADMIN_CHANNEL_BEAUTY, "Old Reel");
const LIP_BALM = makeVideoId(ADMIN_CHANNEL_BEAUTY, "Lip Balm Haul");
const LISBON = makeVideoId(USER_CHANNEL_TRAVEL, "Lisbon Day 1");

function backendOf(scenarios: ("default" | "disk-large")[] = ["default"], as?: "admin" | "user") {
  return new MockBackend({ ...options, scenarios, ...(as ? { as } : {}) });
}

/** A second browser of the same server, signed in as the plain user. */
function userOf(admin: MockBackend): MockBackend {
  return new MockBackend({ ...options, world: admin.world, as: "user" });
}

/** A value that must exist (a test fails clearly instead of asserting with `!`). */
function need<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected a value.");
  return value;
}

const actionsOf = (library: Library, videoId: string) =>
  library.channels.flatMap((c) => c.videos).find((v) => v.id === videoId)?.actions;

describe("mock disk area: getDiskUse", () => {
  it("lists the signed-in user's videos with sizes, archived ones too, newest folder first", async () => {
    const backend = backendOf();
    const use = await backend.getDiskUse();
    const beauty = use.videos.filter((v) => v.channelId === ADMIN_CHANNEL_BEAUTY);
    const names = beauty.map((v) => v.folderName);
    expect(names).toEqual([...names].sort((a, b) => b.localeCompare(a, "en", { numeric: true })));
    expect(use.videos.map((v) => v.videoId)).toContain(OLD_REEL);
    expect(use.videos.find((v) => v.videoId === OLD_REEL)).toMatchObject({ archived: true });
    expect(use.videos.find((v) => v.videoId === SERUM)?.sizes).toMatchObject({
      working: Math.round(12.3 * GB),
    });
    expect(use.videos.some((v) => v.videoId === LISBON)).toBe(false);
    backend.dispose();
  });

  it("sums the sizes of the videos that have them", async () => {
    const backend = backendOf();
    const use = await backend.getDiskUse();
    const sum = (key: "working" | "project" | "finals" | "sources" | "total") =>
      use.videos.reduce((total, v) => total + (v.sizes?.[key] ?? 0), 0);
    expect(use.totals).toEqual({
      working: sum("working"),
      project: sum("project"),
      finals: sum("finals"),
      sources: sum("sources"),
      total: sum("total"),
    });
    expect(use.totals.total).toBe(
      use.totals.working + use.totals.project + use.totals.finals + use.totals.sources,
    );
    expect(use.measuring).toBe(false);
    backend.dispose();
  });

  it("shows a user only their own videos", async () => {
    const admin = backendOf();
    const user = userOf(admin);
    const use = await user.getDiskUse();
    expect(use.videos.map((v) => v.videoId)).toEqual([
      expect.stringContaining(USER_CHANNEL_TRAVEL),
    ]);
    expect(use.videos.every((v) => v.channelId === USER_CHANNEL_TRAVEL)).toBe(true);
    user.dispose();
    admin.dispose();
  });

  it("says measuring for a folder without numbers, then measures it on a tick and tells its owner", async () => {
    const backend = backendOf(["disk-large"]);
    const events: DiskUse[] = [];
    backend.on.diskUseChanged((use) => events.push(use));
    const first = await backend.getDiskUse();
    expect(first.measuring).toBe(true);
    const gear = first.videos.find((v) => v.folderName === "Gear Comparison");
    expect(gear).toMatchObject({ sizes: null, measuring: true, measuredAt: null });
    backend.tick();
    backend.tick();
    expect(events).toHaveLength(2);
    const last = events.at(-1);
    expect(last?.measuring).toBe(false);
    expect(last?.videos.find((v) => v.folderName === "Gear Comparison")?.sizes).not.toBeNull();
    expect((await backend.getDiskUse()).measuring).toBe(false);
    backend.dispose();
  });

  it("does not measure for somebody who has not asked", () => {
    const backend = backendOf(["disk-large"]);
    const events: DiskUse[] = [];
    backend.on.diskUseChanged((use) => events.push(use));
    backend.tick();
    expect(events).toHaveLength(0);
    backend.dispose();
  });

  it("measures again a video whose working files appeared (a finished edit)", async () => {
    const backend = backendOf();
    need(backend.world.videos.find((v) => v.folderName === "Night Cream")).workingFiles = true;
    const use = await backend.getDiskUse();
    expect(use.videos.find((v) => v.videoId === NIGHT_CREAM)).toMatchObject({ measuring: true });
    backend.tick();
    const after = await backend.getDiskUse();
    const cream = after.videos.find((v) => v.videoId === NIGHT_CREAM);
    expect(cream?.measuring).toBe(false);
    expect(cream?.sizes?.working).toBeGreaterThan(0);
    backend.dispose();
  });

  it("needs a session", async () => {
    const backend = new MockBackend({ ...options, scenarios: ["signed-out"] });
    await expect(backend.getDiskUse()).rejects.toMatchObject({ code: "unauthenticated" });
    backend.dispose();
  });
});

describe("mock disk area: cleanWorkingFiles", () => {
  it("frees the working size, keeps the rest and tells the owner", async () => {
    const backend = backendOf();
    const before = need(
      need((await backend.getDiskUse()).videos.find((v) => v.videoId === SERUM)).sizes,
    );
    const uses: DiskUse[] = [];
    const libraries: Library[] = [];
    backend.on.diskUseChanged((use) => uses.push(use));
    backend.on.libraryChanged((library) => {
      if (library) libraries.push(library);
    });
    expect(actionsOf(await backend.getLibrary(), SERUM)).toContain("diskCleanup");

    const result = await backend.cleanWorkingFiles({ videoId: SERUM });

    expect(result).toEqual({ freedBytes: before.working, leftover: 0 });
    const after = need((await backend.getDiskUse()).videos.find((v) => v.videoId === SERUM));
    expect(after.sizes).toEqual({ ...before, working: 0, total: before.total - before.working });
    expect(after.measuring).toBe(false);
    expect(uses).toHaveLength(1);
    expect(uses[0]?.videos.find((v) => v.videoId === SERUM)?.sizes?.working).toBe(0);
    expect(libraries).toHaveLength(1);
    expect(actionsOf(need(libraries[0]), SERUM)).not.toContain("diskCleanup");
    expect(actionsOf(await backend.getLibrary(), SERUM)).not.toContain("diskCleanup");
    backend.dispose();
  });

  it("writes the owner's edit log line with the freed size", async () => {
    const backend = backendOf();
    await backend.cleanWorkingFiles({ videoId: SERUM });
    const [line] = (await backend.getEditLog()).entries;
    expect(line).toMatchObject({
      event: "diskCleanup",
      message: "Disk Cleanup freed 12.3 GB",
      videoLabel: "Beauty Channel / Serum Launch",
      userEmail: ADMIN_EMAIL,
    });
    backend.dispose();
  });

  it("keeps what cannot be removed, reports the items and still offers Disk Cleanup", async () => {
    const backend = backendOf();
    const before = need(
      need((await backend.getDiskUse()).videos.find((v) => v.videoId === LIP_BALM)).sizes,
    );
    expect(before.working).toBe(Math.round(6.8 * GB));
    expect(actionsOf(await backend.getLibrary(), LIP_BALM)).toContain("diskCleanup");

    const result = await backend.cleanWorkingFiles({ videoId: LIP_BALM });

    const kept = Math.round(0.4 * GB);
    expect(result).toEqual({ freedBytes: before.working - kept, leftover: 2 });
    const after = need((await backend.getDiskUse()).videos.find((v) => v.videoId === LIP_BALM));
    expect(after.sizes?.working).toBe(kept);
    expect(after.measuring).toBe(false);
    expect(actionsOf(await backend.getLibrary(), LIP_BALM)).toContain("diskCleanup");
    const [line] = (await backend.getEditLog()).entries;
    expect(line?.message).toBe("Disk Cleanup freed 6.4 GB (2 items could not be removed)");
    backend.dispose();
  });

  it("says item for one leftover and puts (by an admin) after it", async () => {
    const admin = backendOf();
    const user = userOf(admin);
    need(admin.world.videos.find((v) => v.folderName === "Lisbon Day 1")).workingFiles = true;
    admin.world.cleanLeftover[LISBON] = { items: 1, bytes: 1 };
    await expect(admin.cleanWorkingFiles({ videoId: LISBON })).resolves.toMatchObject({
      leftover: 1,
    });
    const [line] = (await user.getEditLog()).entries;
    expect(line?.message).toMatch(/ \(1 item could not be removed\) \(by an admin\)$/);
    admin.dispose();
    user.dispose();
  });

  it("refuses a video with an unfinished job, with the server's sentence", async () => {
    const backend = backendOf();
    await backend.reEdit({ videoId: SERUM, text: "Cut the intro.", urgent: false });
    expect(actionsOf(await backend.getLibrary(), SERUM)).not.toContain("diskCleanup");
    await expect(backend.cleanWorkingFiles({ videoId: SERUM })).rejects.toMatchObject({
      code: "conflict",
      message:
        "This video has a job that has not finished. Stop it or wait until it ends, then try again.",
    });
    expect(
      (await backend.getDiskUse()).videos.find((v) => v.videoId === SERUM)?.sizes?.working,
    ).toBeGreaterThan(0);
    backend.dispose();
  });

  it("refuses a video without working files, and a second cleanup", async () => {
    const backend = backendOf();
    await expect(backend.cleanWorkingFiles({ videoId: NIGHT_CREAM })).rejects.toMatchObject({
      code: "conflict",
      message: "There are no working files to delete.",
    });
    await backend.cleanWorkingFiles({ videoId: SERUM });
    await expect(backend.cleanWorkingFiles({ videoId: SERUM })).rejects.toMatchObject({
      code: "conflict",
    });
    backend.dispose();
  });

  it("cleans an archived video too", async () => {
    const backend = backendOf();
    await expect(backend.cleanWorkingFiles({ videoId: OLD_REEL })).resolves.toMatchObject({
      freedBytes: Math.round(1.9 * GB),
    });
    backend.dispose();
  });

  it("answers notFound for a video that does not exist", async () => {
    const backend = backendOf();
    await expect(
      backend.cleanWorkingFiles({ videoId: makeVideoId(ADMIN_CHANNEL_BEAUTY, "Nothing") }),
    ).rejects.toMatchObject({ code: "notFound" });
    backend.dispose();
  });

  it("answers notFound for another user's video, and the other way round for an admin", async () => {
    const admin = backendOf();
    const user = userOf(admin);
    need(admin.world.videos.find((v) => v.folderName === "Lisbon Day 1")).workingFiles = true;
    await expect(user.cleanWorkingFiles({ videoId: SERUM })).rejects.toMatchObject({
      code: "notFound",
    });
    // The admin may clean the user's video; the line lands in the owner's log.
    await expect(admin.cleanWorkingFiles({ videoId: LISBON })).resolves.toMatchObject({
      leftover: 0,
    });
    const [line] = (await user.getEditLog()).entries;
    expect(line).toMatchObject({
      userId: USER_ID,
      userEmail: USER_EMAIL,
      message: expect.stringMatching(/^Disk Cleanup freed .* \(by an admin\)$/) as string,
    });
    user.dispose();
    admin.dispose();
  });

  it("tells the owner of a video, not the admin who cleaned it", async () => {
    const admin = backendOf();
    const user = userOf(admin);
    need(admin.world.videos.find((v) => v.folderName === "Lisbon Day 1")).workingFiles = true;
    await user.getDiskUse();
    const toUser: DiskUse[] = [];
    const toAdmin: DiskUse[] = [];
    user.on.diskUseChanged((use) => toUser.push(use));
    admin.on.diskUseChanged((use) => toAdmin.push(use));
    await admin.cleanWorkingFiles({ videoId: LISBON });
    expect(toUser).toHaveLength(1);
    expect(toAdmin).toHaveLength(0);
    user.dispose();
    admin.dispose();
  });
});

describe("mock disk area: getEditLog", () => {
  const entry = (backend: MockBackend, id: number): EditLogEntry => {
    const found = backend.world.editLog.find((e) => e.id === id);
    if (!found) throw new Error("no entry");
    return found;
  };

  it("answers the user's own entries, newest first", async () => {
    const admin = backendOf();
    const user = userOf(admin);
    const page = await user.getEditLog();
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.entries.every((e) => e.userId === USER_ID)).toBe(true);
    expect(page.entries.map((e) => e.id)).toEqual(
      [...page.entries.map((e) => e.id)].sort((a, b) => b - a),
    );
    expect(page.more).toBe(false);
    user.dispose();
    admin.dispose();
  });

  it("pages with before and limit, and clamps the limit to 500", async () => {
    const backend = backendOf();
    for (let n = 0; n < 650; n += 1) {
      backend.world.editLog.push({
        ...entry(backend, 1),
        id: 1000 + n,
        message: `Line ${String(n)}`,
      });
    }
    const first = await backend.getEditLog();
    expect(first.entries).toHaveLength(100);
    expect(first.more).toBe(true);
    expect(first.entries[0]?.id).toBe(1649);
    const second = await backend.getEditLog({ before: need(first.entries.at(-1)).id });
    expect(second.entries[0]?.id).toBe(need(first.entries.at(-1)).id - 1);
    expect((await backend.getEditLog({ limit: 100_000 })).entries).toHaveLength(500);
    const small = await backend.getEditLog({ limit: 3 });
    expect(small.entries).toHaveLength(3);
    backend.dispose();
  });

  it("lets an admin read another user's entries or everybody's, and nobody else", async () => {
    const admin = backendOf();
    const user = userOf(admin);
    const everybody = await admin.getEditLog({ all: true });
    expect(new Set(everybody.entries.map((e) => e.userEmail))).toEqual(
      new Set([ADMIN_EMAIL, USER_EMAIL]),
    );
    const theirs = await admin.getEditLog({ userId: USER_ID });
    expect(theirs.entries.every((e) => e.userEmail === USER_EMAIL)).toBe(true);
    await expect(admin.getEditLog({ all: true, userId: USER_ID })).rejects.toMatchObject({
      code: "invalidInput",
    });
    await expect(user.getEditLog({ all: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(user.getEditLog({ userId: USER_ID })).rejects.toMatchObject({
      code: "forbidden",
    });
    user.dispose();
    admin.dispose();
  });
});

describe("disk-large scenario", () => {
  it("has big videos, one with a running Re-Edit that cannot be cleaned", async () => {
    const backend = backendOf(["disk-large"]);
    const interview = makeVideoId(ADMIN_CHANNEL_TECH, "Interview Rough Cut");
    expect(actionsOf(await backend.getLibrary(), interview)).not.toContain("diskCleanup");
    await expect(backend.cleanWorkingFiles({ videoId: interview })).rejects.toMatchObject({
      code: "conflict",
    });
    const use = await backend.getDiskUse();
    expect(use.totals.working).toBeGreaterThan(100 * GB);
    backend.dispose();
  });
});

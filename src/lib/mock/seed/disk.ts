/**
 * Seed of the disk area: what each video folder takes (`world.diskSizes`, by video id, the numbers
 * the server's cache would hold) and a few edit log lines, so the Disk Cleanup page and the Edit
 * Log page have something to show. A video without an entry is "measuring": the area measures it
 * on the next tick. Videos that have working files (`MockVideo.workingFiles`) get a working size;
 * the others have none.
 */
import type { DiskSizes } from "../../types";
import { makeVideoId } from "../../videoId";
import { addJob } from "./jobs";
import { makeVideo } from "./library";
import { ADMIN_EMAIL, ADMIN_ID, USER_EMAIL, USER_ID } from "./session";
import { ADMIN_CHANNEL_TECH } from "./workspace";
import type { MockVideo, World } from "../world";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DAY = 86_400_000;
const MINUTE = 60_000;

export function sizesOf(
  parts: Pick<DiskSizes, "working" | "project" | "finals" | "sources">,
): DiskSizes {
  return { ...parts, total: parts.working + parts.project + parts.finals + parts.sources };
}

/**
 * What a video folder of the mock takes, worked out from what the mock knows about it: the A-roll
 * (1.8 GB each), the project, the finals and, when the video has working files, a few GB of them.
 * The size of the working files depends on the folder name, so the page shows different numbers.
 */
export function measureFolder(video: MockVideo): DiskSizes {
  const extra = video.edited ? 600 * MB : 0;
  return sizesOf({
    working: video.workingFiles ? Math.round((1.5 + (video.folderName.length % 7) * 0.9) * GB) : 0,
    project: video.output.project ? 14 * MB : 0,
    finals: video.output.finals.reduce((sum, file) => sum + file.size, 0),
    sources: Math.round(video.arollCount * 1.8 * GB) + extra,
  });
}

/** The sizes the default seed gives to named videos, so the page has a recognisable top. */
const WORKING_BY_NAME: Record<string, number> = {
  "Serum Launch": 12.3 * GB,
  "Lip Balm Haul": 6.8 * GB,
  "Laptop Teardown": 3.1 * GB,
  "Old Reel": 1.9 * GB,
};

export function seedDisk(world: World, now: number): void {
  for (const video of world.videos) {
    const sizes = measureFolder(video);
    const working = WORKING_BY_NAME[video.folderName];
    if (video.workingFiles && working !== undefined) {
      sizes.total += Math.round(working) - sizes.working;
      sizes.working = Math.round(working);
    }
    world.diskSizes[makeVideoId(video.channelId, video.folderName)] = sizes;
    // One video keeps two files the cleanup cannot remove, as a file in use on a share would.
    if (video.folderName === "Lip Balm Haul" && video.workingFiles) {
      world.cleanLeftover[makeVideoId(video.channelId, video.folderName)] = {
        items: 2,
        bytes: Math.round(0.4 * GB),
      };
    }
  }
  seedEditLog(world, now);
}

/** A few lines of history: an edit that ended well, a failed one, an archive and a cleanup. */
function seedEditLog(world: World, now: number): void {
  const lines: Array<{
    ago: number;
    userId: string;
    email: string;
    label: string;
    event: string;
    message: string;
  }> = [
    {
      ago: 9 * DAY + 70 * MINUTE,
      userId: ADMIN_ID,
      email: ADMIN_EMAIL,
      label: "Beauty Channel / Serum Launch",
      event: "started",
      message: "Edit started (Claude Code, Opus)",
    },
    {
      ago: 9 * DAY,
      userId: ADMIN_ID,
      email: ADMIN_EMAIL,
      label: "Beauty Channel / Serum Launch",
      event: "completed",
      message: "Edit finished in 1 h 8 min, cost $2.41",
    },
    {
      ago: 6 * DAY,
      userId: ADMIN_ID,
      email: ADMIN_EMAIL,
      label: "Beauty Channel / Foundation Test",
      event: "failed",
      message: "Edit failed: the model stopped answering",
    },
    {
      ago: 3 * DAY,
      userId: ADMIN_ID,
      email: ADMIN_EMAIL,
      label: "Beauty Channel / Old Reel",
      event: "archived",
      message: "Archived",
    },
    {
      ago: 2 * DAY,
      userId: USER_ID,
      email: USER_EMAIL,
      label: "Travel Diary / Lisbon Day 1",
      event: "started",
      message: "Edit started (Claude Code, Opus)",
    },
    {
      ago: 2 * DAY - 40 * MINUTE,
      userId: USER_ID,
      email: USER_EMAIL,
      label: "Travel Diary / Lisbon Day 1",
      event: "stopped",
      message: "Stopped by the user",
    },
    {
      ago: DAY,
      userId: ADMIN_ID,
      email: ADMIN_EMAIL,
      label: "Tech Reviews / Laptop Teardown",
      event: "diskCleanup",
      message: "Disk Cleanup freed 4.2 GB",
    },
  ];
  for (const line of lines) {
    world.editLog.push({
      id: (world.editLog.at(-1)?.id ?? 0) + 1,
      at: now - line.ago,
      userId: line.userId,
      userEmail: line.email,
      videoLabel: line.label,
      event: line.event,
      message: line.message,
    });
  }
}

/**
 * The `disk-large` scenario: a failed and a stopped edit that left working files behind, six
 * large edited videos, one of them with a Re-Edit running (so it cannot be cleaned now), and two
 * folders the server has not measured yet.
 */
export function addLargeDisk(world: World, now: number): void {
  for (const video of world.videos) {
    if (video.userId !== ADMIN_ID) continue;
    if (video.folderName === "Foundation Test" || video.folderName === "Mascara Quick Look") {
      video.workingFiles = true;
      world.diskSizes[makeVideoId(video.channelId, video.folderName)] = sizesOf({
        working: Math.round(48.6 * GB),
        project: 0,
        finals: 0,
        sources: Math.round(2.4 * GB),
      });
    }
  }
  const large: Array<[string, number, number]> = [
    ["Studio Tour Part 1", 31.4, 4],
    ["Studio Tour Part 2", 27.9, 5],
    ["Drone Footage Cut", 22.2, 6],
    ["Unboxing Marathon", 17.5, 7],
    ["Interview Rough Cut", 9.7, 8],
    ["Desk Setup 2026", 0.4, 9],
  ];
  for (const [folderName, working, daysAgo] of large) {
    const video = makeVideo(
      {
        channelId: ADMIN_CHANNEL_TECH,
        userId: ADMIN_ID,
        folderName,
        daysAgo,
        edited: true,
        finals: working > 20 ? 2 : 1,
      },
      now,
    );
    world.videos.push(video);
    const sizes = measureFolder(video);
    sizes.total += Math.round(working * GB) - sizes.working;
    sizes.working = Math.round(working * GB);
    world.diskSizes[makeVideoId(video.channelId, folderName)] = sizes;
  }
  addJob(
    world,
    {
      channelId: ADMIN_CHANNEL_TECH,
      folderName: "Interview Rough Cut",
      userId: ADMIN_ID,
      kind: "reEdit",
      state: "running",
    },
    now,
  );
  for (const folderName of ["Behind The Scenes", "Gear Comparison"]) {
    world.videos.push(
      makeVideo(
        { channelId: ADMIN_CHANNEL_TECH, userId: ADMIN_ID, folderName, daysAgo: 1, edited: true },
        now,
      ),
    );
  }
}

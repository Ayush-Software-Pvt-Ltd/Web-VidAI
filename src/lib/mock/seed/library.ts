/**
 * The library seed: the folders of the seeded channels, covering what a video row can show.
 * Ready videos are first (the original four keep their names); then no A-roll, an edit with its
 * project, one with finals, a failed and a stopped one (their ended jobs are in `jobs.ts`), an
 * archived one, Short videos and a type override. Active jobs (running, queued, held) are added by
 * the scenarios that need them (`busy`, `queue-full`, `urgent`, `start-delay`).
 */
import { makeVideoId } from "../../videoId";
import { EMPTY_INPUTS, EMPTY_OUTPUT, outputFile, type MockVideo, type World } from "../world";
import { ADMIN_ID, USER_ID } from "./session";
import { ADMIN_CHANNEL_BEAUTY, ADMIN_CHANNEL_TECH, USER_CHANNEL_TRAVEL } from "./workspace";

const DAY = 86_400_000;

export interface VideoSpec {
  channelId: string;
  userId: string;
  folderName: string;
  daysAgo: number;
  detectedType?: "long" | "short" | null;
  typeOverride?: "long" | "short" | null;
  arollCount?: number;
  edited?: boolean;
  finals?: number;
  archivedDaysAgo?: number;
}

/** A video folder of the seed; ids are `<channelId>/<folder name>`. */
export function makeVideo(spec: VideoSpec, now: number): MockVideo {
  const createdAt = now - spec.daysAgo * DAY;
  const output = structuredClone(EMPTY_OUTPUT);
  if (spec.edited === true) {
    output.project = {
      path: `output/${spec.folderName}.hf/index.html`,
      modifiedAt: createdAt + 3_600_000,
    };
    output.thumbnails = [
      outputFile("thumb_1.jpg", "output/thumb_1.jpg", 220_000, createdAt + 3_600_000),
      outputFile("thumb_2.jpg", "output/thumb_2.jpg", 198_000, createdAt + 3_600_000),
    ];
    output.metaFile = "output/meta.txt";
    output.infoFile = "info.txt";
  }
  for (let n = 0; n < (spec.finals ?? 0); n += 1) {
    const name = `${spec.folderName}_final_v${n + 1}.mp4`;
    output.finals.push(
      outputFile(
        name,
        `output/${name}`,
        n === 0 ? 900_000_000 : 3_100_000_000,
        createdAt + 7_200_000,
      ),
    );
    output.newestFinal = `output/${name}`;
  }
  return {
    channelId: spec.channelId,
    userId: spec.userId,
    folderName: spec.folderName,
    createdAt,
    detectedType: spec.detectedType === undefined ? "long" : spec.detectedType,
    typeOverride: spec.typeOverride ?? null,
    arollCount: spec.arollCount ?? 1,
    inputs: { ...EMPTY_INPUTS },
    output,
    archivedAt: spec.archivedDaysAgo === undefined ? null : now - spec.archivedDaysAgo * DAY,
    edited: spec.edited ?? false,
    finalRendered: (spec.finals ?? 0) > 0,
    workingFiles: spec.edited === true,
  };
}

export function seedLibrary(world: World, now: number): void {
  const beauty = (
    folderName: string,
    daysAgo: number,
    rest: Partial<VideoSpec> = {},
  ): VideoSpec => ({
    channelId: ADMIN_CHANNEL_BEAUTY,
    userId: ADMIN_ID,
    folderName,
    daysAgo,
    ...rest,
  });
  const tech = (folderName: string, daysAgo: number, rest: Partial<VideoSpec> = {}): VideoSpec => ({
    channelId: ADMIN_CHANNEL_TECH,
    userId: ADMIN_ID,
    folderName,
    daysAgo,
    ...rest,
  });
  const specs: VideoSpec[] = [
    beauty("Hair Oil Review", 2),
    beauty("Night Cream", 5),
    tech("Phone Camera Test", 1),
    {
      channelId: USER_CHANNEL_TRAVEL,
      userId: USER_ID,
      folderName: "Lisbon Day 1",
      daysAgo: 3,
    },
    beauty("Draft Without Footage", 0, { arollCount: 0, detectedType: null }),
    beauty("Serum Launch", 9, { edited: true }),
    beauty("Lip Balm Haul", 12, { edited: true, finals: 2 }),
    beauty("Foundation Test", 6),
    beauty("Mascara Quick Look", 7),
    beauty("Old Reel", 40, { edited: true, finals: 1, archivedDaysAgo: 3 }),
    beauty("Skincare Short", 4, { detectedType: "short", typeOverride: "long" }),
    tech("Earbuds Short", 2, { detectedType: "short" }),
    tech("Laptop Teardown", 15, { edited: true }),
  ];
  for (const spec of specs) world.videos.push(makeVideo(spec, now));
  for (const video of world.videos) {
    if (video.archivedAt === null) continue;
    const channel = world.channels.find((c) => c.id === video.channelId);
    world.archived.push({
      videoId: makeVideoId(video.channelId, video.folderName),
      channelId: video.channelId,
      channelName: channel?.name ?? "",
      folderName: video.folderName,
      archivedAt: video.archivedAt,
    });
  }
}

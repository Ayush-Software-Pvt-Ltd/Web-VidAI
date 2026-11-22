/**
 * The disk area (SPEC section 13, `server/src/disk/service.js`): `getDiskUse` and
 * `cleanWorkingFiles`, plus the edit log functions of `editLog.ts` (the mock's `getEditLog`).
 *
 * `getDiskUse` lists the signed-in user's own videos (an admin's list is their own too), archived
 * ones included, channel by channel with the newest folder name first, and answers at once with
 * what is known. A video without numbers, or whose numbers no longer fit its working files (a job
 * ended and made some), is `measuring` until the next tick measures it, one video per tick, and
 * `disk-use-changed` then brings the whole list to its owner.
 *
 * `cleanWorkingFiles` refuses another user's video with `notFound` (an admin may clean anybody's),
 * a video with a waiting, running or paused job and a video without working files with `conflict`
 * (the server's sentences); otherwise the working size becomes 0, the owner's edit log gets
 * "Disk Cleanup freed 12.3 GB" (with "(by an admin)" when an admin cleaned a user's video) and
 * the owner is told through `disk-use-changed` and `library-changed` (the video's actions change).
 */
import type { Api } from "../../api";
import { formatBytes, naturalCompare } from "../../format";
import type { CleanResult, DiskSizes, DiskUse, DiskVideo } from "../../types";
import { makeVideoId } from "../../videoId";
import type { MockCtx } from "../ctx";
import { ensureChannelReachable, isActiveState } from "../rules";
import { measureFolder, sizesOf } from "../seed/disk";
import type { MockVideo, World } from "../world";
import { emitLibrary } from "./library";
import { editLogArea } from "./editLog";

const NOT_FOUND = "That video was not found.";
const ACTIVE_JOB =
  "This video has a job that has not finished. Stop it or wait until it ends, then try again.";
const NOTHING_TO_DELETE = "There are no working files to delete.";

/** The users that asked for their sizes: only their videos are measured in the background. */
const listedUsers = new WeakMap<World, Set<string>>();

const idOf = (video: MockVideo) => makeVideoId(video.channelId, video.folderName);

/** The known numbers of a video, `null` while there are none. */
function knownSizes(world: World, video: MockVideo): DiskSizes | null {
  return world.diskSizes[idOf(video)] ?? null;
}

/** Whether the numbers are missing or no longer fit the video (they are made on the next tick). */
function needsMeasuring(world: World, video: MockVideo): boolean {
  const sizes = knownSizes(world, video);
  return sizes === null || sizes.working > 0 !== video.workingFiles;
}

/** The whole `DiskUse` of one user. */
function diskUseOf(world: World, userId: string, now: number): DiskUse {
  const videos: DiskVideo[] = [];
  const totals = sizesOf({ working: 0, project: 0, finals: 0, sources: 0 });
  for (const channel of world.channels.filter((c) => c.userId === userId && c.available)) {
    const folders = world.videos
      .filter((video) => video.channelId === channel.id)
      .sort((a, b) => naturalCompare(b.folderName, a.folderName));
    for (const video of folders) {
      const sizes = knownSizes(world, video);
      if (sizes) {
        totals.working += sizes.working;
        totals.project += sizes.project;
        totals.finals += sizes.finals;
        totals.sources += sizes.sources;
      }
      videos.push({
        videoId: idOf(video),
        channelId: channel.id,
        channelName: channel.name,
        folderName: video.folderName,
        archived: video.archivedAt !== null,
        sizes: sizes ? { ...sizes } : null,
        measuring: needsMeasuring(world, video),
        measuredAt: sizes ? now : null,
      });
    }
  }
  totals.total = totals.working + totals.project + totals.finals + totals.sources;
  return { videos, totals, measuring: videos.some((video) => video.measuring) };
}

export function diskArea(ctx: MockCtx): Partial<Api> {
  const { world } = ctx;

  /** One measuring step: the first video of a listed user whose numbers are missing or stale. */
  const measureNext = (): void => {
    const users = listedUsers.get(world);
    if (!users) return;
    for (const video of world.videos) {
      if (!users.has(video.userId) || !needsMeasuring(world, video)) continue;
      world.diskSizes[idOf(video)] = measureFolder(video);
      ctx.emit("disk-use-changed", diskUseOf(world, video.userId, ctx.clock.now()), {
        userId: video.userId,
      });
      return;
    }
  };
  ctx.ticks.register("disk", measureNext);

  return {
    ...editLogArea(ctx),

    getDiskUse: () =>
      ctx.run(() => {
        const user = ctx.requireUser();
        const users = listedUsers.get(world) ?? new Set<string>();
        users.add(user.id);
        listedUsers.set(world, users);
        return diskUseOf(world, user.id, ctx.clock.now());
      }),

    cleanWorkingFiles: ({ videoId }) =>
      ctx.run((): CleanResult => {
        const user = ctx.requireUser();
        const video = world.videos.find(
          (candidate) =>
            idOf(candidate) === videoId && (user.role === "admin" || candidate.userId === user.id),
        );
        if (!video) throw ctx.errors.notFound(NOT_FOUND);
        ensureChannelReachable(ctx, video.channelId);
        const active = world.jobs.some(
          (job) => job.view.videoId === videoId && isActiveState(job.view.state),
        );
        if (active) throw ctx.errors.conflict(ACTIVE_JOB);
        if (!video.workingFiles) throw ctx.errors.conflict(NOTHING_TO_DELETE);

        const sizes = knownSizes(world, video) ?? measureFolder(video);
        // What the server cannot remove stays, and the folder still holds working files.
        const kept = world.cleanLeftover[videoId] ?? { items: 0, bytes: 0 };
        const keptBytes = Math.min(kept.bytes, sizes.working);
        const freedBytes = sizes.working - keptBytes;
        world.diskSizes[videoId] = sizesOf({ ...sizes, working: keptBytes });
        video.workingFiles = kept.items > 0;
        const leftover = kept.items;

        const owner = world.users.find((candidate) => candidate.id === video.userId);
        const channel = world.channels.find((candidate) => candidate.id === video.channelId);
        const byAdmin = video.userId !== user.id ? " (by an admin)" : "";
        const rest =
          leftover > 0
            ? ` (${leftover} ${leftover === 1 ? "item" : "items"} could not be removed)`
            : "";
        world.editLog.push({
          id: (world.editLog.at(-1)?.id ?? 0) + 1,
          at: ctx.clock.now(),
          userId: video.userId,
          userEmail: owner?.email ?? "",
          videoLabel: `${channel?.name ?? ""} / ${video.folderName}`,
          event: "diskCleanup",
          message: `Disk Cleanup freed ${formatBytes(freedBytes)}${rest}${byAdmin}`,
        });
        ctx.emit("disk-use-changed", diskUseOf(world, video.userId, ctx.clock.now()), {
          userId: video.userId,
        });
        emitLibrary(ctx, video.userId);
        return { freedBytes, leftover };
      }),
  };
}

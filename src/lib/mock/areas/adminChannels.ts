/**
 * The admin's channels (SPEC section 6, "Channels"): `adminListChannels`, `adminCreateChannel`,
 * `adminUpdateChannel` and `adminRemoveChannel`. Only an admin makes, renames, moves and removes
 * channels; every function answers `forbidden` to a user. The rules and sentences follow the spec:
 *
 * - the name is 1 to 60 characters and unique for its owner without regard to letter case
 *   (`conflict`, field `name`); the owner must exist (`notFound`, field `userId`);
 * - the directory must be an existing folder that is not, does not lie inside and does not contain
 *   the server's data directory (`invalidInput`, field `dir`) and does not overlap the directory of
 *   another channel (`conflict`, field `dir`);
 * - the owner and the directory cannot change while a job of the channel's videos waits, runs or
 *   is paused; the same holds for removing the channel (`conflict`);
 * - a new owner gets the channel last in their order, with its videos; unfinished uploads into the
 *   channel are cancelled; jobs, the edit log and finished uploads keep what they say;
 * - a new directory keeps the video rows whose folder of the same name lies in it too; the other
 *   rows go like a video folder that disappeared (jobs, change requests, revisions, uploads);
 * - removing a channel removes its rows only: its folders stay on the disk (`keepOnDisk`);
 * - every change sends `workspace-changed` and `library-changed` to the owner and to the old owner.
 */
import type { Api } from "../../api";
import { ApiError } from "../../errors";
import type { AdminChannel, ChannelVideoType } from "../../types";
import { makeVideoId } from "../../videoId";
import type { MockCtx } from "../ctx";
import { diskFolders, isInside, keepOnDisk, placeOf, realPath } from "../fsModel";
import { checkChannelName, isActiveState } from "../rules";
import type { TimelineSim } from "../timelineEngine";
import { nextId, type MockChannel, type MockUser, type World } from "../world";
import { emitLibrary } from "./library";
import { DATA_MESSAGE, TAKEN_MESSAGE } from "./storage";
import { defaultProfile } from "./workspace";

export const NAME_TAKEN = "This user already has a channel with that name.";
export const CHANNEL_BUSY = "Stop the running edits of this channel's videos first.";
const NO_SUCH_CHANNEL = "That channel was not found.";
const NO_SUCH_USER = "This account does not exist.";
const VIDEO_TYPES: readonly ChannelVideoType[] = ["auto", "long", "short"];

/** Removes video rows and everything that hangs on them, as a video folder that disappeared. */
export function forgetVideos(world: World, videoIds: ReadonlySet<string>): void {
  const jobIds = new Set(
    world.jobs.filter((job) => videoIds.has(job.view.videoId)).map((job) => job.view.id),
  );
  world.jobs = world.jobs.filter((job) => !jobIds.has(job.view.id));
  world.jobLogs = Object.fromEntries(
    Object.entries(world.jobLogs).filter(([id]) => !jobIds.has(id)),
  );
  world.videos = world.videos.filter((v) => !videoIds.has(makeVideoId(v.channelId, v.folderName)));
  world.archived = world.archived.filter((a) => !videoIds.has(a.videoId));
  world.uploads = world.uploads.filter((u) => u.videoId === null || !videoIds.has(u.videoId));
  for (const record of [world.timelines, world.diskSizes, world.cleanLeftover]) {
    for (const id of videoIds) Reflect.deleteProperty(record, id);
  }
}

/** Whether a job of one of the channel's videos waits, runs or is paused. */
export function isBusy(world: World, channelId: string): boolean {
  return world.jobs.some(
    (job) => job.view.videoId.startsWith(`${channelId}/`) && isActiveState(job.view.state),
  );
}

function adminChannelOf(world: World, channel: MockChannel): AdminChannel {
  const owner = world.users.find((user) => user.id === channel.userId);
  return {
    id: channel.id,
    name: channel.name,
    dir: channel.dir,
    userId: channel.userId,
    userEmail: owner?.email ?? "",
    videoType: channel.videoType,
    available: channel.available,
    videoCount: channel.available
      ? world.videos.filter((video) => video.channelId === channel.id).length
      : 0,
    busy: isBusy(world, channel.id),
  };
}

export function adminChannelsArea(ctx: MockCtx): Partial<Api> {
  const { world } = ctx;

  const channelById = (id: string): MockChannel => {
    const found = world.channels.find((c) => c.id === id);
    if (!found) throw ctx.errors.notFound(NO_SUCH_CHANNEL);
    return found;
  };
  const userById = (id: string): MockUser => {
    const found = world.users.find((u) => u.id === id);
    if (!found) throw new ApiError("notFound", NO_SUCH_USER, "userId");
    return found;
  };
  const checkName = (value: string, ownerId: string, exceptId: string | null): string => {
    const checked = checkChannelName(value);
    if ("error" in checked) throw new ApiError("invalidInput", checked.error, "name");
    const taken = world.channels.some(
      (c) =>
        c.userId === ownerId &&
        c.id !== exceptId &&
        c.name.toLowerCase() === checked.name.toLowerCase(),
    );
    if (taken) throw new ApiError("conflict", NAME_TAKEN, "name");
    return checked.name;
  };
  const checkType = (value: ChannelVideoType): void => {
    if (!VIDEO_TYPES.includes(value)) {
      throw new ApiError(
        "invalidInput",
        "The video type must be auto, long or short.",
        "videoType",
      );
    }
  };
  /** The real path of a directory the admin chose, when a channel may live there. */
  const checkDir = (input: string, exceptId: string | null): string => {
    if (typeof input !== "string" || !input.startsWith("/") || input.includes("\0")) {
      throw new ApiError("invalidInput", "Choose a folder on the server.", "dir");
    }
    const dir = realPath(input);
    if (!diskFolders(world).has(dir) || placeOf(world, dir)?.available === false) {
      throw new ApiError("invalidInput", "This folder does not exist.", "dir");
    }
    if (isInside(world.dataDir, dir) || isInside(dir, world.dataDir)) {
      throw new ApiError("invalidInput", DATA_MESSAGE, "dir");
    }
    const overlaps = world.channels.some(
      (c) => c.id !== exceptId && (isInside(c.dir, dir) || isInside(dir, c.dir)),
    );
    if (overlaps) throw new ApiError("conflict", TAKEN_MESSAGE, "dir");
    return dir;
  };
  /** Tells the owners that their channels changed. */
  const changed = (...userIds: string[]) => {
    for (const userId of new Set(userIds)) {
      ctx.emit("workspace-changed", null, { userId });
      emitLibrary(ctx, userId);
    }
  };

  return {
    adminListChannels: () =>
      ctx.run((): AdminChannel[] => {
        ctx.requireAdmin();
        return world.channels
          .map((channel) => adminChannelOf(world, channel))
          .sort((a, b) => a.userEmail.localeCompare(b.userEmail) || a.name.localeCompare(b.name));
      }),

    adminCreateChannel: (input) =>
      ctx.run((): AdminChannel => {
        ctx.requireAdmin();
        const name = checkName(input.name, input.userId, null);
        checkType(input.videoType);
        const owner = userById(input.userId);
        const dir = checkDir(input.dir, null);
        const profile = defaultProfile(world);
        const channel: MockChannel = {
          id: nextId(world, "c0ffee").padEnd(32, "0"),
          userId: owner.id,
          name,
          dir,
          videoType: input.videoType,
          long: structuredClone(profile),
          short: structuredClone(profile),
          available: true,
        };
        world.channels.push(channel);
        changed(owner.id);
        return adminChannelOf(world, channel);
      }),

    adminUpdateChannel: ({ id, update }) =>
      ctx.run((): AdminChannel => {
        ctx.requireAdmin();
        const channel = channelById(id);
        const oldOwner = channel.userId;
        const owner = update.userId === null ? userById(oldOwner) : userById(update.userId);
        const name = checkName(update.name ?? channel.name, owner.id, id);
        if (update.videoType !== null) checkType(update.videoType);
        const dir = update.dir === null ? channel.dir : checkDir(update.dir, id);
        const ownerChanges = owner.id !== oldOwner;
        const dirChanges = dir !== channel.dir;
        if ((ownerChanges || dirChanges) && isBusy(world, id)) {
          throw ctx.errors.conflict(CHANNEL_BUSY);
        }

        if (dirChanges) {
          keepOnDisk(world, channel);
          // The video rows stay for the folders of the same name in the new directory.
          const there = diskFolders(world);
          const gone = new Set(
            world.videos
              .filter((v) => v.channelId === id && !there.has(`${dir}/${v.folderName}`))
              .map((v) => makeVideoId(v.channelId, v.folderName)),
          );
          forgetVideos(world, gone);
          // The files uploaded so far stay in the old directory; part files are removed.
          world.uploads = world.uploads.filter((u) => u.channelId !== id);
          channel.dir = dir;
          channel.available = true;
        }
        if (ownerChanges) {
          // Unfinished uploads are cancelled; finished ones are files and stay.
          world.uploads = world.uploads.filter((u) => u.channelId !== id || u.done);
          channel.userId = owner.id;
          for (const video of world.videos) {
            if (video.channelId !== id) continue;
            video.userId = owner.id;
            const sim = world.timelines[makeVideoId(id, video.folderName)] as
              TimelineSim | undefined;
            if (sim) sim.ownerId = owner.id;
          }
          // Last in the new owner's order.
          world.channels = [...world.channels.filter((c) => c !== channel), channel];
        }
        if (name !== channel.name) {
          channel.name = name;
          for (const entry of world.archived) {
            if (entry.channelId === id) entry.channelName = name;
          }
        }
        if (update.videoType !== null) channel.videoType = update.videoType;
        changed(owner.id, oldOwner);
        return adminChannelOf(world, channel);
      }),

    adminRemoveChannel: ({ id }) =>
      ctx.run(() => {
        ctx.requireAdmin();
        const channel = channelById(id);
        if (isBusy(world, id)) throw ctx.errors.conflict(CHANNEL_BUSY);
        keepOnDisk(world, channel);
        forgetVideos(
          world,
          new Set(
            world.videos
              .filter((v) => v.channelId === id)
              .map((v) => makeVideoId(v.channelId, v.folderName)),
          ),
        );
        world.uploads = world.uploads.filter((u) => u.channelId !== id);
        world.channels = world.channels.filter((c) => c !== channel);
        changed(channel.userId);
        return null;
      }),
  };
}

/**
 * The library area: the videos of the signed-in user's channels with the actions the server
 * offers (`rules.computeActions`), creating videos, the type override, the inputs and archiving.
 * `libraryFor`, `videoViewOf` and `emitLibrary` are shared with the jobs area, which sends
 * `library-changed` when a job changes what a video row shows.
 */
import type { Api } from "../../api";
import type { ArchivedVideo, JobView, Library, VideoInputs, VideoView } from "../../types";
import { makeVideoId } from "../../videoId";
import type { MockCtx } from "../ctx";
import { viewsOf, type QueueClock } from "../queue";
import {
  checkVideoName,
  computeActions,
  ensureChannelReachable,
  isActiveState,
  resolveVideoType,
} from "../rules";
import { EMPTY_INPUTS, EMPTY_OUTPUT, type MockUser, type MockVideo, type World } from "../world";

const NOT_FOUND = "That video was not found.";
const MAX_LINKS_CHARS = 4000;
const MAX_NOTES_CHARS = 20_000;

/** The latest job of a video: an active one, else the one that joined last. */
function latestJob(views: Map<string, JobView>, videoId: string): JobView | null {
  let best: JobView | null = null;
  for (const view of views.values()) {
    if (view.videoId !== videoId) continue;
    const bestActive = best !== null && isActiveState(best.state);
    const active = isActiveState(view.state);
    if (
      best === null ||
      (active && !bestActive) ||
      (active === bestActive && view.joinedAt >= best.joinedAt)
    ) {
      best = view;
    }
  }
  return best;
}

export function videoViewOf(
  world: World,
  video: MockVideo,
  viewer: Pick<MockUser, "role">,
  views: Map<string, JobView>,
): VideoView {
  const id = makeVideoId(video.channelId, video.folderName);
  const channel = world.channels.find((c) => c.id === video.channelId);
  const channelType = channel?.videoType ?? "auto";
  const { videoType, typeSource } = resolveVideoType(
    video.typeOverride,
    channelType,
    video.detectedType,
  );
  const job = latestJob(views, id);
  const uploading = world.uploads.some((u) => u.videoId === id && !u.done);
  return {
    id,
    channelId: video.channelId,
    folderName: video.folderName,
    createdAt: video.createdAt,
    detectedType: video.detectedType,
    typeOverride: video.typeOverride,
    channelType,
    videoType,
    typeSource,
    arollCount: video.arollCount,
    output: video.output,
    edited: video.edited,
    finalRendered: video.finalRendered,
    uploading,
    job,
    actions: computeActions({
      archived: video.archivedAt !== null,
      job,
      edited: video.edited,
      workingFiles: video.workingFiles,
      uploading,
      admin: viewer.role === "admin",
    }),
  };
}

/** The whole library of one user (archived videos are not in it). */
export function libraryFor(world: World, user: MockUser, clock: QueueClock): Library {
  const views = viewsOf(world, clock);
  return {
    channels: world.channels
      .filter((channel) => channel.userId === user.id)
      .map((channel) => ({
        channelId: channel.id,
        available: channel.available,
        // The server lists nothing from a folder it cannot reach.
        videos: channel.available
          ? world.videos
              .filter((v) => v.channelId === channel.id && v.archivedAt === null)
              .map((v) => videoViewOf(world, v, user, views))
          : [],
      })),
  };
}

/** Sends `library-changed` with the user's full library, as the server does. */
export function emitLibrary(ctx: MockCtx, userId: string): void {
  const user = ctx.world.users.find((u) => u.id === userId);
  if (!user) return;
  const clock = { now: ctx.clock.now(), minuteMs: ctx.clock.minuteMs };
  ctx.emit("library-changed", libraryFor(ctx.world, user, clock), { userId });
}

/** The video of a user without looking at the disk, or `notFound` (another user's video does not exist for them). */
function videoRow(ctx: MockCtx, userId: string, videoId: string): MockVideo {
  const found = ctx.world.videos.find(
    (v) => makeVideoId(v.channelId, v.folderName) === videoId && v.userId === userId,
  );
  if (!found) throw ctx.errors.notFound(NOT_FOUND);
  return found;
}

/**
 * The video of a user as the server's `folders.resolveVideo` finds it: `notFound` for another
 * user's video, `conflict` when the folder of its channel cannot be reached.
 */
export function ownVideo(ctx: MockCtx, userId: string, videoId: string): MockVideo {
  const found = videoRow(ctx, userId, videoId);
  ensureChannelReachable(ctx, found.channelId);
  return found;
}

function checkInputs(ctx: MockCtx, inputs: VideoInputs): VideoInputs {
  const slot = (value: number) => Number.isInteger(value) && value >= 0 && value < 5;
  if (!slot(inputs.promptSlot) || !slot(inputs.styleSlot)) {
    throw ctx.errors.invalidInput("Choose one of the five prompts and styles.");
  }
  if (inputs.productLinks.length > MAX_LINKS_CHARS) {
    throw ctx.errors.invalidInput(`Keep the product links under ${MAX_LINKS_CHARS} characters.`);
  }
  if (inputs.notes.length > MAX_NOTES_CHARS) {
    throw ctx.errors.invalidInput(`Keep the notes under ${MAX_NOTES_CHARS} characters.`);
  }
  return { ...inputs };
}

export function libraryArea(ctx: MockCtx): Partial<Api> {
  const { world } = ctx;
  const clock = (): QueueClock => ({ now: ctx.clock.now(), minuteMs: ctx.clock.minuteMs });
  return {
    getLibrary: () =>
      ctx.run(() => {
        const user = ctx.requireUser();
        if (world.libraryFails) throw ctx.errors.io("The library could not be read.");
        return libraryFor(world, user, clock());
      }),

    createVideo: ({ channelId, name }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        const channel = world.channels.find((c) => c.id === channelId && c.userId === user.id);
        if (!channel) throw ctx.errors.notFound("That channel was not found.");
        ensureChannelReachable(ctx, channel.id);
        const checked = checkVideoName(name);
        if ("error" in checked) throw ctx.errors.invalidInput(checked.error);
        const folderName = checked.name;
        const taken = world.videos.some(
          (v) =>
            v.channelId === channelId && v.folderName.toLowerCase() === folderName.toLowerCase(),
        );
        if (taken)
          throw ctx.errors.conflict("A video with this name already exists in this channel.");
        world.videos.push({
          channelId,
          folderName,
          userId: user.id,
          createdAt: ctx.clock.now(),
          detectedType: null,
          typeOverride: null,
          arollCount: 0,
          inputs: { ...EMPTY_INPUTS },
          output: structuredClone(EMPTY_OUTPUT),
          archivedAt: null,
          edited: false,
          finalRendered: false,
          workingFiles: false,
        });
        emitLibrary(ctx, user.id);
        return { id: makeVideoId(channelId, folderName), channelId, folderName };
      }),

    setVideoTypeOverride: ({ videoId, videoType }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        const video = ownVideo(ctx, user.id, videoId);
        video.typeOverride = videoType;
        emitLibrary(ctx, user.id);
        return videoViewOf(world, video, user, viewsOf(world, clock()));
      }),

    getVideoInputs: ({ videoId }) =>
      ctx.run(() => ownVideo(ctx, ctx.requireUser().id, videoId).inputs),

    setVideoInputs: ({ videoId, inputs }) =>
      ctx.run(() => {
        const video = ownVideo(ctx, ctx.requireUser().id, videoId);
        video.inputs = checkInputs(ctx, inputs);
        return video.inputs;
      }),

    archiveVideo: ({ videoId }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        const video = ownVideo(ctx, user.id, videoId);
        if (video.archivedAt !== null) throw ctx.errors.conflict("This video is already archived.");
        const active = world.jobs.some(
          (job) => job.view.videoId === videoId && isActiveState(job.view.state),
        );
        if (active) {
          throw ctx.errors.conflict(
            "This video has an edit in progress. Stop it before archiving the video.",
          );
        }
        video.archivedAt = ctx.clock.now();
        const channel = world.channels.find((c) => c.id === video.channelId);
        world.archived.push({
          videoId,
          channelId: video.channelId,
          channelName: channel?.name ?? "",
          folderName: video.folderName,
          archivedAt: video.archivedAt,
        });
        emitLibrary(ctx, user.id);
        return null;
      }),

    unarchiveVideo: ({ videoId }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        // The server only flips the row here: it does not look at the channel's folder.
        const video = videoRow(ctx, user.id, videoId);
        if (video.archivedAt === null) throw ctx.errors.conflict("This video is not archived.");
        video.archivedAt = null;
        world.archived = world.archived.filter((a) => a.videoId !== videoId);
        emitLibrary(ctx, user.id);
        return null;
      }),

    getArchived: () =>
      ctx.run((): ArchivedVideo[] => {
        const user = ctx.requireUser();
        // A channel that cannot be reached lists nothing, as in the library.
        const mine = new Set(
          world.videos
            .filter(
              (v) =>
                v.userId === user.id &&
                v.archivedAt !== null &&
                world.channels.find((c) => c.id === v.channelId)?.available !== false,
            )
            .map((v) => makeVideoId(v.channelId, v.folderName)),
        );
        return world.archived
          .filter((a) => mine.has(a.videoId))
          .sort((a, b) => b.archivedAt - a.archivedAt);
      }),
  };
}

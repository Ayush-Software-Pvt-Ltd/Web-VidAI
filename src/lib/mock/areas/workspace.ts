/**
 * The workspace area: the settings the screens need, the harness and readiness reads, and the
 * channels (create, change, remove, order, export and import) with the server's rules and refusals.
 */
import type { Api } from "../../api";
import type {
  Channel,
  ChannelProfile,
  ChannelsDocument,
  ChannelsDocumentEntry,
  ChannelVideoType,
} from "../../types";
import type { MockCtx } from "../ctx";
import { CHANNEL_SLOTS, MAX_IMPORTED_CHANNELS, checkChannelName, profileProblem } from "../rules";
import { isActiveState } from "../rules";
import { emitLibrary } from "./library";
import { nextId, type MockChannel, type World } from "../world";

/** Where a user's own channel folders are made when the person does not choose a parent. */
export const MEDIA_ROOT = "/var/lib/vidai/media";
const VIDEO_TYPES: readonly ChannelVideoType[] = ["auto", "long", "short"];
const FORMAT = "vidai-channels";

export function channelOf({ userId: _owner, ...channel }: MockChannel): Channel {
  return channel;
}

/** The server's sentence for a path outside every storage folder (`storage/paths.js`). */
const OUTSIDE_MESSAGE = "This folder is outside the storage folders the admin allows.";

/** Whether `inner` lies below `outer` (not the same folder). */
function isInside(outer: string, inner: string): boolean {
  return inner.startsWith(`${outer}/`);
}

export function personalFolder(userId: string): string {
  return `${MEDIA_ROOT}/${userId}`;
}

/** A name as a folder name: no separators, no leading dot. */
export function folderNameFor(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return cleaned === "" ? "Channel" : cleaned;
}

/** The profile of a new channel: the default prompt in slot 1, the rest empty. */
export function defaultProfile(world: World): ChannelProfile {
  const slots = (what: string, first: string) =>
    Array.from({ length: CHANNEL_SLOTS }, (_unused, index) => ({
      name: index === 0 ? "Default" : `${what} ${index + 1}`,
      text: index === 0 ? first : "",
    }));
  return { prompts: slots("Prompt", world.defaultPrompt), styles: slots("Style", "") };
}

/** Everything the server refuses about a document, as the first message (`parseDocument`). */
function parseDocument(ctx: MockCtx, document: unknown): ChannelsDocumentEntry[] {
  const bad = (message: string) => ctx.errors.invalidInput(message);
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isRecord(document) || document["format"] !== FORMAT)
    throw bad("This is not a VidAI channels file.");
  const version = document["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw bad("This channels file has no valid version.");
  }
  if (version > 1) throw bad("This file was made by a newer version of VidAI.");
  const list = document["channels"];
  if (!Array.isArray(list)) throw bad("This channels file has no channels.");
  if (list.length > MAX_IMPORTED_CHANNELS) {
    throw bad(`A channels file can have at most ${MAX_IMPORTED_CHANNELS} channels.`);
  }
  const seen = new Set<string>();
  return list.map((raw: unknown, index) => {
    if (!isRecord(raw)) throw bad(`Channel ${index + 1} of the file is not valid.`);
    const checked = checkChannelName(typeof raw["name"] === "string" ? raw["name"] : "");
    if ("error" in checked) throw bad(`Channel ${index + 1} of the file: ${checked.error}`);
    const key = checked.name.toLowerCase();
    if (seen.has(key)) throw bad(`The file has the channel "${checked.name}" twice.`);
    seen.add(key);
    const videoType = raw["videoType"] as ChannelVideoType;
    if (!VIDEO_TYPES.includes(videoType)) {
      throw bad(`The video type of "${checked.name}" must be auto, long or short.`);
    }
    const long = raw["long"] as ChannelProfile;
    const short = raw["short"] as ChannelProfile;
    for (const [profile, field] of [
      [long, "long profile"],
      [short, "short profile"],
    ] as const) {
      const problem = isRecord(profile)
        ? profileProblem(profile)
        : `The ${field} must be an object.`;
      if (problem) throw bad(`"${checked.name}": ${problem}`);
    }
    return { name: checked.name, videoType, long, short };
  });
}

export function workspaceArea(ctx: MockCtx): Partial<Api> {
  const { world } = ctx;
  const own = (userId: string, id: string): MockChannel => {
    const found = world.channels.find((c) => c.id === id && c.userId === userId);
    if (!found) throw ctx.errors.notFound("That channel was not found.");
    return found;
  };
  const nameTaken = (userId: string, name: string, exceptId: string | null) =>
    world.channels.some(
      (c) =>
        c.userId === userId && c.id !== exceptId && c.name.toLowerCase() === name.toLowerCase(),
    );
  const changed = (userId: string) => emitLibrary(ctx, userId);

  return {
    getWorkspace: () =>
      ctx.run(() => {
        const user = ctx.requireUser();
        if (world.workspaceFails !== null) throw ctx.errors.io(world.workspaceFails);
        const { setup, maxUploadGb, maxEditsPerUser, startDelayMinutes } = world.adminSettings;
        return {
          channels: world.channels.filter((c) => c.userId === user.id).map(channelOf),
          settings: { setup, maxUploadGb, maxEditsPerUser, startDelayMinutes },
          readiness: null,
        };
      }),
    getHarness: () =>
      ctx.run(() => {
        ctx.requireUser();
        return world.harnessPublic;
      }),
    getReadiness: () =>
      ctx.run(() => {
        const user = ctx.requireUser();
        return user.role === "admin" ? world.readinessAdmin : world.readinessUser;
      }),

    createChannel: (input) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        const checked = checkChannelName(input.name);
        if ("error" in checked) throw ctx.errors.invalidInput(checked.error);
        if (!VIDEO_TYPES.includes(input.videoType)) {
          throw ctx.errors.invalidInput("The video type must be auto, long or short.");
        }
        if (nameTaken(user.id, checked.name, null)) {
          throw ctx.errors.conflict("You already have a channel with this name.");
        }
        // The server's rules (`server/src/channels.js` `assertUsableDirectory`, `storage/paths.js`).
        const roots = [MEDIA_ROOT, ...world.adminSettings.storageRoots];
        const within = (dir: string) => roots.some((root) => dir === root || isInside(root, dir));
        let dir: string;
        if (input.location.kind === "link") {
          dir = input.location.dir.replace(/\/+$/, "");
          if (!within(dir)) throw ctx.errors.forbidden(OUTSIDE_MESSAGE);
        } else {
          const parent = (input.location.parent ?? personalFolder(user.id)).replace(/\/+$/, "");
          if (!within(parent)) throw ctx.errors.forbidden(OUTSIDE_MESSAGE);
          const given = input.location.folderName?.trim();
          dir = `${parent}/${given ? folderNameFor(given) : folderNameFor(checked.name)}`;
          if (world.channels.some((c) => c.dir === dir)) {
            throw ctx.errors.conflict("A folder with this name already exists there.");
          }
        }
        // A storage folder, or somebody's personal folder in the media folder, is never a channel.
        const personal =
          isInside(MEDIA_ROOT, dir) && !dir.slice(MEDIA_ROOT.length + 1).includes("/");
        if (roots.includes(dir) || personal) {
          throw ctx.errors.invalidInput(
            "A storage folder cannot be a channel itself. Choose or make a folder inside it.",
          );
        }
        // Not the same as, inside or around a channel of anybody.
        if (
          world.channels.some((c) => c.dir === dir || isInside(c.dir, dir) || isInside(dir, c.dir))
        ) {
          throw ctx.errors.conflict("This folder already belongs to a channel.");
        }
        const profile = defaultProfile(world);
        const channel: MockChannel = {
          id: nextId(world, "c0ffee").padEnd(32, "0"),
          userId: user.id,
          name: checked.name,
          dir,
          videoType: input.videoType,
          long: structuredClone(profile),
          short: structuredClone(profile),
          available: true,
        };
        world.channels.push(channel);
        changed(user.id);
        return channelOf(channel);
      }),

    updateChannel: ({ id, update }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        const channel = own(user.id, id);
        let name = channel.name;
        if (update.name !== null) {
          const checked = checkChannelName(update.name);
          if ("error" in checked) throw ctx.errors.invalidInput(checked.error);
          if (nameTaken(user.id, checked.name, id)) {
            throw ctx.errors.conflict("You already have a channel with this name.");
          }
          name = checked.name;
        }
        if (update.videoType !== null && !VIDEO_TYPES.includes(update.videoType)) {
          throw ctx.errors.invalidInput("The video type must be auto, long or short.");
        }
        for (const [profile, field] of [
          [update.long, "long profile"],
          [update.short, "short profile"],
        ] as const) {
          const problem = profile === null ? null : profileProblem(profile);
          if (problem) throw ctx.errors.invalidInput(`The ${field}: ${problem}`);
        }
        channel.name = name;
        if (update.videoType !== null) channel.videoType = update.videoType;
        if (update.long !== null) channel.long = structuredClone(update.long);
        if (update.short !== null) channel.short = structuredClone(update.short);
        changed(user.id);
        return channelOf(channel);
      }),

    removeChannel: ({ id }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        own(user.id, id);
        const active = world.jobs.some(
          (job) => job.view.videoId.startsWith(`${id}/`) && isActiveState(job.view.state),
        );
        if (active) {
          throw ctx.errors.conflict("Stop the running edits of this channel's videos first.");
        }
        world.channels = world.channels.filter((c) => c.id !== id);
        const gone = new Set(
          world.jobs.filter((job) => job.view.videoId.startsWith(`${id}/`)).map((j) => j.view.id),
        );
        world.jobs = world.jobs.filter((job) => !gone.has(job.view.id));
        world.jobLogs = Object.fromEntries(
          Object.entries(world.jobLogs).filter(([jobId]) => !gone.has(jobId)),
        );
        world.videos = world.videos.filter((v) => v.channelId !== id);
        world.archived = world.archived.filter((a) => a.channelId !== id);
        world.uploads = world.uploads.filter((u) => !u.videoId.startsWith(`${id}/`));
        changed(user.id);
        return null;
      }),

    reorderChannels: ({ ids }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        for (const id of ids) own(user.id, id);
        const mine = world.channels.filter((c) => c.userId === user.id);
        if (new Set(ids).size !== ids.length || ids.length !== mine.length) {
          throw ctx.errors.invalidInput(
            "The new order must list each of your channels exactly once.",
          );
        }
        const sorted = ids.map((id) => own(user.id, id));
        let next = 0;
        world.channels = world.channels.map((c) =>
          c.userId === user.id ? (sorted[next++] as MockChannel) : c,
        );
        return sorted.map(channelOf);
      }),

    getDefaultPrompt: () =>
      ctx.run(() => {
        ctx.requireUser();
        return world.defaultPrompt;
      }),

    exportChannels: () =>
      ctx.run((): ChannelsDocument => {
        const user = ctx.requireUser();
        return {
          format: FORMAT,
          version: 1,
          exportedAt: new Date(ctx.clock.now()).toISOString(),
          channels: world.channels
            .filter((c) => c.userId === user.id)
            .map(({ name, videoType, long, short }) => ({ name, videoType, long, short })),
        };
      }),

    importChannels: ({ document }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        const entries = parseDocument(ctx, document);
        let updated = 0;
        let created = 0;
        for (const entry of entries) {
          const current = world.channels.find(
            (c) => c.userId === user.id && c.name.toLowerCase() === entry.name.toLowerCase(),
          );
          if (current) {
            current.videoType = entry.videoType;
            current.long = structuredClone(entry.long);
            current.short = structuredClone(entry.short);
            updated += 1;
            continue;
          }
          let dir = `${personalFolder(user.id)}/${folderNameFor(entry.name)}`;
          for (let n = 2; world.channels.some((c) => c.dir === dir); n += 1) {
            dir = `${personalFolder(user.id)}/${folderNameFor(entry.name)} ${n}`;
          }
          world.channels.push({
            id: nextId(world, "c0ffee").padEnd(32, "0"),
            userId: user.id,
            name: entry.name,
            dir,
            videoType: entry.videoType,
            long: structuredClone(entry.long),
            short: structuredClone(entry.short),
            available: true,
          });
          created += 1;
        }
        changed(user.id);
        return { updated, created };
      }),
  };
}

/**
 * The workspace area: the settings the screens need, the harness and readiness reads, and the
 * user's own channel functions: the video type, prompts and styles (`updateChannel`), the order,
 * export and import (which only updates channels of the same name). Making, renaming, moving and
 * removing channels is the admin's (`adminChannels.ts`).
 */
import type { Api } from "../../api";
import type {
  Channel,
  ChannelProfile,
  ChannelsDocument,
  ChannelsDocumentEntry,
  ChannelVideoType,
  ImportResult,
} from "../../types";
import type { MockCtx } from "../ctx";
import { CHANNEL_SLOTS, MAX_IMPORTED_CHANNELS, checkChannelName, profileProblem } from "../rules";
import { emitLibrary } from "./library";
import type { MockChannel, World } from "../world";

const VIDEO_TYPES: readonly ChannelVideoType[] = ["auto", "long", "short"];
const FORMAT = "vidai-channels";

export function channelOf({ userId: _owner, ...channel }: MockChannel): Channel {
  return channel;
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

    updateChannel: ({ id, update }) =>
      ctx.run(() => {
        const user = ctx.requireUser();
        const channel = own(user.id, id);
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
        if (update.videoType !== null) channel.videoType = update.videoType;
        if (update.long !== null) channel.long = structuredClone(update.long);
        if (update.short !== null) channel.short = structuredClone(update.short);
        changed(user.id);
        return channelOf(channel);
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
      ctx.run((): ImportResult => {
        const user = ctx.requireUser();
        const entries = parseDocument(ctx, document);
        let updated = 0;
        const skipped: string[] = [];
        for (const entry of entries) {
          const current = world.channels.find(
            (c) => c.userId === user.id && c.name.toLowerCase() === entry.name.toLowerCase(),
          );
          if (!current) {
            skipped.push(entry.name);
            continue;
          }
          current.videoType = entry.videoType;
          current.long = structuredClone(entry.long);
          current.short = structuredClone(entry.short);
          updated += 1;
        }
        if (updated > 0) changed(user.id);
        return { updated, skipped };
      }),
  };
}

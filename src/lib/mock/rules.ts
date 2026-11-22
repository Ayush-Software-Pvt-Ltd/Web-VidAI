/**
 * The rules the server applies, as pure functions: which actions a video offers (a mirror of
 * `server/src/library/actions.js`), which type a video has and which names are allowed. The UI
 * never derives these; the mock area modules call them to answer like the server.
 */
import type { ChannelVideoType, JobState, TypeSource, VideoAction, VideoType } from "../types";
import type { MockCtx } from "./ctx";

/**
 * Throws `notReady` with the sentence of the first problem when new work cannot start, as the
 * server's `harness.ensureReady({})` (`server/src/agents/readiness.js`) does for every job that
 * starts an agent. The server asks with the plain user's words, also when an admin starts it.
 */
export function ensureReady(ctx: Pick<MockCtx, "world" | "errors">): void {
  const readiness = ctx.world.readinessUser;
  if (readiness.problem !== null) {
    throw ctx.errors.notReady(readiness.message ?? "This server cannot start edits yet.");
  }
}

/** The sentence of `folders.channelDir` (`server/src/storage/videoFolder.js`). */
export const CHANNEL_UNREACHABLE = "This channel's folder cannot be reached right now.";

/**
 * Throws `conflict` when the folder of the channel cannot be reached (an unplugged drive), as the
 * server's `folders.channelDir` does for everything that needs the channel's folder: a new video,
 * a video's view, inputs, type, Archive, start an edit, Re-Edit, Render Final, the timeline, an
 * upload and its chunks, Disk Cleanup. Not refused: Stop, Pause and Continue of a job, the job
 * log, listing the channel (it has no videos), Unarchive, Cancel upload, the channel's own
 * settings. A channel that does not exist passes (the callers answer `notFound` themselves).
 */
export function ensureChannelReachable(
  ctx: Pick<MockCtx, "world" | "errors">,
  channelId: string,
): void {
  const channel = ctx.world.channels.find((c) => c.id === channelId);
  if (channel && !channel.available) throw ctx.errors.conflict(CHANNEL_UNREACHABLE);
}

const ACTIVE_STATES: readonly JobState[] = ["queued", "running", "pausing", "paused", "stopping"];

/** Whether a job in this state is still going (it has not ended). */
export function isActiveState(state: JobState | null | undefined): boolean {
  return state !== null && state !== undefined && ACTIVE_STATES.includes(state);
}

/** What `computeActions` needs to know about a video and the person asking. */
export interface ActionFacts {
  archived: boolean;
  /** The video's latest job (active, else the newest ended one). */
  job: { state: JobState; startsAt: number | null } | null;
  /** The video has a review project. */
  edited: boolean;
  /** The video has working files Disk Cleanup could delete. */
  workingFiles: boolean;
  /** An upload into the video is running. */
  uploading: boolean;
  /** The one asking is an admin (only they get Start now). */
  admin: boolean;
}

/** Which actions a video offers, in the order the row shows them. */
export function computeActions(facts: ActionFacts): VideoAction[] {
  if (facts.archived) return ["unarchive"];
  const state = facts.job?.state ?? null;
  const heldByDelay = facts.job?.startsAt !== null && facts.job?.startsAt !== undefined;
  const { edited } = facts;
  const actions: VideoAction[] = [];
  const idle: VideoAction[] = edited ? ["reEdit", "renderFinal"] : ["startEdit"];

  switch (state) {
    case "queued":
      if (heldByDelay && facts.admin) actions.push("startNow");
      actions.push("stop");
      break;
    case "running":
      actions.push("pause", "stop");
      break;
    case "pausing":
    case "stopping":
      break;
    case "paused":
      actions.push("continue", "stop");
      break;
    case "failed":
      actions.push("continue", ...idle);
      break;
    default:
      actions.push(...idle);
  }

  const active = isActiveState(state);
  if (edited) actions.push("review");
  actions.push("upload");
  if (!active && facts.workingFiles) actions.push("diskCleanup");
  if (!active && (edited || state === "failed")) actions.push("archive");

  return facts.uploading ? actions.filter((action) => action !== "startEdit") : actions;
}

/** The type of a video: the override, else the channel's, else the detected one, else Long. */
export function resolveVideoType(
  typeOverride: VideoType | null,
  channelType: ChannelVideoType,
  detected: VideoType | null,
): { videoType: VideoType; typeSource: TypeSource } {
  if (typeOverride !== null) return { videoType: typeOverride, typeSource: "override" };
  if (channelType !== "auto") return { videoType: channelType, typeSource: "channel" };
  if (detected !== null) return { videoType: detected, typeSource: "detected" };
  return { videoType: "long", typeSource: "assumed" };
}

/** Names the editing folder keeps for itself (SPEC section 2): a video cannot have them. */
export function isReservedChannelEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return name.startsWith("CLAUDE_VE") || lower === "style" || lower === "memory.md";
}

export const MAX_CHANNEL_NAME_CHARS = 60;
export const MAX_VIDEO_NAME_CHARS = 120;
export const CHANNEL_SLOTS = 5;
export const MAX_SLOT_TEXT_CHARS = 20_000;
export const MAX_IMPORTED_CHANNELS = 100;
export const RE_EDIT_MAX_CHARS = 8000;

/** A channel name trimmed, or the message why it is not valid. */
export function checkChannelName(value: string): { name: string } | { error: string } {
  const name = value.trim();
  if (name.length < 1 || name.length > MAX_CHANNEL_NAME_CHARS) {
    return { error: `A channel name must have 1 to ${MAX_CHANNEL_NAME_CHARS} characters.` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { error: "A channel name cannot contain control characters." };
  }
  return { name };
}

/** A video folder name trimmed, or the message why it is not valid. */
export function checkVideoName(value: string): { name: string } | { error: string } {
  const name = value.trim();
  if (name === "") return { error: "The name cannot be empty." };
  if (name.length > MAX_VIDEO_NAME_CHARS) {
    return { error: `The name can have at most ${MAX_VIDEO_NAME_CHARS} characters.` };
  }
  // eslint-disable-next-line no-control-regex
  if (name === "." || name === ".." || /[/\\:\u0000]/.test(name) || name.startsWith(".")) {
    return { error: "This name is not allowed. Use letters, digits, spaces and dashes." };
  }
  if (isReservedChannelEntry(name)) {
    return { error: "This name is reserved. Choose another name for the video." };
  }
  return { name };
}

/** The message why a profile is not valid, or `null` (mirrors `validateProfile`). */
export function profileProblem(value: {
  prompts: { name: string; text: string }[];
  styles: { name: string; text: string }[];
}): string | null {
  for (const [list, label] of [
    [value.prompts, "Prompt"],
    [value.styles, "Style"],
  ] as const) {
    if (list.length !== CHANNEL_SLOTS) {
      return `A profile needs exactly ${CHANNEL_SLOTS} ${label.toLowerCase()}s.`;
    }
    for (const [index, slot] of list.entries()) {
      if (slot.name.trim() === "") return `${label} ${index + 1} needs a name and a text.`;
      if (slot.name.length > 40 || slot.text.length > MAX_SLOT_TEXT_CHARS) {
        return `${label} ${index + 1} is too long.`;
      }
    }
  }
  return null;
}

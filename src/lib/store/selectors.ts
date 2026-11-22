/**
 * Selectors many screens use. The plain functions take the data of a resource (so they work on
 * anything the screen already holds); the `select...` ones take the whole state, for
 * `useAppState(selectSelectedVideo)`. Presentation lookups only: no business rules.
 */
import { channelIdOf } from "../videoId";
import type {
  Channel,
  ChannelLibrary,
  JobState,
  JobView,
  Library,
  QueueEntry,
  QueueSummary,
  QueueView,
  VideoView,
  Workspace,
} from "../types";
import type { AppState } from "./state";

/** The latest job of a video in a library, if any. */
export function findJob(library: Library | null, videoId: string): JobView | null {
  return findVideo(library, videoId)?.job ?? null;
}

/** The video with this id, or `null` (unknown, archived, or the library is not loaded). */
export function findVideo(library: Library | null, videoId: string): VideoView | null {
  const channel = findChannelLibrary(library, channelIdOf(videoId));
  return channel?.videos.find((video) => video.id === videoId) ?? null;
}

/** The library entry of a channel (its videos and whether its folder is readable). */
export function findChannelLibrary(
  library: Library | null,
  channelId: string | null,
): ChannelLibrary | null {
  if (channelId === null) return null;
  return library?.channels.find((channel) => channel.channelId === channelId) ?? null;
}

/** The channel with this id among the user's channels, or `null`. */
export function findChannel(
  source: Workspace | readonly Channel[] | null,
  channelId: string | null,
): Channel | null {
  if (source === null || channelId === null) return null;
  const channels = "channels" in source ? source.channels : source;
  return channels.find((channel) => channel.id === channelId) ?? null;
}

/** The queue entry of a job of the user, or `null`. */
export function findQueueEntry(queue: QueueView | null, jobId: string): QueueEntry | null {
  return queue?.jobs.find((entry) => entry.job.id === jobId) ?? null;
}

/** States that hold a slot of a queue (SPEC section 8); paused and queued jobs do not. */
const HOLDING: readonly JobState[] = ["running", "pausing", "stopping"];

/** Whether a job in this state holds a slot of its queue. */
export function holdsSlot(state: JobState): boolean {
  return HOLDING.includes(state);
}

export interface JobCounts {
  /** Jobs holding a slot (running, pausing, stopping). */
  running: number;
  /** Jobs waiting in a line. */
  waiting: number;
}

/**
 * How many of the user's own jobs run and wait, over all three lines (the sidebar status). Zero
 * while the queue is not loaded.
 */
export function ownJobCounts(queue: QueueView | null): JobCounts {
  let running = 0;
  let waiting = 0;
  for (const { job } of queue?.jobs ?? []) {
    if (holdsSlot(job.state)) running += 1;
    else if (job.state === "queued") waiting += 1;
  }
  return { running, waiting };
}

/** The totals of the lines for everybody (no names), summed over all three lines. */
export function lineTotals(queue: QueueView | null): JobCounts {
  let running = 0;
  let waiting = 0;
  for (const line of (queue?.queues ?? []) as readonly QueueSummary[]) {
    running += line.running;
    waiting += line.waiting;
  }
  return { running, waiting };
}

/** How many of the user's own jobs hold a slot of the edit line (for the per-user limit). */
export function ownRunningEdits(queue: QueueView | null): number {
  return (queue?.jobs ?? []).filter(({ job }) => job.queue === "edits" && holdsSlot(job.state))
    .length;
}

export const selectSelectedVideo = (state: AppState): VideoView | null =>
  state.selectedVideoId === null ? null : findVideo(state.library.data, state.selectedVideoId);

export const selectSelectedChannel = (state: AppState): Channel | null =>
  findChannel(state.workspace.data, state.selectedChannelId);

export const selectOwnJobCounts = (state: AppState): JobCounts => ownJobCounts(state.queue.data);

/** The signed-in user's channels (empty until the workspace is loaded). */
export const selectChannels = (state: AppState): readonly Channel[] =>
  state.workspace.data?.channels ?? NO_CHANNELS;
const NO_CHANNELS: readonly Channel[] = [];

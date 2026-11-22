/**
 * Pure derivations for the main window: which videos match the search and the filter, how they
 * are ordered, and the sidebar counts. Presentation only; which actions a video
 * offers always comes from the backend (`VideoView.actions`).
 */
import { naturalCompare } from "@/lib/format";
import { statusRank, videoStatus } from "@/lib/status";
import type { Channel, ChannelLibrary, JobState, Library, VideoView } from "@/lib/types";
import { ACTIVE_JOB_STATES } from "@/lib/types";
import type { JobCounts } from "@/lib/store";

export type LibraryFilter = "all" | "toEdit" | "inProgress" | "edited";

export const FILTER_OPTIONS: readonly { value: LibraryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "toEdit", label: "To edit" },
  { value: "inProgress", label: "In progress" },
  { value: "edited", label: "Edited" },
];

const ACTIVE = new Set<JobState>(ACTIVE_JOB_STATES);

/** The video has a queued, running, pausing, paused or stopping job. */
export function hasActiveJob(video: Pick<VideoView, "job">): boolean {
  return video.job !== null && ACTIVE.has(video.job.state);
}

/**
 * The three filter buckets are mutually exclusive: a video with an active job is "In progress",
 * otherwise it is "Edited" when a review project or a final render exists, else "To edit".
 * The sidebar counts use the same buckets (`channelCounts`).
 */
export function filterBucket(
  video: Pick<VideoView, "job" | "edited" | "finalRendered">,
): Exclude<LibraryFilter, "all"> {
  if (hasActiveJob(video)) return "inProgress";
  return video.edited || video.finalRendered ? "edited" : "toEdit";
}

export function matchesFilter(video: VideoView, filter: LibraryFilter): boolean {
  return filter === "all" || filterBucket(video) === filter;
}

/** Lower case, Unicode-normalized, so Devanagari typed in either composition matches. */
function normalize(text: string): string {
  return text.normalize("NFC").toLocaleLowerCase();
}

/** Splits a search query into normalized words; an empty array matches everything. */
export function searchTerms(query: string): string[] {
  return normalize(query)
    .split(/\s+/)
    .filter((term) => term !== "");
}

/** Every term must occur somewhere in the video folder name. */
export function matchesSearch(video: Pick<VideoView, "folderName">, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const name = normalize(video.folderName);
  return terms.every((term) => name.includes(term));
}

/** Videos still to edit in a channel (the number shown in the sidebar). */
export function toEditCount(channel: Pick<ChannelLibrary, "videos">): number {
  return channel.videos.filter((v) => filterBucket(v) === "toEdit").length;
}

/** Something in the channel is being worked on by an agent right now. */
export function isChannelLive(channel: Pick<ChannelLibrary, "videos">): boolean {
  return channel.videos.some((v) => videoStatus(v).live);
}

export interface ChannelCounts {
  /** No output yet and no active job. */
  notEdited: number;
  /** An active job of any kind (queued, running, pausing, paused, stopping). */
  editing: number;
  /** Edited or final rendered, with no active job. */
  edited: number;
  /** Videos whose job failed; also counted above by their output, they never add a fourth bucket. */
  failed: number;
}

/**
 * The sidebar counts of a channel's listed videos (SPEC section 9). The first three partition the
 * videos, like the filter buckets; a failed video counts by what it has on disk (Not edited
 * without output, Edited with a review project) and is also reported in `failed`.
 */
export function channelCounts(videos: readonly VideoView[]): ChannelCounts {
  const counts: ChannelCounts = { notEdited: 0, editing: 0, edited: 0, failed: 0 };
  for (const v of videos) {
    const bucket = filterBucket(v);
    if (bucket === "inProgress") counts.editing++;
    else if (bucket === "edited") counts.edited++;
    else counts.notEdited++;
    if (v.job?.state === "failed") counts.failed++;
  }
  return counts;
}

export type SortKey = "name" | "age" | "status";

/** `asc` is A-Z for Name, oldest first for Age, and the Status order below. */
export interface VideoSort {
  key: SortKey;
  dir: "asc" | "desc";
}

export const DEFAULT_SORT: VideoSort = { key: "age", dir: "desc" };

export const SORT_OPTIONS: readonly { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "age", label: "Age" },
  { key: "status", label: "Status" },
];

/** The direction a key starts in when picked: A-Z, newest first, and the Status order. */
export function firstDir(key: SortKey): VideoSort["dir"] {
  return key === "age" ? "desc" : "asc";
}

/** What clicking a sort item does: the active one flips, another starts in its first direction. */
export function nextSort(current: VideoSort, key: SortKey): VideoSort {
  if (current.key !== key) return { key, dir: firstDir(key) };
  return { key, dir: current.dir === "asc" ? "desc" : "asc" };
}

/** Words for a sort, e.g. "A to Z" (tooltips and screen readers). */
export function sortWords({ key, dir }: VideoSort): string {
  if (key === "name") return dir === "asc" ? "A to Z" : "Z to A";
  if (key === "age") return dir === "desc" ? "newest first" : "oldest first";
  return dir === "asc" ? "attention first" : "rendered first";
}

/** Newest folder first; equal times in descending natural name order ("112 x" before "18 x"). */
function byAgeDesc(a: VideoView, b: VideoView): number {
  return b.createdAt - a.createdAt || naturalCompare(b.folderName, a.folderName);
}

const PRIMARY: Record<SortKey, (a: VideoView, b: VideoView) => number> = {
  name: (a, b) => naturalCompare(a.folderName, b.folderName),
  age: (a, b) => -byAgeDesc(a, b),
  status: (a, b) => statusRank(a) - statusRank(b),
};

/** Ties (equal status, or the same name in two channels) show the newest folder first. */
export function sortVideos(videos: readonly VideoView[], { key, dir }: VideoSort): VideoView[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...videos].sort((a, b) => sign * PRIMARY[key](a, b) || byAgeDesc(a, b));
}

export interface ListModel {
  /** The videos to show, filtered and sorted (all channels together for All Channels). */
  videos: VideoView[];
  /** Channel name by channel id; rows show it only when `showChannel`. */
  channelNames: ReadonlyMap<string, string>;
  /** The names of the channels the list shows videos of (the picked one, else all), in order. */
  scopeNames: readonly string[];
  /** All Channels is selected: rows are labeled "Channel / Video". */
  showChannel: boolean;
  /** Number of videos in scope before search and filter. */
  total: number;
}

export interface ListQuery {
  /** The user's channels (names for the rows, in the user's order). */
  channels: readonly Pick<Channel, "id" | "name">[];
  /** `null` is All Channels. */
  channelId: string | null;
  query: string;
  filter: LibraryFilter;
  sort?: VideoSort;
}

/**
 * The rows of the video list: one flat list, sorted as a whole. With All Channels selected it
 * holds the videos of every channel.
 */
export function buildListModel(
  library: Library,
  { channels, channelId, query, filter, sort = DEFAULT_SORT }: ListQuery,
): ListModel {
  // Only the user's own channels are listed (a library entry of a channel they do not have in
  // their workspace, for example one just removed, is not shown).
  const own = new Set(channels.map((c) => c.id));
  const scope = library.channels.filter(
    (c) => own.has(c.channelId) && (channelId === null || c.channelId === channelId),
  );
  const terms = searchTerms(query);
  const all = scope.flatMap((c) => c.videos);
  const videos = sortVideos(
    all.filter((v) => matchesFilter(v, filter) && matchesSearch(v, terms)),
    sort,
  );
  return {
    videos,
    channelNames: new Map(channels.map((c) => [c.id, c.name])),
    scopeNames: channels.filter((c) => channelId === null || c.id === channelId).map((c) => c.name),
    showChannel: channelId === null,
    total: all.length,
  };
}

/** "2 running, 1 waiting", or `null` when nothing runs or waits. */
export function jobSummary(counts: JobCounts): string | null {
  const parts: string[] = [];
  if (counts.running > 0) parts.push(`${counts.running} running`);
  if (counts.waiting > 0) parts.push(`${counts.waiting} waiting`);
  return parts.length > 0 ? parts.join(", ") : null;
}

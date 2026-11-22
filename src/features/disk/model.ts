/**
 * What the Disk Cleanup page shows, worked out from the two things the store has: the server's
 * `DiskUse` (sizes per video) and the library (the video's `actions`, which say whether the
 * working files can be deleted now). The page never decides that by itself.
 */
import { formatBytes, pluralize } from "@/lib/format";
import { findVideo } from "@/lib/store";
import { ACTIVE_JOB_STATES, type DiskUse, type DiskVideo, type Library } from "@/lib/types";

/** The server's sentence for a video with a waiting, running or paused job (`disk/service.js`). */
export const ACTIVE_JOB_TEXT =
  "This video has a job that has not finished. Stop it or wait until it ends, then try again.";

/** Shown when the library says "not now" without an unfinished job (the numbers are out of date). */
export const NOT_NOW_TEXT = "There are no working files to delete right now.";

/** How many videos the confirmation lists by name; more are only counted. */
export const LIST_LIMIT = 5;

/** What happened to one video in the last cleanup. */
export type CleanOutcome =
  { ok: true; freedBytes: number; leftover: number } | { ok: false; message: string };

export interface DiskRow {
  videoId: string;
  channelId: string;
  channelName: string;
  folderName: string;
  archived: boolean;
  /** Bytes of working files; `null` while the folder has not been measured yet. */
  working: number | null;
  /** Bytes of the whole folder; `null` while it has not been measured yet. */
  total: number | null;
  measuring: boolean;
  /** When the edit last changed (the project or the last job); `null` when unknown. */
  editedAt: number | null;
  /** The server offers Disk Cleanup for this video now. */
  cleanable: boolean;
  /** Why it cannot be cleaned now; `null` when it can. */
  blocked: string | null;
  outcome: CleanOutcome | null;
}

export interface ChannelRows {
  channelId: string;
  channelName: string;
  rows: DiskRow[];
  /** Working bytes of the rows that were measured. */
  working: number;
}

function rowOf(video: DiskVideo, library: Library | null, outcome: CleanOutcome | null): DiskRow {
  const live = findVideo(library, video.videoId);
  // An archived video is not in the library; the server decides when it is asked.
  const cleanable = live === null ? true : live.actions.includes("diskCleanup");
  const active =
    live?.job !== null &&
    live?.job !== undefined &&
    (ACTIVE_JOB_STATES as readonly string[]).includes(live.job.state);
  return {
    videoId: video.videoId,
    channelId: video.channelId,
    channelName: video.channelName,
    folderName: video.folderName,
    archived: video.archived,
    working: video.sizes?.working ?? null,
    total: video.sizes?.total ?? null,
    measuring: video.measuring,
    editedAt: live ? (live.output.project?.modifiedAt ?? live.job?.endedAt ?? null) : null,
    cleanable,
    blocked: cleanable ? null : active ? ACTIVE_JOB_TEXT : NOT_NOW_TEXT,
    outcome,
  };
}

/**
 * The rows of the page, per channel. A video is listed when it has working files, when its folder
 * is not measured yet, or when it was cleaned in this visit (so its result stays readable). In a
 * channel the largest working size comes first and unmeasured folders last; the channel with the
 * most working files comes first.
 */
export function channelRows(
  diskUse: DiskUse,
  library: Library | null,
  outcomes: Readonly<Record<string, CleanOutcome>>,
): ChannelRows[] {
  const byChannel = new Map<string, ChannelRows>();
  for (const video of diskUse.videos) {
    const outcome = outcomes[video.videoId] ?? null;
    if (video.sizes !== null && video.sizes.working === 0 && outcome === null) continue;
    const row = rowOf(video, library, outcome);
    const group = byChannel.get(video.channelId) ?? {
      channelId: video.channelId,
      channelName: video.channelName,
      rows: [],
      working: 0,
    };
    group.rows.push(row);
    group.working += row.working ?? 0;
    byChannel.set(video.channelId, group);
  }
  const groups = [...byChannel.values()];
  for (const group of groups) {
    group.rows.sort(
      (a, b) =>
        (b.working ?? -1) - (a.working ?? -1) ||
        a.folderName.localeCompare(b.folderName, undefined, { numeric: true }),
    );
  }
  return groups.sort((a, b) => b.working - a.working || a.channelName.localeCompare(b.channelName));
}

/** The rows that can be chosen: the server offers the cleanup and there is something to delete. */
export function selectable(row: DiskRow): boolean {
  return row.cleanable && row.outcome === null && (row.working ?? 0) > 0;
}

/** The sum of the working files of rows, in bytes. */
export function workingSum(rows: readonly DiskRow[]): number {
  return rows.reduce((sum, row) => sum + (row.working ?? 0), 0);
}

/** The button's text: it names the count and the sum, for example "Delete working files: 3 videos, 22.2 GB". */
export function deleteLabel(rows: readonly DiskRow[]): string {
  if (rows.length === 0) return "Delete working files";
  return `Delete working files: ${pluralize(rows.length, "video")}, ${formatBytes(workingSum(rows))}`;
}

/** The summary line after a run, for example "Freed 18.4 GB from 2 videos." */
export function summaryOf(outcomes: readonly CleanOutcome[]): {
  tone: "success" | "warning" | "danger";
  text: string;
} {
  const done = outcomes.filter((o): o is Extract<CleanOutcome, { ok: true }> => o.ok);
  const failed = outcomes.length - done.length;
  const freed = done.reduce((sum, o) => sum + o.freedBytes, 0);
  if (done.length === 0) {
    return {
      tone: "danger",
      text:
        failed === 1
          ? "The working files were not deleted. The reason is shown under the video."
          : "No working files were deleted. The reasons are shown under the videos.",
    };
  }
  const freedText = `Freed ${formatBytes(freed)} from ${pluralize(done.length, "video")}.`;
  return failed === 0
    ? { tone: "success", text: freedText }
    : {
        tone: "warning",
        text: `${freedText} ${pluralize(failed, "video")} could not be cleaned. The reasons are shown under ${failed === 1 ? "it" : "them"}.`,
      };
}

/** The result line of one video. */
export function outcomeText(outcome: CleanOutcome): string {
  if (!outcome.ok) return outcome.message;
  const freed = `Freed ${formatBytes(outcome.freedBytes)}.`;
  return outcome.leftover > 0
    ? `${freed} ${pluralize(outcome.leftover, "item")} could not be removed.`
    : freed;
}

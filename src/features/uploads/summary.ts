import { formatBytes, formatDuration, pluralize } from "@/lib/format";
import { isRunning, isUnfinished, type UploadItem } from "./uploadStore";

export interface UploadSummary {
  text: string;
  tone: "neutral" | "danger";
}

/** The whole-number percent of what the server has of `size` (never 100 before the end). */
export function percentOf(received: number, size: number): number {
  if (size <= 0) return 0;
  return Math.min(99, Math.floor((received / size) * 100));
}

/**
 * What a video row says about its uploads: "Uploading 2 files, 43%", "Upload paused, 1 file, 43%"
 * or "1 upload failed". `null` when there is nothing to say. `serverSaysUploading` is the video's
 * `uploading` flag: when it is true and this tab knows no upload (they were started elsewhere or
 * before the browser's storage was cleared), the row still says that something is unfinished.
 */
export function summarize(
  items: readonly UploadItem[],
  serverSaysUploading: boolean,
): UploadSummary | null {
  const unfinished = items.filter(isUnfinished);
  if (unfinished.length > 0) {
    const received = unfinished.reduce((sum, item) => sum + item.received, 0);
    const size = unfinished.reduce((sum, item) => sum + item.size, 0);
    const count = pluralize(unfinished.length, "file");
    const percent = percentOf(received, size);
    return {
      text: unfinished.some(isRunning)
        ? `Uploading ${count}, ${percent}%`
        : `Upload paused, ${count}, ${percent}%`,
      tone: "neutral",
    };
  }
  const failed = items.filter((item) => item.phase === "failed").length;
  if (failed > 0) return { text: `${pluralize(failed, "upload")} failed`, tone: "danger" };
  if (serverSaysUploading) return { text: "Upload not finished", tone: "neutral" };
  return null;
}

/** The line under the bar: percent, sizes, speed and time left while sending, else the state. */
export function statusText(item: UploadItem): string {
  const sizes = `${formatBytes(item.received)} of ${formatBytes(item.size)}`;
  const percent = percentOf(item.received, item.size);
  switch (item.phase) {
    case "preparing":
      return "Checking the file";
    case "waiting":
      return item.received > 0 ? `Waiting for a free place, ${sizes}` : "Waiting for a free place";
    case "sending": {
      const parts = [`${percent}%`, sizes];
      if (item.bytesPerSecond > 0) {
        parts.push(`${formatBytes(item.bytesPerSecond)}/s`);
        parts.push(
          `${formatDuration(((item.size - item.received) / item.bytesPerSecond) * 1000)} left`,
        );
      }
      return parts.join(" - ");
    }
    case "paused":
      return `Paused at ${percent}% - ${sizes}`;
    case "interrupted":
      return `Paused at ${percent}% - choose the same file again to continue`;
    case "done":
      return `Uploaded - ${formatBytes(item.size)}`;
    case "failed":
      return item.error ?? "The upload failed.";
  }
}

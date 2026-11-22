/**
 * The place in a video row for the progress of files that are still arriving (SPEC section 6,
 * Uploads): "Uploading 2 files, 43%" in the row's second line, right after the "Uploading" status
 * pill. It says nothing for a video the server does not list as uploading. The text comes from
 * the uploads of this browser tab (`@/features/uploads`).
 */
import { useVideoUploads, summarize } from "@/features/uploads";
import { cn } from "@/lib/cn";
import type { VideoView } from "@/lib/types";

export interface RowUploadSlotProps {
  video: VideoView;
}

export function RowUploadSlot({ video }: RowUploadSlotProps) {
  const items = useVideoUploads(video.id);
  if (!video.uploading) return null;
  const summary = summarize(items, true);
  if (summary === null) return null;
  return (
    <span
      data-upload-summary
      className={cn(
        "min-w-0 truncate text-sm tabular",
        summary.tone === "danger" ? "text-danger" : "text-fg-muted",
      )}
    >
      {summary.text}
    </span>
  );
}

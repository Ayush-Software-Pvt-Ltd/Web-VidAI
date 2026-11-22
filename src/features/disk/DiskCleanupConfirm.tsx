import { ConfirmDialog } from "@/components/ui";
import { formatBytes, pluralize } from "@/lib/format";
import { LIST_LIMIT } from "./model";

/** What the confirmation says about one video. */
export interface ConfirmVideo {
  videoId: string;
  channelName: string;
  folderName: string;
  /** Bytes of working files that deleting frees. */
  bytes: number;
}

export interface DiskCleanupConfirmProps {
  /** The videos to clean; the dialog is closed when there are none. */
  videos: readonly ConfirmVideo[];
  onOpenChange: (open: boolean) => void;
  /** Runs the cleanup; the dialog shows a spinner until it resolves, then closes. */
  onConfirm: () => Promise<void>;
}

/** What stays and what the next edit costs, as SPEC section 13 words it. */
export const KEPT_TEXT =
  "The timeline, the project and rendered videos stay. A later Re-Edit takes longer because working files are made again.";

/**
 * The confirmation of Disk Cleanup (SPEC section 13): names the video (or lists the videos when
 * there are few, counts them when there are many) and the size, and says what stays. Esc and
 * Cancel close it; focus starts on Cancel, so Enter alone deletes nothing.
 */
export function DiskCleanupConfirm({ videos, onOpenChange, onConfirm }: DiskCleanupConfirmProps) {
  const sum = videos.reduce((total, video) => total + video.bytes, 0);
  const size = formatBytes(sum);
  const [only] = videos;
  const listed = videos.length > 1 && videos.length <= LIST_LIMIT;
  return (
    <ConfirmDialog
      open={videos.length > 0}
      onOpenChange={onOpenChange}
      tone="danger"
      title={videos.length > 1 ? "Delete working files of these videos?" : "Delete working files?"}
      description={
        <>
          {only && videos.length === 1 ? (
            <span className="block">
              <span className="font-medium text-fg" dir="auto">
                {only.folderName}
              </span>{" "}
              will lose its working files. This frees {size}.
            </span>
          ) : (
            <span className="block">
              {listed
                ? `${pluralize(videos.length, "video")} will lose their working files. This frees ${size}:`
                : `The working files of ${pluralize(videos.length, "video")} will be deleted. This frees ${size}.`}
            </span>
          )}
          {listed && (
            <span className="mt-2 block rounded-md bg-muted px-3 py-1.5 text-sm">
              {videos.map((video) => (
                <span
                  key={video.videoId}
                  className="flex items-baseline justify-between gap-3 py-0.5"
                >
                  <span className="min-w-0 truncate text-fg" dir="auto">
                    {video.folderName}
                  </span>
                  <span className="shrink-0 tabular-nums">{formatBytes(video.bytes)}</span>
                </span>
              ))}
            </span>
          )}
          <span className="mt-2 block">{KEPT_TEXT}</span>
          <span className="mt-2 block">Your footage is not touched.</span>
        </>
      }
      confirmLabel="Delete Working Files"
      onConfirm={onConfirm}
    />
  );
}

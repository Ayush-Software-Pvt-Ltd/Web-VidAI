import { Button, Dialog } from "@/components/ui";
import { useAppState } from "@/lib/appEnv";
import { findVideo } from "@/lib/store";
import type { UploadTarget } from "@/lib/types";
import { folderNameOf } from "@/lib/videoId";
import { UploadArea } from "./UploadArea";

/**
 * Upload Files (SPEC section 16): names the `upload` folder of a video or of a channel, says that a
 * prompt can name the files, lists what is already in the folder and takes new files. It is opened
 * from a video's menu and from a channel's menu in the sidebar. Closing it never stops an upload:
 * they belong to the uploads controller.
 */
export function UploadFilesDialog({
  target,
  onClose,
}: {
  target: UploadTarget;
  onClose: () => void;
}) {
  const videoName = useAppState((s) =>
    target.kind === "video"
      ? (findVideo(s.library.data, target.videoId)?.folderName ?? folderNameOf(target.videoId))
      : null,
  );
  const channelName = useAppState((s) =>
    target.kind === "channel"
      ? (s.workspace.data?.channels.find((c) => c.id === target.channelId)?.name ?? null)
      : null,
  );
  const name = videoName ?? channelName;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="lg"
      title="Upload Files"
      description={<span dir="auto">The upload folder of {name}</span>}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">
          A prompt can name these files, for example &quot;upload/logo.png&quot;.
        </p>
        <UploadArea target={target} />
      </div>
    </Dialog>
  );
}

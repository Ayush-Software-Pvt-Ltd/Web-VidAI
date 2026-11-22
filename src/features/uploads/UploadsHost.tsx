import { useEffect } from "react";
import { useStore } from "zustand";
import { useJobsEnv } from "@/features/jobs";
import { useSession } from "@/lib/appEnv";
import { useUploads } from "./env";
import { UploadFilesDialog } from "./UploadFilesDialog";

/**
 * Mounted once by the main window. It owns what must outlive every dialog: it tells the uploads
 * controller whose tab this is (so unfinished uploads of a reloaded page come back as "choose the
 * same file again"), asks before the page is left while bytes are moving, and shows the Upload
 * Files dialog of a video (`uploadFor` of the jobs controller) or of a channel (`dialog` of the
 * uploads controller).
 */
export function UploadsHost() {
  const controller = useUploads();
  const { controller: jobs } = useJobsEnv();
  const userId = useSession()?.id ?? null;
  const channelDialog = useStore(controller.state, (s) => s.dialog);
  const uploadFor = useStore(jobs.state, (s) => s.uploadFor);

  useEffect(() => {
    void controller.setUser(userId);
  }, [controller, userId]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!controller.hasRunning()) return;
      event.preventDefault();
      // Older browsers need a value; none of them shows our text.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [controller]);

  if (userId === null) return null;
  if (channelDialog !== null) {
    return <UploadFilesDialog target={channelDialog} onClose={controller.closeDialog} />;
  }
  if (uploadFor !== null) {
    return (
      <UploadFilesDialog
        target={{ kind: "video", videoId: uploadFor }}
        onClose={jobs.closeUpload}
      />
    );
  }
  return null;
}

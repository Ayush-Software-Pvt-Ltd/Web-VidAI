import { useEffect } from "react";
import { useStore } from "zustand";
import { useJobsEnv } from "@/features/jobs";
import { useSession } from "@/lib/appEnv";
import { useUploads } from "./env";
import { NewVideoDialog, type DialogStep } from "./NewVideoDialog";

/**
 * Mounted once by the main window. It owns what must outlive every dialog: it tells the uploads
 * controller whose tab this is (so unfinished uploads of a reloaded page come back as "choose the
 * same file again"), asks before the page is left while bytes are moving, and shows the New Video
 * dialog or the Upload files dialog of a row (`uploadFor` of the jobs controller).
 */
export function UploadsHost() {
  const controller = useUploads();
  const { controller: jobs } = useJobsEnv();
  const userId = useSession()?.id ?? null;
  const newVideo = useStore(controller.state, (s) => s.newVideo);
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
  if (newVideo !== null) {
    const step: DialogStep = newVideo.created
      ? { kind: "files", videoId: newVideo.created.id, created: true }
      : { kind: "name", channelId: newVideo.channelId };
    return (
      <NewVideoDialog
        key={newVideo.created ? "files" : "name"}
        step={step}
        onClose={controller.closeNewVideo}
      />
    );
  }
  if (uploadFor !== null) {
    return (
      <NewVideoDialog
        step={{ kind: "files", videoId: uploadFor, created: false }}
        onClose={jobs.closeUpload}
      />
    );
  }
  return null;
}

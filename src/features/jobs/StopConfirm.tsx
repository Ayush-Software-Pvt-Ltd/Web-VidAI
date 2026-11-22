import { ConfirmDialog } from "@/components/ui";
import { jobProgram } from "./agent";
import type { StopDialog } from "./controller";
import { stopConsequence } from "./describe";
import { useJobsEnv } from "./env";
import { useLiveVideo } from "./hooks";

/** The confirmation of Stop (SPEC section 8): says what stays and what is put back. */
export function StopConfirm({ dialog }: { dialog: StopDialog }) {
  const { controller } = useJobsEnv();
  const video = useLiveVideo(dialog.video);
  const job = video.job;
  const queued = job?.state === "queued";
  const render = job?.kind === "render";
  const later = job ? stopConsequence(job, video.edited) : "";
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) controller.close();
      }}
      tone="danger"
      title={queued ? "Remove from the queue?" : render ? "Stop rendering?" : "Stop editing?"}
      description={
        <>
          <span className="font-medium text-fg" dir="auto">
            {video.folderName}
          </span>{" "}
          {queued
            ? "has not started yet and will not start."
            : `stops now, and ${jobProgram(job)} ends everything it was running.`}{" "}
          {later}
        </>
      }
      confirmLabel={render ? "Stop Rendering" : "Stop Editing"}
      cancelLabel={queued ? "Keep in Queue" : render ? "Keep Rendering" : "Keep Editing"}
      onConfirm={controller.confirmStop}
    />
  );
}

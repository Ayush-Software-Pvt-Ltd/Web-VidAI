/**
 * Host for the job sheets and dialogs (SPEC sections 8 and 16): Start Editing, Re-Edit, Render
 * Final and the Stop confirmation. Mounted once in the main window; `runJobAction` opens them.
 * The Timeline screen opens Render Final by itself with `RenderFinalSheet`.
 */
import { useStore } from "zustand";
import { useJobsEnv } from "./env";
import { ReEditSheet } from "./ReEditSheet";
import { RenderFinalSheet } from "./RenderFinalSheet";
import { StartEditingSheet } from "./StartEditingSheet";
import { StopConfirm } from "./StopConfirm";

export function JobDialogs() {
  const { controller } = useJobsEnv();
  const dialog = useStore(controller.state, (s) => s.dialog);
  switch (dialog?.kind) {
    case "start":
      return <StartEditingSheet key={dialog.video.id} dialog={dialog} />;
    case "reEdit":
      return <ReEditSheet key={dialog.video.id} dialog={dialog} />;
    case "renderFinal":
      return (
        <RenderFinalSheet
          key={dialog.video.id}
          videoId={dialog.video.id}
          open
          onOpenChange={(open) => {
            if (!open) controller.close();
          }}
        />
      );
    case "stop":
      return <StopConfirm key={dialog.video.id} dialog={dialog} />;
    case undefined:
      return null;
  }
}

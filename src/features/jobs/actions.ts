import {
  Archive,
  ArchiveRestore,
  Clapperboard,
  FastForward,
  HardDrive,
  Pause,
  PencilLine,
  Play,
  Square,
  StepForward,
  Upload,
  View,
  type LucideIcon,
} from "lucide-react";
import { useStore } from "zustand";
import { ACTION_LABELS } from "@/lib/status";
import type { VideoAction, VideoView } from "@/lib/types";
import { useJobsEnv } from "./env";

/**
 * How the page shows one action the server offers (`VideoView.actions`). The server decides which
 * actions a video has and in which order; this table only gives each its words, icon and weight.
 *
 * - `tone`: `primary` is the action that gets the accent colour where emphasis is on, `quiet` a
 *   shortcut that stays calm (a ghost button in rows), `neutral` the rest.
 * - `placement`: `button` actions are buttons in `JobActionButtons`; `menu` actions are the rare
 *   ones a row keeps in its "more" menu (`menuActionsOf`), so a row never grows a long button row.
 *
 * No action has a keyboard shortcut: SPEC section 16 names none, and a row has no focus of its own
 * to receive one.
 */
export interface ActionSpec {
  label: string;
  icon: LucideIcon;
  tone: "primary" | "neutral" | "quiet";
  placement: "button" | "menu";
}

export const ACTION_SPECS: Record<VideoAction, ActionSpec> = {
  startEdit: { label: ACTION_LABELS.startEdit, icon: Play, tone: "primary", placement: "button" },
  pause: { label: ACTION_LABELS.pause, icon: Pause, tone: "neutral", placement: "button" },
  continue: {
    label: ACTION_LABELS.continue,
    icon: StepForward,
    tone: "primary",
    placement: "button",
  },
  stop: { label: ACTION_LABELS.stop, icon: Square, tone: "neutral", placement: "button" },
  reEdit: { label: ACTION_LABELS.reEdit, icon: PencilLine, tone: "neutral", placement: "button" },
  review: { label: ACTION_LABELS.review, icon: View, tone: "neutral", placement: "button" },
  renderFinal: {
    label: ACTION_LABELS.renderFinal,
    icon: Clapperboard,
    tone: "neutral",
    placement: "button",
  },
  startNow: {
    label: ACTION_LABELS.startNow,
    icon: FastForward,
    tone: "quiet",
    placement: "button",
  },
  archive: { label: ACTION_LABELS.archive, icon: Archive, tone: "neutral", placement: "button" },
  upload: { label: ACTION_LABELS.upload, icon: Upload, tone: "neutral", placement: "menu" },
  diskCleanup: {
    label: ACTION_LABELS.diskCleanup,
    icon: HardDrive,
    tone: "neutral",
    placement: "menu",
  },
  unarchive: {
    label: ACTION_LABELS.unarchive,
    icon: ArchiveRestore,
    tone: "neutral",
    placement: "menu",
  },
};

/**
 * The wording of an action for this video: a final render has no session to pause, continue or
 * stop editing, so its buttons say what they do ("Stop Rendering", "Render Again").
 */
export function actionLabel(video: Pick<VideoView, "job">, action: VideoAction): string {
  if (video.job?.kind === "render") {
    if (action === "stop") return "Stop Rendering";
    if (action === "continue") return "Render Again";
  }
  return ACTION_SPECS[action].label;
}

/** The actions of a video that are buttons, in the server's order (Start now first). */
export function buttonActionsOf(video: Pick<VideoView, "actions">): VideoAction[] {
  const buttons = video.actions.filter((a) => ACTION_SPECS[a].placement === "button");
  return [...buttons.filter((a) => a === "startNow"), ...buttons.filter((a) => a !== "startNow")];
}

/** The actions of a video that belong in a row's menu, in the server's order. */
export function menuActionsOf(video: Pick<VideoView, "actions">): VideoAction[] {
  return video.actions.filter((a) => ACTION_SPECS[a].placement === "menu");
}

/**
 * Runs one row action for a video (SPEC section 8). This is the only entry point the library
 * uses for the action buttons: Start Editing, Re-Edit and Render Final open their sheet, Stop
 * asks for confirmation, Pause, Continue and Start now run right away, Review opens the Timeline,
 * Disk Cleanup its page and Upload asks the upload dialog's owner (`JobsState.uploadFor`). All
 * feedback is handled by the jobs controller, so callers never deal with errors. While a command
 * for the video is in flight, further calls for that video are ignored.
 */
export function useRunJobAction(): (video: VideoView, action: VideoAction) => void {
  return useJobsEnv().controller.runJobAction;
}

/**
 * The action whose command is in flight for a video, or `null`. Action buttons use it to show a
 * spinner on that button (`<Button loading={pending === action}>`) and disable the others.
 */
export function usePendingJobAction(videoId: string): VideoAction | null {
  const { controller } = useJobsEnv();
  return useStore(controller.state, (s) => s.pending[videoId] ?? null);
}

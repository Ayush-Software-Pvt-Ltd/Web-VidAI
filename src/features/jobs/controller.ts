/**
 * The jobs controller: the one place that runs job commands (SPEC section 8) and owns the state of
 * the job sheets. `runJobAction` opens a sheet, asks for confirmation or runs the command; what
 * went wrong ends up in the sheet (a refusal of Start Editing, Re-Edit or Render Final stays
 * visible there) or in a toast (pause, continue, stop, start now, archive), so callers never
 * handle failures themselves.
 *
 * The sheet state (including what the user typed) lives here rather than in components, so a
 * sheet survives the main window being replaced for a moment (for example a visit to Admin) and
 * comes back with the text intact.
 *
 * Which actions a video offers is decided by the server (`VideoView.actions`); the controller only
 * carries one out. The ids are typed apart (`commands.ts`): job commands take a `JobId`, video
 * commands a `VideoId`.
 */
import { createStore, type StoreApi } from "zustand";
import { toast } from "@/components/ui";
import { requestDiskCleanup } from "@/features/disk";
import type { Api } from "@/lib/api";
import { toApiError, type ApiError } from "@/lib/errors";
import { findVideo, type AppStore } from "@/lib/store";
import type { RenderResolution, VideoAction, VideoView } from "@/lib/types";
import { jobCommands, jobIdOf, videoIdOf, type JobCommands } from "./commands";
import { startSlots } from "./describe";
import { changesProblem, normalizeLinks, productLinksProblem } from "./validation";

export { findVideo };

interface DialogBase {
  /** The video as it was when the sheet opened; components prefer the live one from the library. */
  video: VideoView;
  /** True after a submit attempt, so validation errors show only once they are useful. */
  showErrors: boolean;
  submitting: boolean;
  /** The server's refusal of the last submit, shown in the sheet; `null` when there is none. */
  error: string | null;
}

export interface StartDialog extends DialogBase {
  kind: "start";
  productLinks: string;
  notes: string;
  /** The chosen prompt and style slot; the sheet falls back when a slot is no longer offered. */
  promptSlot: number;
  styleSlot: number;
  /** The Urgent checkbox (only sent when the user may mark Urgent). */
  urgent: boolean;
  /** Loading of what was used last time (`getVideoInputs`). */
  prefill: "loading" | "ready" | "error";
}

export interface ReEditDialog extends DialogBase {
  kind: "reEdit";
  changes: string;
  urgent: boolean;
}

/** Render Final keeps its own form state (`RenderFinalSheet`); the dialog only says it is open. */
export interface RenderFinalDialog extends DialogBase {
  kind: "renderFinal";
}

export interface StopDialog extends DialogBase {
  kind: "stop";
}

export type JobDialog = StartDialog | ReEditDialog | RenderFinalDialog | StopDialog;
export type JobDialogKind = JobDialog["kind"];
type DialogOf<K extends JobDialogKind> = Extract<JobDialog, { kind: K }>;
type Patch<K extends JobDialogKind> = Partial<Omit<DialogOf<K>, "kind" | "video">>;

export interface JobsState {
  dialog: JobDialog | null;
  /** The job command in flight per video id; a second action on that video is ignored. */
  pending: Partial<Record<string, VideoAction>>;
  /**
   * The video whose Upload was asked for (the Upload action of a row's menu); the owner of the
   * upload dialog shows it and calls `closeUpload`. `null` when none.
   */
  uploadFor: string | null;
}

export interface JobsController {
  readonly state: StoreApi<JobsState>;
  /** The typed job commands (job ids and video ids cannot be mixed up). */
  readonly commands: JobCommands;
  runJobAction: (video: VideoView, action: VideoAction) => void;
  /** Updates the fields of the open dialog when it is of `kind`. */
  update: <K extends JobDialogKind>(kind: K, patch: Patch<K>) => void;
  /** Closes the open dialog unless a command is in flight. */
  close: () => void;
  closeUpload: () => void;
  submitStart: () => Promise<void>;
  submitReEdit: () => Promise<void>;
  /**
   * Starts a final render. Resolves with the server's refusal (shown by the sheet) or `null`
   * once the job was accepted. Never rejects.
   */
  submitRenderFinal: (videoId: string, resolution: RenderResolution) => Promise<ApiError | null>;
  /** Runs Stop Editing for the open confirmation. Never rejects. */
  confirmStop: () => Promise<void>;
}

const FAILURE_TITLE: Record<VideoAction, string> = {
  startEdit: "Could not start editing",
  pause: "Could not pause editing",
  continue: "Could not continue editing",
  stop: "Could not stop editing",
  reEdit: "Could not start the re-edit",
  renderFinal: "Could not start the final render",
  startNow: "Could not start this edit now",
  archive: "Could not archive the video",
  unarchive: "Could not unarchive the video",
  review: "Could not open the timeline",
  upload: "Could not start the upload",
  diskCleanup: "Could not open Disk Cleanup",
};

export function createJobsController(api: Api, store: AppStore): JobsController {
  const state = createStore<JobsState>()(() => ({ dialog: null, pending: {}, uploadFor: null }));
  const commands = jobCommands(store);

  function setPending(videoId: string, action: VideoAction | null): void {
    state.setState((s) => {
      const { [videoId]: _previous, ...others } = s.pending;
      return { pending: action ? { ...others, [videoId]: action } : others };
    });
  }

  function current<K extends JobDialogKind>(kind: K): DialogOf<K> | null {
    const dialog = state.getState().dialog;
    return dialog?.kind === kind ? (dialog as DialogOf<K>) : null;
  }

  function update<K extends JobDialogKind>(kind: K, patch: Patch<K>): void {
    state.setState((s) => (s.dialog?.kind === kind ? { dialog: { ...s.dialog, ...patch } } : {}));
  }

  /** What a refusal changes about what the page shows: the library, the readiness. */
  function refreshAfter(error: ApiError): void {
    const app = store.getState();
    switch (error.code) {
      case "conflict":
      case "notFound":
        // The video or its job changed under us; show the current state.
        void app.refreshLibrary();
        break;
      case "notReady":
        // What the server needs before it can edit changed; show what it says now.
        void app.loadReadiness();
        break;
      case "invalidInput":
        // For example the channel prompt was emptied in the meantime; the sheet then says so.
        void app.loadWorkspace();
        break;
      default:
        break;
    }
  }

  /** Runs one command with its in-flight marker; resolves with the refusal or `null`. */
  async function perform(
    video: VideoView,
    action: VideoAction,
    run: () => Promise<unknown>,
  ): Promise<ApiError | null> {
    setPending(video.id, action);
    try {
      await run();
      return null;
    } catch (error) {
      const e = toApiError(error);
      refreshAfter(e);
      return e;
    } finally {
      setPending(video.id, null);
    }
  }

  /** `perform` for the commands that have no sheet: a refusal is a toast. */
  async function performWithToast(
    video: VideoView,
    action: VideoAction,
    run: () => Promise<unknown>,
  ): Promise<boolean> {
    const error = await perform(video, action, run);
    if (error) toast.error(FAILURE_TITLE[action], error.message);
    return error === null;
  }

  function isBusy(videoId: string): boolean {
    const s = state.getState();
    return s.pending[videoId] !== undefined || s.dialog?.submitting === true;
  }

  function open(dialog: JobDialog): void {
    if (state.getState().dialog?.submitting) return;
    state.setState({ dialog });
  }

  function mayMarkUrgent(): boolean {
    return store.getState().session.data?.user?.mayMarkUrgent === true;
  }

  async function prefillStart(video: VideoView): Promise<void> {
    try {
      const inputs = await api.getVideoInputs({ videoId: video.id });
      const dialog = current("start");
      // Keep anything the user typed while the request was in flight.
      if (dialog?.video.id !== video.id || dialog.prefill !== "loading") return;
      update("start", {
        productLinks: dialog.productLinks || inputs.productLinks,
        notes: dialog.notes || inputs.notes,
        promptSlot: inputs.promptSlot,
        styleSlot: inputs.styleSlot,
        prefill: "ready",
      });
    } catch {
      if (current("start")?.video.id === video.id) update("start", { prefill: "error" });
    }
  }

  /** Shared by the sheets with a form: validate, run, then close or show the refusal. */
  async function submit<K extends "start" | "reEdit">(
    kind: K,
    action: VideoAction,
    problem: (dialog: DialogOf<K>) => string | null,
    run: (dialog: DialogOf<K>) => Promise<unknown>,
  ): Promise<void> {
    const dialog = current(kind);
    // The fields every dialog has (TypeScript cannot see through the generic `DialogOf<K>`).
    const base = dialog as unknown as DialogBase | null;
    if (!dialog || !base || base.submitting || state.getState().pending[base.video.id]) return;
    if (problem(dialog) !== null) {
      update(kind, { showErrors: true } as Patch<K>);
      return;
    }
    update(kind, { submitting: true, error: null } as Patch<K>);
    const error = await perform(base.video, action, () => run(dialog));
    if (current(kind) === null) return;
    if (error === null) state.setState({ dialog: null });
    else update(kind, { submitting: false, error: error.message } as Patch<K>);
  }

  return {
    state,
    commands,
    update,

    runJobAction(video, action) {
      if (isBusy(video.id)) return;
      const base = { video, showErrors: false, submitting: false, error: null };
      const jobId = video.job ? jobIdOf(video.job) : null;
      switch (action) {
        case "startEdit":
          open({
            ...base,
            kind: "start",
            productLinks: "",
            notes: "",
            promptSlot: 0,
            styleSlot: 0,
            urgent: false,
            prefill: "loading",
          });
          void prefillStart(video);
          return;
        case "reEdit":
          open({ ...base, kind: "reEdit", changes: "", urgent: false });
          return;
        case "renderFinal":
          open({ ...base, kind: "renderFinal" });
          return;
        case "stop":
          if (jobId) open({ ...base, kind: "stop" });
          return;
        case "pause":
          if (jobId) void performWithToast(video, action, () => commands.pause(jobId));
          return;
        case "continue":
          if (jobId) void performWithToast(video, action, () => commands.continue(jobId));
          return;
        case "startNow":
          if (jobId) void performWithToast(video, action, () => commands.startNow(jobId));
          return;
        case "archive":
          void (async () => {
            const done = await performWithToast(video, action, () =>
              store.getState().archiveVideo(video.id),
            );
            if (done) toast.success(`Archived ${video.folderName}`, "Find it in Archive.");
          })();
          return;
        case "unarchive":
          void performWithToast(video, action, () => store.getState().unarchiveVideo(video.id));
          return;
        case "review":
          store.getState().showTimeline(video.id);
          return;
        case "diskCleanup":
          // The page opens with this video's confirmation (it takes the request once).
          requestDiskCleanup(video.id);
          store.getState().setView("diskCleanup");
          return;
        case "upload":
          state.setState({ uploadFor: video.id });
          return;
      }
    },

    close() {
      if (state.getState().dialog?.submitting) return;
      state.setState({ dialog: null });
    },

    closeUpload() {
      state.setState({ uploadFor: null });
    },

    submitStart: () =>
      submit(
        "start",
        "startEdit",
        (d) => (d.prefill === "loading" ? "loading" : productLinksProblem(d.productLinks)),
        async (d) => {
          const channel = store
            .getState()
            .workspace.data?.channels.find((c) => c.id === d.video.channelId);
          const { promptSlot, styleSlot } = startSlots(channel, d.video, d);
          await api.setVideoInputs({
            videoId: d.video.id,
            inputs: {
              productLinks: normalizeLinks(d.productLinks),
              notes: d.notes.trim(),
              promptSlot,
              styleSlot,
            },
          });
          return commands.startEdit(videoIdOf(d.video), d.urgent && mayMarkUrgent());
        },
      ),

    submitReEdit: () =>
      submit(
        "reEdit",
        "reEdit",
        (d) => changesProblem(d.changes),
        (d) => commands.reEdit(videoIdOf(d.video), d.changes.trim(), d.urgent && mayMarkUrgent()),
      ),

    async submitRenderFinal(videoId, resolution) {
      const video = findVideo(store.getState().library.data, videoId);
      if (!video) return toApiError({ code: "notFound", message: "This video is gone." });
      if (state.getState().pending[videoId]) return null;
      return perform(video, "renderFinal", () =>
        commands.renderFinal(videoIdOf(video), resolution),
      );
    },

    async confirmStop() {
      const dialog = current("stop");
      const jobId = dialog?.video.job ? jobIdOf(dialog.video.job) : null;
      if (!dialog || dialog.submitting) return;
      // The job that is current now (the one the confirmation names may have ended meanwhile).
      const live = findVideo(store.getState().library.data, dialog.video.id)?.job;
      const id = live ? jobIdOf(live) : jobId;
      update("stop", { submitting: true });
      if (id) await performWithToast(dialog.video, "stop", () => commands.stop(id));
      if (current("stop")) state.setState({ dialog: null });
    },
  };
}

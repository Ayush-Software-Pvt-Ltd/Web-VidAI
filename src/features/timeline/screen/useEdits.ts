import { useCallback, useRef, useState } from "react";
import { toast } from "@/components/ui";
import { useApi, useAppStoreApi } from "@/lib/appEnv";
import { toApiError } from "@/lib/errors";
import type { TimelineOp } from "@/lib/types";

export const CONFLICT_TITLE = "The project changed in the meantime";
export const CONFLICT_TEXT = "It was loaded again and your change was not made.";
export const REFUSED_TITLE = "The change was not made";

export interface Edits {
  /** A change is on its way to the server; another one waits until it is answered. */
  busy: boolean;
  edit: (op: TimelineOp) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  restore: (n: number) => Promise<void>;
}

/**
 * The commands that change the project. One at a time (a second one would carry a stale revision);
 * a `conflict` (somebody or a job changed it meanwhile) loads the project again and says so, and
 * any other refusal shows the server's sentence and leaves the screen as it is.
 */
export function useEdits(videoId: string): Edits {
  const api = useApi();
  const store = useAppStoreApi();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const perform = useCallback(
    async (run: () => Promise<unknown>) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      try {
        await run();
      } catch (error) {
        const failure = toApiError(error);
        if (failure.code === "conflict") {
          toast.error(CONFLICT_TITLE, CONFLICT_TEXT);
          try {
            store.getState().applyTimeline(videoId, await api.getTimeline({ videoId }));
          } catch {
            // The next event or a reopening shows what is wrong; the screen stays as it is.
          }
        } else {
          toast.error(REFUSED_TITLE, failure.message);
        }
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [api, store, videoId],
  );

  const edit = useCallback(
    (op: TimelineOp) =>
      perform(() => {
        const revision = store.getState().timelines[videoId]?.timeline.data?.revision;
        if (revision === undefined) return Promise.resolve();
        return store.getState().editTimeline(videoId, revision, op);
      }),
    [perform, store, videoId],
  );
  const undo = useCallback(
    () => perform(() => store.getState().undoTimeline(videoId)),
    [perform, store, videoId],
  );
  const redo = useCallback(
    () => perform(() => store.getState().redoTimeline(videoId)),
    [perform, store, videoId],
  );
  const restore = useCallback(
    (n: number) => perform(() => store.getState().restoreRevision(videoId, n)),
    [perform, store, videoId],
  );
  return { busy, edit, undo, redo, restore };
}

import type { EditLogEntry, EditLogPage, EditLogQuery } from "../types";
import { toApiError } from "../errors";
import type { SliceContext } from "./ctx";
import { idle, type Resource } from "./resource";

/**
 * Whose lines the edit log lists. Only an admin can choose another than `mine` (the server refuses
 * the others for everybody else). It is kept for paging and goes back to `mine` on sign-out.
 */
export type EditLogFilter = { kind: "mine" } | { kind: "all" } | { kind: "user"; userId: string };

export const MY_EDITS: EditLogFilter = { kind: "mine" };

/** The part of `getEditLog`'s input that says whose lines to read. */
export function editLogQueryOf(filter: EditLogFilter): Partial<EditLogQuery> {
  switch (filter.kind) {
    case "mine":
      return {};
    case "all":
      return { all: true };
    case "user":
      return { userId: filter.userId };
  }
}

export interface EditLogState {
  /** The newest entries first; `more` says whether older ones exist (`loadMoreEditLog`). */
  editLog: Resource<EditLogPage>;
  /** Whose lines `editLog` holds. */
  editLogFilter: EditLogFilter;
}

export interface EditLogActions {
  /** Reads the newest page of the lines `editLogFilter` names. */
  loadEditLog: () => Promise<void>;
  /**
   * Chooses whose lines are listed and reads them: the lines of the previous choice leave at once
   * (an answer still on its way for it is dropped). Admins only; the server refuses it otherwise.
   */
  setEditLogFilter: (filter: EditLogFilter) => Promise<void>;
  /** Appends the next older page (the entries before the oldest one shown). */
  loadMoreEditLog: () => Promise<void>;
}

export type EditLogSlice = EditLogState & EditLogActions;

export function createEditLogSlice({
  api,
  set,
  get,
  load,
  invalidate,
  generation,
  onReset,
}: SliceContext): EditLogSlice {
  // The page of older lines on its way, if any (a new choice of lines forgets it).
  let olderRun: object | null = null;
  onReset(() => {
    olderRun = null;
  });
  const sameFilter = (a: EditLogFilter, b: EditLogFilter) =>
    a.kind === b.kind && (a.kind !== "user" || (b.kind === "user" && a.userId === b.userId));
  return {
    editLog: idle(),
    editLogFilter: MY_EDITS,
    loadEditLog: () => load("editLog", () => api.getEditLog(editLogQueryOf(get().editLogFilter))),
    async setEditLogFilter(filter) {
      if (sameFilter(get().editLogFilter, filter)) return;
      invalidate("editLog");
      olderRun = null;
      set({ editLogFilter: filter, editLog: { data: null, status: "loading", error: null } });
      await get().loadEditLog();
    },
    async loadMoreEditLog() {
      const page = get().editLog.data;
      const oldest: EditLogEntry | undefined = page?.entries[page.entries.length - 1];
      if (!page || !page.more || !oldest || olderRun) return;
      const run = {};
      olderRun = run;
      const was = generation();
      const filter = get().editLogFilter;
      try {
        const older = await api.getEditLog({ ...editLogQueryOf(filter), before: oldest.id });
        // The lines were chosen again or read afresh while this page was on its way.
        if (olderRun !== run || was !== generation() || get().editLog.data !== page) return;
        set((s) => {
          const shown = s.editLog.data?.entries ?? [];
          const known = new Set(shown.map((entry) => entry.id));
          return {
            editLog: {
              data: {
                entries: [...shown, ...older.entries.filter((entry) => !known.has(entry.id))],
                more: older.more,
              },
              status: "ready",
              error: null,
            },
          };
        });
      } catch (error) {
        if (olderRun !== run || was !== generation()) return;
        set((s) => ({ editLog: { ...s.editLog, status: "error", error: toApiError(error) } }));
      } finally {
        if (olderRun === run) olderRun = null;
      }
    },
  };
}

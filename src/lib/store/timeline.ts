import type {
  OpenTimelineResult,
  PreviewCopiesState,
  RevisionView,
  Timeline,
  TimelineChangedPayload,
  TimelineNote,
} from "../types";
import { toApiError } from "../errors";
import type { SliceContext } from "./ctx";
import { idle, type Resource } from "./resource";

/** Everything the timeline screen shows for one video. */
export interface TimelineEntry {
  /** The timeline (`null` data while the project is not ready to open, see `violations`). */
  timeline: Resource<Timeline | null>;
  /** The address of the project preview for the player, `null` until it can be shown. */
  previewUrl: string | null;
  /** What keeps the project from opening as a timeline (SPEC section 10). */
  violations: OpenTimelineResult["violations"];
  /** The smooth preview copies of the video's heavy media (SPEC section 11, Preview copies). */
  previewCopies: PreviewCopiesState;
  revisions: Resource<RevisionView[]>;
}

/** What the entry of a video that is not open (or has no heavy media) shows. */
export const NO_PREVIEW_COPIES: PreviewCopiesState = { total: 0, done: 0, running: false };

/**
 * The preview copies of one video, for `useAppState(selectPreviewCopies(videoId))`. A video whose
 * timeline is not open has none; the same object is returned until the state changes.
 */
export const selectPreviewCopies =
  (videoId: string) =>
  (state: TimelineState): PreviewCopiesState =>
    state.timelines[videoId]?.previewCopies ?? NO_PREVIEW_COPIES;

export interface TimelineState {
  /** Keyed by video id. */
  timelines: Record<string, TimelineEntry>;
}

export interface TimelineActions {
  /** Opens the timeline of a video (`openTimeline`): the timeline, the preview address, violations. */
  openTimelineOf: (videoId: string) => Promise<void>;
  /** Takes the `Timeline` a call returned (`editTimeline`, `undoTimeline`, ...) at once. */
  applyTimeline: (videoId: string, timeline: Timeline) => void;
  loadRevisions: (videoId: string) => Promise<void>;
  /**
   * `timeline-changed`: the project is at another revision. A loaded timeline is fetched again
   * (unless it already is at that revision, as after the user's own edit) and a loaded revision
   * list too. A video whose timeline is not open is left alone.
   */
  applyTimelineChanged: (change: TimelineChangedPayload) => Promise<void>;
  /** `preview-copies-changed`: keeps the copies state of an open video (other videos are ignored). */
  applyPreviewCopies: (videoId: string, copies: PreviewCopiesState) => void;
  /** Puts a note of a `note-updated` event into its timeline (removes it when `removed`). */
  applyNote: (videoId: string, note: TimelineNote, removed: boolean) => void;
  /** Forgets the entry of a video (leaving the screen). */
  forgetTimeline: (videoId: string) => void;
}

export type TimelineSlice = TimelineState & TimelineActions;

const emptyEntry = (): TimelineEntry => ({
  timeline: idle(),
  previewUrl: null,
  violations: [],
  previewCopies: NO_PREVIEW_COPIES,
  revisions: idle(),
});

export function createTimelineSlice({
  api,
  set,
  get,
  generation,
  onReset,
}: SliceContext): TimelineSlice {
  /** Changes the entry of a video, which must exist: answers that come after leaving are dropped. */
  const patch = (videoId: string, change: (entry: TimelineEntry) => Partial<TimelineEntry>) =>
    set((s) => {
      const entry = s.timelines[videoId];
      if (!entry) return {};
      return { timelines: { ...s.timelines, [videoId]: { ...entry, ...change(entry) } } };
    });
  const create = (videoId: string, change: (entry: TimelineEntry) => Partial<TimelineEntry>) =>
    set((s) => {
      const entry = s.timelines[videoId] ?? emptyEntry();
      return { timelines: { ...s.timelines, [videoId]: { ...entry, ...change(entry) } } };
    });

  // Newest wins: `opens` guards `openTimelineOf`, `versions` every other write of a timeline, so an
  // answer that was asked for before a newer one (or after leaving) never overwrites it.
  const opens = new Map<string, number>();
  const versions = new Map<string, number>();
  const bump = (map: Map<string, number>, videoId: string) => {
    const next = (map.get(videoId) ?? 0) + 1;
    map.set(videoId, next);
    return next;
  };
  onReset(() => {
    opens.clear();
    versions.clear();
  });

  const loadRevisions = async (videoId: string) => {
    const was = generation();
    patch(videoId, (entry) => ({
      revisions: { ...entry.revisions, status: "loading", error: null },
    }));
    try {
      const data = await api.listRevisions({ videoId });
      if (was !== generation()) return;
      patch(videoId, () => ({ revisions: { data, status: "ready", error: null } }));
    } catch (error) {
      if (was !== generation()) return;
      patch(videoId, (entry) => ({
        revisions: { ...entry.revisions, status: "error", error: toApiError(error) },
      }));
    }
  };

  return {
    timelines: {},
    async openTimelineOf(videoId) {
      const open = bump(opens, videoId);
      const was = generation();
      create(videoId, (entry) => ({
        timeline: { ...entry.timeline, status: "loading", error: null },
      }));
      try {
        const opened = await api.openTimeline({ videoId });
        if (was !== generation() || opens.get(videoId) !== open) return;
        bump(versions, videoId);
        patch(videoId, () => ({
          timeline: { data: opened.timeline, status: "ready", error: null },
          previewUrl: opened.previewUrl,
          violations: opened.violations,
          previewCopies: opened.previewCopies,
        }));
      } catch (error) {
        if (was !== generation() || opens.get(videoId) !== open) return;
        patch(videoId, (entry) => ({
          timeline: { ...entry.timeline, status: "error", error: toApiError(error) },
        }));
      }
    },
    applyTimeline(videoId, timeline) {
      bump(versions, videoId);
      patch(videoId, () => ({ timeline: { data: timeline, status: "ready", error: null } }));
    },
    loadRevisions,
    async applyTimelineChanged({ videoId, revision }) {
      const entry = get().timelines[videoId];
      if (!entry) return;
      const reloads: Promise<void>[] = [];
      if (entry.revisions.status !== "idle") reloads.push(loadRevisions(videoId));
      if (entry.timeline.data && entry.timeline.data.revision !== revision) {
        const version = bump(versions, videoId);
        const was = generation();
        reloads.push(
          api.getTimeline({ videoId }).then(
            (timeline) => {
              if (was !== generation() || versions.get(videoId) !== version) return;
              patch(videoId, () => ({
                timeline: { data: timeline, status: "ready", error: null },
              }));
            },
            // The next event or a reopening shows the error; the timeline on screen stays.
            () => undefined,
          ),
        );
      }
      await Promise.all(reloads);
    },
    applyPreviewCopies: (videoId, copies) => patch(videoId, () => ({ previewCopies: copies })),
    applyNote: (videoId, note, removed) =>
      patch(videoId, (entry) => {
        const timeline = entry.timeline.data;
        if (!timeline) return {};
        const others = timeline.notes.filter((existing) => existing.id !== note.id);
        const notes = removed
          ? others
          : timeline.notes.some((existing) => existing.id === note.id)
            ? timeline.notes.map((existing) => (existing.id === note.id ? note : existing))
            : [...others, note];
        return { timeline: { ...entry.timeline, data: { ...timeline, notes } } };
      }),
    forgetTimeline(videoId) {
      bump(opens, videoId);
      bump(versions, videoId);
      set((s) => ({
        timelines: Object.fromEntries(
          Object.entries(s.timelines).filter(([key]) => key !== videoId),
        ),
      }));
    },
  };
}

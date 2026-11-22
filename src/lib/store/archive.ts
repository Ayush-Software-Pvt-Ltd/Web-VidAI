import type { ArchivedVideo } from "../types";
import type { SliceContext } from "./ctx";
import { idle, type Resource } from "./resource";

export interface ArchiveState {
  /** Videos removed from the main list (Archive in the sidebar). */
  archived: Resource<ArchivedVideo[]>;
}

export interface ArchiveActions {
  loadArchived: () => Promise<void>;
  /**
   * Takes a video off the main list, then refreshes the library (a selection of that video
   * falls back to none) and the archive list when it is loaded.
   */
  archiveVideo: (videoId: string) => Promise<void>;
  /** Moves a video back to the main list, then refreshes the library and the archive list. */
  unarchiveVideo: (videoId: string) => Promise<void>;
}

export type ArchiveSlice = ArchiveState & ArchiveActions;

export function createArchiveSlice({ api, get, load, call }: SliceContext): ArchiveSlice {
  return {
    archived: idle(),
    loadArchived: () => load("archived", () => api.getArchived()),
    async archiveVideo(videoId) {
      await call(() => api.archiveVideo({ videoId }));
      await Promise.all([
        get().refreshLibrary(),
        get().archived.status === "idle" ? Promise.resolve() : get().loadArchived(),
      ]);
    },
    async unarchiveVideo(videoId) {
      await call(() => api.unarchiveVideo({ videoId }));
      await Promise.all([get().refreshLibrary(), get().loadArchived()]);
    },
  };
}

/**
 * UI state of the main window that only the library feature needs: the search query, the filter,
 * and optimistic video type choices that wait for the next library refresh.
 */
import { create } from "zustand";
import type { VideoType } from "@/lib/types";
import { DEFAULT_SORT, type LibraryFilter, type VideoSort } from "./model";

export interface LibraryViewState {
  query: string;
  filter: LibraryFilter;
  sort: VideoSort;
  /**
   * Type overrides the user just picked, keyed by video id (`null` = Auto). Shown right away
   * and dropped once the library reports the same value, or when saving fails.
   */
  pendingTypes: Record<string, VideoType | null>;
  setQuery: (query: string) => void;
  setFilter: (filter: LibraryFilter) => void;
  setSort: (sort: VideoSort) => void;
  setPendingType: (videoId: string, type: VideoType | null) => void;
  clearPendingType: (videoId: string) => void;
  reset: () => void;
}

const initial = {
  query: "",
  filter: "all" as LibraryFilter,
  sort: DEFAULT_SORT,
  pendingTypes: {},
};

export const useLibraryView = create<LibraryViewState>()((set) => ({
  ...initial,
  setQuery: (query) => {
    set({ query });
  },
  setFilter: (filter) => {
    set({ filter });
  },
  setSort: (sort) => {
    set({ sort });
  },
  setPendingType: (videoId, type) => {
    set((s) => ({ pendingTypes: { ...s.pendingTypes, [videoId]: type } }));
  },
  clearPendingType: (videoId) => {
    set((s) => {
      if (!(videoId in s.pendingTypes)) return {};
      const { [videoId]: _dropped, ...rest } = s.pendingTypes;
      return { pendingTypes: rest };
    });
  },
  reset: () => {
    set(initial);
  },
}));

/** The search field, so Cmd+F and the list can move focus to it. */
export const SEARCH_INPUT_ID = "library-search";

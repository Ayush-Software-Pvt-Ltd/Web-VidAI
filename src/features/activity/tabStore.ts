/**
 * UI state of the activity panel that outlives one video: the tab (Log or Outputs) the user last
 * chose, which every video opened next shows. Not saved across launches (SPEC section 9).
 */
import { create } from "zustand";

export type ActivityTab = "log" | "outputs";

interface ActivityTabState {
  /** `null` until the user picks a tab; the panel then chooses per video. */
  chosen: ActivityTab | null;
  choose: (tab: ActivityTab) => void;
  reset: () => void;
}

export const useActivityTab = create<ActivityTabState>()((set) => ({
  chosen: null,
  choose: (chosen) => {
    set({ chosen });
  },
  reset: () => {
    set({ chosen: null });
  },
}));

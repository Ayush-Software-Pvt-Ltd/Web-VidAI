import type { HarnessPublicView, Readiness } from "../types";
import type { SliceContext } from "./ctx";
import { idle, ready, type Resource } from "./resource";

export interface HarnessState {
  /** What every user may see of the harness: setup, program, model, effort. */
  harness: Resource<HarnessPublicView>;
  /** What new edits need on the server (SPEC section 6); the message depends on admin or user. */
  readiness: Resource<Readiness>;
}

export interface HarnessActions {
  loadHarness: () => Promise<void>;
  loadReadiness: () => Promise<void>;
  setHarness: (harness: HarnessPublicView) => void;
}

export type HarnessSlice = HarnessState & HarnessActions;

export function createHarnessSlice({ api, set, load }: SliceContext): HarnessSlice {
  return {
    harness: idle(),
    readiness: idle(),
    loadHarness: () => load("harness", () => api.getHarness()),
    loadReadiness: () => load("readiness", () => api.getReadiness()),
    setHarness: (harness) => set({ harness: ready(harness) }),
  };
}

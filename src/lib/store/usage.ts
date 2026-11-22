import type { UsageUpdate, UsageView } from "../types";
import type { SliceContext } from "./ctx";
import { idle, type Resource } from "./resource";

export interface UsageState {
  /** The plan's usage limits, and the OpenCode Go quota while that setup is active. */
  usage: Resource<UsageView>;
}

export interface UsageActions {
  loadUsage: (refresh?: boolean) => Promise<void>;
  /** `usage-updated` carries only the part that changed: merges it. */
  applyUsageUpdate: (update: UsageUpdate) => void;
}

export type UsageSlice = UsageState & UsageActions;

export function createUsageSlice({ api, set, load }: SliceContext): UsageSlice {
  return {
    usage: idle(),
    loadUsage: (refresh = false) =>
      load("usage", () => api.getUsage(refresh ? { refresh } : undefined)),
    applyUsageUpdate: (update) =>
      set((s) => {
        const current = s.usage.data;
        if (!current) return {};
        return {
          usage: {
            ...s.usage,
            data: {
              claude: update.claude ?? current.claude,
              opencode: update.opencode ?? current.opencode,
            },
          },
        };
      }),
  };
}

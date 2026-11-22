import type { Channel, ChannelUpdate, PublicSettings, Workspace } from "../types";
import type { SettingsChangedPayload } from "../rpc";
import type { SliceContext } from "./ctx";
import { idle, type Resource } from "./resource";

export interface WorkspaceState {
  /** The user's channels, the public settings and (always `null`) readiness. */
  workspace: Resource<Workspace>;
}

export interface WorkspaceActions {
  loadWorkspace: () => Promise<void>;
  /** Puts channels returned by a call (`reorderChannels`, `updateChannel`, ...) in right away. */
  setChannels: (channels: Channel[]) => void;
  /** Replaces the public settings (the part of `settings-changed` everybody gets). */
  applySettings: (settings: PublicSettings) => void;
  /**
   * `settings-changed`: the public settings, the harness when the event carries it, and what new
   * edits need (readiness depends on both) are brought up to date.
   */
  applySettingsChanged: (payload: SettingsChangedPayload) => void;
  updateChannel: (id: string, update: ChannelUpdate) => Promise<Channel>;
  reorderChannels: (ids: string[]) => Promise<Channel[]>;
}

export type WorkspaceSlice = WorkspaceState & WorkspaceActions;

export function createWorkspaceSlice({ api, set, get, load, call }: SliceContext): WorkspaceSlice {
  const setChannels = (channels: Channel[]) => {
    set((s) =>
      s.workspace.data
        ? { workspace: { ...s.workspace, data: { ...s.workspace.data, channels } } }
        : {},
    );
    get().reconcileNav();
  };
  const channelsNow = () => get().workspace.data?.channels ?? [];

  return {
    workspace: idle(),
    loadWorkspace: () => load("workspace", () => api.getWorkspace()),
    setChannels,
    applySettings: (settings) =>
      set((s) =>
        s.workspace.data
          ? { workspace: { ...s.workspace, data: { ...s.workspace.data, settings } } }
          : {},
      ),
    applySettingsChanged(payload) {
      const { harness, ...settings } = payload;
      get().applySettings(settings);
      if (harness) get().setHarness(harness);
      void get().loadReadiness();
      // Another admin's change shows without a reload: what an admin page has loaded is read
      // again (a page keeps what is being typed apart from the saved values).
      const { adminSettings, adminHarness } = get();
      if (adminSettings.status !== "idle") void get().loadAdminSettings();
      if (adminHarness.status !== "idle") void get().loadAdminHarness();
    },
    async updateChannel(id, update) {
      const channel = await call(() => api.updateChannel({ id, update }));
      setChannels(channelsNow().map((c) => (c.id === channel.id ? channel : c)));
      await get().refreshLibrary();
      return channel;
    },
    async reorderChannels(ids) {
      const channels = await call(() => api.reorderChannels({ ids }));
      setChannels(channels);
      await get().refreshLibrary();
      return channels;
    },
  };
}

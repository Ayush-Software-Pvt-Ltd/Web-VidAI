import type { Library, VideoType } from "../types";
import { channelIdOf } from "../videoId";
import type { SliceContext } from "./ctx";

/** Which top-level screen of the signed-in app is shown (the URL path decides, see `app/route.ts`). */
export type AppView =
  "main" | "settings" | "admin" | "archive" | "editLog" | "diskCleanup" | "timeline";

/** Sections of the user's settings screen. */
export type SettingsSection = "channels" | "appearance" | "importExport";

/** Sections of the admin area (SPEC section 16), in the order of its menu. */
export type AdminSection =
  "users" | "channels" | "harness" | "limits" | "storage" | "queue" | "system";

export const SETTINGS_SECTIONS = [
  "channels",
  "appearance",
  "importExport",
] as const satisfies readonly SettingsSection[];

export const ADMIN_SECTIONS = [
  "users",
  "channels",
  "harness",
  "limits",
  "storage",
  "queue",
  "system",
] as const satisfies readonly AdminSection[];

/**
 * Where the settings screen should open: a section and, for Channels, optionally a channel and
 * its Long or Short tab. Set by `openSettings`; the screen takes it once and clears it.
 */
export interface SettingsTarget {
  section: SettingsSection;
  channelId?: string;
  videoType?: VideoType;
}

/** A place in the app: what the URL path says (`app/route.ts` maps both ways). */
export type Place =
  | { view: "main" }
  | { view: "settings"; section: SettingsSection }
  | { view: "admin"; section: AdminSection }
  | { view: "archive" }
  | { view: "editLog" }
  | { view: "diskCleanup" }
  | { view: "timeline"; videoId: string };

export interface NavState {
  view: AppView;
  settingsSection: SettingsSection;
  adminSection: AdminSection;
  /** Where the settings screen should open next; see `openSettings`. */
  settingsTarget: SettingsTarget | null;
  /** `null` is "All Channels". */
  selectedChannelId: string | null;
  /** The video whose activity panel is open. */
  selectedVideoId: string | null;
  /** The video of the timeline screen (`view === "timeline"`). */
  timelineVideoId: string | null;
}

export interface NavActions {
  /** Shows a place (what the History API wiring calls when the path changes). */
  goTo: (place: Place) => void;
  setView: (view: Exclude<AppView, "timeline">) => void;
  toggleSettings: () => void;
  /** Shows settings, at `target` when given. */
  openSettings: (target?: SettingsTarget) => void;
  /** Called by the settings screen once it has taken the target. */
  clearSettingsTarget: () => void;
  openAdmin: (section?: AdminSection) => void;
  /** Shows the timeline of a video. */
  showTimeline: (videoId: string) => void;
  selectChannel: (channelId: string | null) => void;
  selectVideo: (videoId: string | null) => void;
  /**
   * Makes the selection fit what the user has now (the store calls it after the library or the
   * channels change): a selected channel that is gone becomes All Channels, a selected video that
   * is gone (archived, deleted, its channel removed) becomes none, and a timeline screen of a
   * video that is gone goes back to the video list. A channel whose folder cannot be read is
   * not "gone": its videos are only unknown for now.
   */
  reconcileNav: () => void;
}

export type NavSlice = NavState & NavActions;

/** True when the library is sure that the video does not exist (any more). */
function videoGone(library: Library, videoId: string): boolean {
  const channel = library.channels.find((c) => c.channelId === channelIdOf(videoId));
  if (!channel) return true;
  return channel.available && !channel.videos.some((video) => video.id === videoId);
}

export function createNavSlice({ set, get }: SliceContext): NavSlice {
  return {
    view: "main",
    settingsSection: "channels",
    adminSection: "users",
    settingsTarget: null,
    selectedChannelId: null,
    selectedVideoId: null,
    timelineVideoId: null,
    goTo(place) {
      switch (place.view) {
        case "settings":
          set({ view: "settings", settingsSection: place.section });
          return;
        case "admin":
          set({ view: "admin", adminSection: place.section });
          return;
        case "timeline":
          set({ view: "timeline", timelineVideoId: place.videoId });
          return;
        default:
          set({ view: place.view });
      }
    },
    setView: (view) => set({ view }),
    toggleSettings: () => set((s) => ({ view: s.view === "settings" ? "main" : "settings" })),
    openSettings(target) {
      set({
        view: "settings",
        settingsTarget: target ?? null,
        ...(target ? { settingsSection: target.section } : {}),
      });
    },
    clearSettingsTarget: () => set({ settingsTarget: null }),
    openAdmin: (section) => set({ view: "admin", adminSection: section ?? get().adminSection }),
    showTimeline: (videoId) => set({ view: "timeline", timelineVideoId: videoId }),
    selectChannel: (selectedChannelId) =>
      // Picking a channel while Archive, the edit log or Disk Cleanup is open shows the video list.
      set((s) => ({
        selectedChannelId,
        view:
          s.view === "archive" || s.view === "editLog" || s.view === "diskCleanup"
            ? "main"
            : s.view,
      })),
    selectVideo: (videoId) => set({ selectedVideoId: videoId }),
    reconcileNav() {
      const { workspace, library, selectedChannelId, selectedVideoId, view, timelineVideoId } =
        get();
      const patch: Partial<NavState> = {};
      if (
        workspace.data &&
        selectedChannelId !== null &&
        !workspace.data.channels.some((channel) => channel.id === selectedChannelId)
      ) {
        patch.selectedChannelId = null;
      }
      if (library.data) {
        if (selectedVideoId !== null && videoGone(library.data, selectedVideoId)) {
          patch.selectedVideoId = null;
        }
        if (
          view === "timeline" &&
          timelineVideoId !== null &&
          videoGone(library.data, timelineVideoId)
        ) {
          patch.view = "main";
          patch.timelineVideoId = null;
        }
      }
      if (Object.keys(patch).length > 0) set(patch);
    },
  };
}

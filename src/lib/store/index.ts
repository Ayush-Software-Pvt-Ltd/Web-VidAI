/**
 * App state (zustand): one slice per area in this folder (`session`, `workspace`, `harness`,
 * `library`, `queue`, `usage`, `archive`, `editLog`, `disk`, `jobLogs`, `admin`, `timeline`,
 * `nav`), kept fresh by the server's events.
 *
 * Every server resource is a `Resource<T>` with `status` ("idle" | "loading" | "ready" |
 * "error"), `data` (kept while refreshing and after an error, so screens do not flash) and
 * `error`. Components read with `useAppState((s) => s.library)` and call actions through
 * `useAppStoreApi().getState()`.
 *
 * `createAppStore(api)` builds an independent store (one per test); the app uses `useAppStore`.
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { Api, Unsubscribe } from "../api";
import { toApiError } from "../errors";
import { api as defaultApi } from "../ipc";
import { createAdminSlice } from "./admin";
import { createArchiveSlice } from "./archive";
import { createCommandsSlice } from "./commands";
import type { Loader, SliceContext } from "./ctx";
import { createDiskSlice } from "./disk";
import { createEditLogSlice } from "./editLog";
import { createHarnessSlice } from "./harness";
import { createJobLogsSlice } from "./jobLogs";
import { createLibrarySlice } from "./library";
import { createNavSlice } from "./nav";
import { createQueueSlice } from "./queue";
import { createSessionSlice, isSignedOutError } from "./session";
import type { AppState } from "./state";
import { createTimelineSlice } from "./timeline";
import { createUsageSlice } from "./usage";
import { createWorkspaceSlice } from "./workspace";

export type { AppState, CoreActions } from "./state";
export {
  idle,
  ready,
  createTicket,
  coalesced,
  type Resource,
  type ResourceStatus,
} from "./resource";
export type { AdminActions, AdminState, PerOption } from "./admin";
export { perOption } from "./admin";
export type { CommandActions } from "./commands";
export type { EditLogFilter } from "./editLog";
export type { JobLogState } from "./jobLogs";
export {
  ADMIN_SECTIONS,
  SETTINGS_SECTIONS,
  type AdminSection,
  type AppView,
  type NavActions,
  type NavState,
  type Place,
  type SettingsSection,
  type SettingsTarget,
} from "./nav";
export { withJob } from "./library";
export { SESSION_ENDED_TEXT, sessionEndedText } from "./session";
export * from "./selectors";
export type { TimelineEntry } from "./timeline";
export { NO_PREVIEW_COPIES, selectPreviewCopies } from "./timeline";

export type AppStore = UseBoundStore<StoreApi<AppState>>;

/** The state keys that stay when the user signs out. */
const KEPT_ON_SIGN_OUT = new Set<string>(["session", "signedOutReason"]);

export function createAppStore(api: Api): AppStore {
  return create<AppState>()((set, get) => {
    // Every load of a resource takes a ticket; only the newest may write (a slow answer that
    // arrives after a faster, newer one must not bring old data back). `generation` changes when
    // the user's data is forgotten, which drops every answer still on its way.
    const tickets = new Map<string, number>();
    let generation = 0;
    const resetListeners: Array<() => void> = [];

    const load: Loader = async (key, fetch) => {
      const ticket = (tickets.get(key) ?? 0) + 1;
      tickets.set(key, ticket);
      const was = generation;
      const stale = () => tickets.get(key) !== ticket || was !== generation;
      set((s) => ({ [key]: { ...s[key], status: "loading", error: null } }));
      try {
        const data = await fetch();
        if (stale()) return;
        set({ [key]: { data, status: "ready", error: null } } as Partial<AppState>);
        // What the user selected may be gone from what the server now says exists.
        if (key === "library" || key === "workspace") get().reconcileNav();
      } catch (error) {
        if (stale()) return;
        const apiError = toApiError(error);
        set((s) => ({ [key]: { ...s[key], status: "error", error: apiError } }));
        // Any answer `unauthenticated` means the session is gone (SPEC section 3).
        if (key !== "session" && isSignedOutError(apiError)) get().signedOut();
      }
    };

    let pristine: Partial<AppState> = {};
    const ctx: SliceContext = {
      api,
      set,
      get,
      load,
      invalidate: (key) => tickets.set(key, (tickets.get(key) ?? 0) + 1),
      resetData() {
        generation += 1;
        tickets.clear();
        for (const listener of resetListeners) listener();
        set(pristine);
      },
      generation: () => generation,
      onReset: (listener) => void resetListeners.push(listener),
      async call(run) {
        try {
          return await run();
        } catch (error) {
          const apiError = toApiError(error);
          if (isSignedOutError(apiError)) get().signedOut();
          throw apiError;
        }
      },
    };

    const slices = {
      ...createSessionSlice(ctx),
      ...createWorkspaceSlice(ctx),
      ...createHarnessSlice(ctx),
      ...createLibrarySlice(ctx),
      ...createQueueSlice(ctx),
      ...createUsageSlice(ctx),
      ...createArchiveSlice(ctx),
      ...createEditLogSlice(ctx),
      ...createDiskSlice(ctx),
      ...createJobLogsSlice(ctx),
      ...createAdminSlice(ctx),
      ...createTimelineSlice(ctx),
      ...createNavSlice(ctx),
      ...createCommandsSlice(ctx),
    };
    // What forgetting the user's data restores: the initial value of everything that is data
    // (not functions, not the session), and the next user starts on the video list.
    pristine = {
      ...Object.fromEntries(
        Object.entries(slices).filter(
          ([key, value]) => typeof value !== "function" && !KEPT_ON_SIGN_OUT.has(key),
        ),
      ),
    };

    function subscribe(): Unsubscribe {
      const { on } = api;
      const stops = [
        on.libraryChanged((library) => {
          // `null` says "something changed, ask" (channels, uploads).
          if (library) get().setLibrary(library);
          else void get().refreshLibrary();
        }),
        // An admin made, changed or removed one of the user's channels.
        on.workspaceChanged(() => {
          void get().loadWorkspace();
        }),
        on.jobUpdated((job) => get().applyJob(job)),
        on.jobLog((log) => get().appendJobLog(log)),
        on.queueChanged(() => {
          void get().refreshQueue();
          if (get().adminQueue.status !== "idle") void get().loadAdminQueue();
        }),
        on.settingsChanged((payload) => get().applySettingsChanged(payload)),
        on.timelineChanged((change) => void get().applyTimelineChanged(change)),
        on.noteUpdated(({ videoId, note, removed }) => get().applyNote(videoId, note, removed)),
        on.previewCopiesChanged(({ videoId, copies }) => get().applyPreviewCopies(videoId, copies)),
        on.usageUpdated((update) => get().applyUsageUpdate(update)),
        on.systemChanged(() => {
          if (get().adminSystem.status !== "idle") void get().loadAdminSystem();
        }),
        on.diskUseChanged((diskUse) =>
          set({ diskUse: { data: diskUse, status: "ready", error: null } }),
        ),
        on.sessionEnded(({ reason }) => get().sessionEnded(reason)),
      ];
      // There is no "reconnected" event: events missed while the stream was down are made up by
      // asking again when the link comes back.
      let status = api.connection.getSnapshot().status;
      stops.push(
        api.connection.subscribe(() => {
          const next = api.connection.getSnapshot().status;
          const was = status;
          status = next;
          if (was === "lost" && next === "connected" && get().session.data?.user) {
            void get().reloadAfterReconnect();
          }
        }),
      );
      return () => {
        for (const stop of stops) stop();
      };
    }

    /** Everything `loadSignedIn` loads plus every optional resource a screen has loaded. */
    async function reloadAfterReconnect() {
      const s = get();
      const loaded = (r: { status: string }) => r.status !== "idle";
      const again: Array<Promise<void>> = [get().loadSignedIn()];
      if (loaded(s.adminQueue)) again.push(s.loadAdminQueue());
      if (loaded(s.adminSystem)) again.push(s.loadAdminSystem());
      if (loaded(s.adminSettings)) again.push(s.loadAdminSettings());
      if (loaded(s.adminHarness)) again.push(s.loadAdminHarness());
      if (loaded(s.adminUsers)) again.push(s.loadAdminUsers());
      if (loaded(s.diskUse)) again.push(s.loadDiskUse());
      if (loaded(s.archived)) again.push(s.loadArchived());
      if (loaded(s.editLog)) again.push(s.loadEditLog());
      for (const [videoId, entry] of Object.entries(s.timelines)) {
        if (loaded(entry.timeline)) again.push(s.openTimelineOf(videoId));
        if (loaded(entry.revisions)) again.push(s.loadRevisions(videoId));
      }
      for (const [videoId, log] of Object.entries(s.jobLogs)) {
        if (log.jobId !== null && log.status !== "idle")
          again.push(s.loadJobLog(videoId, log.jobId));
      }
      await Promise.all(again);
    }

    return {
      ...slices,
      reloadAfterReconnect,
      async loadSignedIn() {
        await Promise.all([
          get().loadWorkspace(),
          get().loadReadiness(),
          get().loadHarness(),
          get().refreshLibrary(),
          get().refreshQueue(),
          get().loadUsage(),
        ]);
      },
      init() {
        const stop = subscribe();
        void (async () => {
          await get().loadSession();
          const info = get().session.data;
          if (info?.user) await get().loadSignedIn();
        })();
        return stop;
      },
    };
  });
}

/** The store of the real app, bound to the backend of `ipc.ts`. Tests build their own. */
export const useAppStore: AppStore = createAppStore(defaultApi);

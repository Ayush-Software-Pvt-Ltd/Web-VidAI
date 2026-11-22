import type { Unsubscribe } from "../api";
import type { AdminSlice } from "./admin";
import type { ArchiveSlice } from "./archive";
import type { CommandsSlice } from "./commands";
import type { DiskSlice } from "./disk";
import type { EditLogSlice } from "./editLog";
import type { HarnessSlice } from "./harness";
import type { JobLogsSlice } from "./jobLogs";
import type { LibrarySlice } from "./library";
import type { NavSlice } from "./nav";
import type { QueueSlice } from "./queue";
import type { SessionSlice } from "./session";
import type { TimelineSlice } from "./timeline";
import type { UsageSlice } from "./usage";
import type { WorkspaceSlice } from "./workspace";

export interface CoreActions {
  /**
   * Subscribes to the server's events, asks who is signed in (`getSession`) and, when somebody
   * is, loads what that user sees (workspace, readiness, harness, library, queue, usage). Signed
   * out or still to be set up, nothing else is loaded. Admin pages load their own resources.
   * Returns a cleanup function that unsubscribes everything.
   */
  init: () => Unsubscribe;
  /** Loads everything a signed-in user needs (called after `getSession`, `login`, `setupAdmin`). */
  loadSignedIn: () => Promise<void>;
  /**
   * Asks again for everything `loadSignedIn` loads and for every optional resource a screen has
   * loaded (admin pages, disk use, archive, edit log, open timelines and job logs). `init()`
   * calls it when the connection goes from `lost` back to `connected` while signed in.
   */
  reloadAfterReconnect: () => Promise<void>;
}

/** The whole app state: one slice per area, each in its own file of `src/lib/store/`. */
export type AppState = CoreActions &
  SessionSlice &
  WorkspaceSlice &
  HarnessSlice &
  LibrarySlice &
  QueueSlice &
  UsageSlice &
  ArchiveSlice &
  EditLogSlice &
  DiskSlice &
  JobLogsSlice &
  AdminSlice &
  TimelineSlice &
  NavSlice &
  CommandsSlice;

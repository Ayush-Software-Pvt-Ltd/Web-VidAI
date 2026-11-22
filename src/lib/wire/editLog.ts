// Wire types of the edit log (docs/SPEC.md sections 14 to 16): what happened to each video, kept in
// the `edit_log` table. Pure declarations; every field is always present (`null` when empty) and
// every time is milliseconds since 1970.

/**
 * What happened. The server keeps the names in `server/src/editLog.js` (`EDIT_EVENTS`).
 * - `started`, `completed`, `failed`, `stopped`, `paused`, `continued`: an edit job.
 * - `reEdit`: a Re-Edit job started.
 * - `changeRequest`: change requests on the timeline were sent to an agent.
 * - `render`: a final video was rendered (or failed to).
 * - `archived`, `unarchived`: the video left or came back to the main list.
 * - `diskCleanup`: the working files were deleted (SPEC section 13).
 */
export type EditEvent =
  | "started"
  | "completed"
  | "failed"
  | "stopped"
  | "paused"
  | "continued"
  | "reEdit"
  | "changeRequest"
  | "render"
  | "archived"
  | "unarchived"
  | "diskCleanup";

/** One line of the edit log. The email and the video label are kept as they were at the time. */
export interface EditLogEntry {
  /** Grows with time; the cursor of `getEditLog`'s `before`. */
  id: number;
  at: number;
  /** `null` once the user's account is deleted. */
  userId: string | null;
  userEmail: string;
  /** `<channel name> / <folder name>`, readable after the channel or video is gone. */
  videoLabel: string;
  /** One of `EditEvent`; the server stores a name it does not know as given. */
  event: string;
  /** One short human line, for example "Edit started (Claude Code, Opus)". */
  message: string;
}

/** The answer of `getEditLog`: newest first. */
export interface EditLogPage {
  entries: EditLogEntry[];
  /** There are older entries: ask again with `before` set to the last entry's `id`. */
  more: boolean;
}

/** The input of `getEditLog`; `userId` and `all` are for admins only. */
export interface EditLogQuery {
  before: number | null;
  /** 1 to 500, default 100. */
  limit: number | null;
  /** Admin: another user's entries. */
  userId: string | null;
  /** Admin: everybody's entries, including those of deleted users. */
  all: boolean;
}

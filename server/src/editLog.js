// The edit log service (docs/SPEC.md sections 15 and 16): `record` is called by the job manager, archive and Disk Cleanup;
// `read` backs the `getEditLog` RPC function. There is no text file mirror any more: the
// `edit_log` table is the only store, and it keeps the newest 20000 rows.

import { createEditLogRepo } from "./db/editLog.js";
import { forbidden, invalidInput } from "./errors.js";

/** @typedef {import("../../src/lib/wire/editLog.ts").EditEvent} EditEvent */
/** @typedef {import("../../src/lib/wire/editLog.ts").EditLogEntry} EditLogEntry */
/** @typedef {import("../../src/lib/wire/editLog.ts").EditLogPage} EditLogPage */

/** The event names; the same list is the `EditEvent` type of `src/lib/wire/editLog.ts`. */
export const EDIT_EVENTS = Object.freeze(
  /** @type {const} */ ([
    "started",
    "completed",
    "failed",
    "stopped",
    "paused",
    "continued",
    "reEdit",
    "changeRequest",
    "render",
    "archived",
    "unarchived",
    "diskCleanup",
  ]),
);

export const DEFAULT_KEEP = 20_000;
export const DEFAULT_PAGE = 100;
export const MAX_PAGE = 500;

const MAX_MESSAGE_CHARS = 1000;
const MAX_LABEL_CHARS = 400;
const UNKNOWN_VIDEO = "A video that no longer exists";

/**
 * @param {string} text
 * @param {number} max
 */
function clip(text, max) {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * @typedef {object} EditLogDeps
 * @property {import("./db/open.js").Database} db
 * @property {{ byId(id: string): { email: string } | null }} users
 * @property {import("./db/open.js").Clock} clock
 * @property {import("./log.js").Logger} log
 * @property {(videoKey: string) => { channelName: string, folderName: string } | undefined | null} [describeVideo]
 *   What the library gives (`library.api.describeKey`); without it a record needs a `videoLabel`.
 * @property {number} [keep] Rows kept; default 20000.
 * @property {boolean} [strict] Tests only: `record` throws for an event name it does not know
 *   (production stores it as given and logs a warning).
 */

/**
 * @param {EditLogDeps} deps
 */
export function createEditLog({
  db,
  users,
  clock,
  log,
  describeVideo = () => undefined,
  keep = DEFAULT_KEEP,
  strict = false,
}) {
  if (!Number.isInteger(keep) || keep < 1)
    throw new Error("The edit log must keep at least 1 row.");
  const repo = createEditLogRepo(db);

  return {
    /**
     * Adds one line. It never throws into its caller: a failed write is logged and the edit goes
     * on (except in `strict` mode for an unknown event name, which is a programming error).
     * @param {{
     *   userId: string | null,
     *   videoKey?: string | null,
     *   videoLabel?: string | null,
     *   event: string,
     *   message: string,
     * }} entry `userId` is who the line is about (its owner reads it); `videoLabel`, when given,
     *   wins over the label found from `videoKey`.
     * @returns {number | null} The id of the new row, `null` when nothing was written.
     */
    record({ userId, videoKey = null, videoLabel = null, event, message }) {
      if (!EDIT_EVENTS.includes(/** @type {EditEvent} */ (event))) {
        if (strict) throw new Error(`Unknown edit log event "${event}".`);
        log.warn(`Edit log: unknown event "${event}" stored as given.`);
      }
      try {
        const user = userId === null ? null : users.byId(userId);
        const found = videoKey === null ? null : describeVideo(videoKey);
        const label =
          videoLabel ??
          (found ? `${found.channelName} / ${found.folderName}` : videoKey ? UNKNOWN_VIDEO : "");
        return repo.insert(
          {
            at: clock.now(),
            // A user that is already gone cannot be referenced (the table has a foreign key).
            userId: user ? userId : null,
            userEmail: user?.email ?? "",
            videoLabel: clip(label, MAX_LABEL_CHARS),
            event,
            message: clip(String(message), MAX_MESSAGE_CHARS),
          },
          keep,
        );
      } catch (error) {
        log.error("Edit log: could not write an entry.", error);
        return null;
      }
    },

    /**
     * One page of entries, newest first. A user reads only their own; an admin may name another
     * user or ask for everybody's (which also holds the entries of deleted users).
     * @param {{ id: string, role: "admin" | "user" }} reader
     * @param {{ before?: number | null, limit?: number | null, userId?: string | null, all?: boolean }} [query]
     * @returns {EditLogPage}
     */
    read(reader, { before = null, limit = null, userId = null, all = false } = {}) {
      if ((all || userId !== null) && reader.role !== "admin") {
        throw forbidden("Only an admin can read the edit log of other users.");
      }
      if (all && userId !== null) {
        throw invalidInput("Ask for one user's entries or for everybody's, not both.");
      }
      const size = Math.min(limit ?? DEFAULT_PAGE, MAX_PAGE);
      return repo.page({
        userId: all ? null : (userId ?? reader.id),
        before,
        limit: size,
      });
    },

    /** The number of rows kept. @returns {number} */
    count: () => repo.count(),
  };
}

/** @typedef {ReturnType<typeof createEditLog>} EditLog */

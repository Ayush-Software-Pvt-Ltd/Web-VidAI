/**
 * The edit log of the mock: `getEditLog` as the server answers it (`server/src/editLog.js`,
 * `read`): newest first in pages of 100 (at most 500) with the id of the last entry as the cursor,
 * a user reads only their own lines, an admin may name a user or ask for everybody's.
 * Other areas add lines to `world.editLog` (jobs, Disk Cleanup); there is no event, as on the server.
 * It is plugged in by `diskArea`, which spreads it into its own functions.
 */
import type { Api } from "../../api";
import type { MockCtx } from "../ctx";

const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

export function editLogArea(ctx: MockCtx): Partial<Api> {
  const { world } = ctx;
  return {
    getEditLog: (input) =>
      ctx.run(() => {
        const reader = ctx.requireUser();
        const { before = null, limit = null, userId = null, all = false } = input ?? {};
        if ((all || userId !== null) && reader.role !== "admin") {
          throw ctx.errors.forbidden("Only an admin can read the edit log of other users.");
        }
        if (all && userId !== null) {
          throw ctx.errors.invalidInput("Ask for one user's entries or for everybody's, not both.");
        }
        const size = Math.min(limit ?? DEFAULT_PAGE, MAX_PAGE);
        const owner = all ? null : (userId ?? reader.id);
        const matching = world.editLog
          .filter(
            (entry) =>
              (owner === null || entry.userId === owner) && (before === null || entry.id < before),
          )
          .sort((a, b) => b.id - a.id);
        return { entries: matching.slice(0, size), more: matching.length > size };
      }),
  };
}

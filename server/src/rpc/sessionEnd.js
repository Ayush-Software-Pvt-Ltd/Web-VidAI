// Ending the sessions of an account and telling its open pages (docs/SPEC.md section 4).

/** @typedef {"passwordChanged" | "disabled" | "removed"} EndReason */

/**
 * Ends all sessions of `userId` except `exceptId`. Only when none are left are the account's
 * event streams closed (after a `session-ended` event that tells the page why): the sessions
 * that stay still need theirs.
 * @param {Pick<import("./index.js").RpcDeps, "sessions" | "events">} deps
 * @param {string} userId
 * @param {{ exceptId?: string | null, reason: EndReason }} options
 * @returns {number} How many sessions ended.
 */
export function endSessions({ sessions, events }, userId, { exceptId = null, reason }) {
  const ended = sessions.endAllOfUser(userId, exceptId);
  if (sessions.countOfUser(userId) === 0) {
    if (ended > 0) {
      events.emit({ event: "session-ended", payload: { reason }, userId, admins: false });
    }
    events.closeUser(userId);
  }
  return ended;
}

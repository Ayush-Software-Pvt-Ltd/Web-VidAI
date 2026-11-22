// Tells the modules which sessions ended, so what hangs on a session is closed with it: the
// preview addresses of the timeline are keyed by session id and are not checked against the
// session again (docs/SPEC.md sections 4 and 11), so a sign out, a password change, a disabled or
// deleted account must end them at once.
//
// A decorator over `createSessions`: the same methods, plus `onEnd(listener)`. Expiry by idleness
// is not announced (an address lives 12 hours, a session 30 idle days).

/**
 * @template {{ end(id: string): boolean, endAllOfUser(userId: string, exceptId?: string | null): number }} S
 * @param {S} sessions
 * @param {{ listByUser(userId: string): Array<{ id: string }> }} repo
 * @returns {S & { onEnd(listener: (sessionId: string) => void): () => void }}
 */
export function withEndNotice(sessions, repo) {
  /** @type {Set<(sessionId: string) => void>} */
  const listeners = new Set();
  /** @param {string} id */
  const announce = (id) => {
    for (const listener of [...listeners]) {
      try {
        listener(id);
      } catch {
        // A listener that fails must not keep a session alive.
      }
    }
  };
  return Object.assign(Object.create(sessions), {
    /** @param {string} id */
    end(id) {
      const ended = sessions.end(id);
      announce(id);
      return ended;
    },
    /** @param {string} userId @param {string | null} [exceptId] */
    endAllOfUser(userId, exceptId = null) {
      const ids = repo
        .listByUser(userId)
        .map((row) => row.id)
        .filter((id) => id !== exceptId);
      const ended = sessions.endAllOfUser(userId, exceptId);
      for (const id of ids) announce(id);
      return ended;
    },
    /** @param {(sessionId: string) => void} listener */
    onEnd(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}

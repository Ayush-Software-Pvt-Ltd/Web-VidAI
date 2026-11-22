// The event bus between the server's modules and the open event streams (docs/SPEC.md section 14).

/**
 * @typedef {object} BusEvent
 * @property {string} event One of the event names of SPEC section 14.
 * @property {unknown} payload
 * @property {string | null} userId The user it concerns; null means every signed-in user.
 * @property {boolean} admins True: admins get it too, whoever the owner is.
 *
 * @typedef {object} Subscriber
 * @property {string} userId
 * @property {"admin" | "user"} role
 *
 * @typedef {ReturnType<typeof createEventBus>} EventBus
 */

/**
 * @param {{ onError?: (error: unknown) => void }} [options] Receives errors thrown by listeners.
 */
export function createEventBus({ onError = () => {} } = {}) {
  /** @typedef {{ who: Subscriber, listener: (event: BusEvent) => void, onClose: (() => void) | undefined }} Entry */
  /** @type {Set<Entry>} */
  const entries = new Set();
  /** Server-side listeners: see every event, are not open connections. @type {Set<(event: BusEvent) => void>} */
  const listeners = new Set();
  /** @type {Set<(count: number, userIds: string[]) => void>} */
  const watchListeners = new Set();

  /** An open event connection is a subscription that can be closed (`onClose`); the server's own
   * modules subscribe without one and are not counted. @returns {Entry[]} */
  const connections = () => [...entries].filter((entry) => entry.onClose !== undefined);

  function announceWatchers() {
    const open = connections();
    const userIds = [...new Set(open.map((entry) => entry.who.userId))];
    for (const listener of [...watchListeners]) safely(() => listener(open.length, userIds));
  }

  /** @param {() => void} call */
  function safely(call) {
    try {
      call();
    } catch (error) {
      onError(error);
    }
  }

  return {
    /**
     * Deliver an event to the streams it concerns. A failing listener never stops the others.
     * @param {BusEvent} event
     */
    emit(event) {
      for (const entry of [...entries]) {
        const wanted =
          event.userId === null ||
          event.userId === entry.who.userId ||
          (event.admins && entry.who.role === "admin");
        if (wanted) safely(() => entry.listener(event));
      }
      for (const listener of [...listeners]) safely(() => listener(event));
    },

    /**
     * A listener of the server itself (a module that reacts to events): gets every event, whoever
     * it concerns, and does not count as an open connection.
     * @param {(event: BusEvent) => void} listener
     * @returns {() => void} Unsubscribe.
     */
    listen(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Open event connections now: how many, and which users have one. */
    watching() {
      const open = connections();
      return {
        count: open.length,
        userIds: [...new Set(open.map((entry) => entry.who.userId))],
      };
    },

    /**
     * Called whenever a connection opens or closes (the Claude usage meter refreshes faster while
     * somebody watches, the library rescans only for users who watch).
     * @param {(count: number, userIds: string[]) => void} listener
     * @returns {() => void} Unsubscribe.
     */
    onWatchersChange(listener) {
      watchListeners.add(listener);
      return () => {
        watchListeners.delete(listener);
      };
    },

    /**
     * @param {Subscriber} who
     * @param {(event: BusEvent) => void} listener
     * @param {() => void} [onClose] Called when `closeUser` ends this subscription.
     * @returns {() => void} Unsubscribe.
     */
    subscribe(who, listener, onClose) {
      /** @type {Entry} */
      const entry = { who, listener, onClose };
      entries.add(entry);
      if (onClose) announceWatchers();
      return () => {
        if (entries.delete(entry) && onClose) announceWatchers();
      };
    },

    /**
     * The sessions of a user ended (sign out, password change, delete, disable): tell their open
     * streams with `session-ended` and end them (SPEC section 4).
     * @param {string} userId
     */
    closeUser(userId) {
      for (const entry of [...entries]) {
        if (entry.who.userId !== userId) continue;
        entries.delete(entry);
        safely(() =>
          entry.listener({ event: "session-ended", payload: null, userId, admins: false }),
        );
        const onClose = entry.onClose;
        if (onClose) safely(onClose);
        if (onClose) announceWatchers();
      }
    },
  };
}

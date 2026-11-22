/**
 * The state of the page's link to the server (SPEC section 14): whether the event stream is up,
 * whether the server refused the page (no session), and the instance id of the server it first
 * talked to (the page reloads when it changes). `http.ts` drives it, the connection notice reads
 * it through `Api.connection`; the mock backend has one too so the notice can be tried.
 */
import type { Unsubscribe } from "./api";

export interface ConnectionState {
  /**
   * `connecting` until the event stream first opens, `connected` while it is up, `lost` after it
   * broke (the page keeps trying to reconnect, and reloads once it is back).
   */
  status: "connecting" | "connected" | "lost";
  /** The server answered 401 (`unauthenticated`): this page has no session (or it ended). */
  unauthorized: boolean;
  /** The server start the page first heard from (the `hello` event), `null` before that. */
  instance: string | null;
}

/** Read side, for `useSyncExternalStore`. */
export interface Connection {
  getSnapshot: () => ConnectionState;
  subscribe: (listener: () => void) => Unsubscribe;
}

export interface ConnectionStore extends Connection {
  /** Changes some fields; listeners run only when something differs. */
  update: (patch: Partial<ConnectionState>) => void;
}

export function createConnectionStore(initial: Partial<ConnectionState> = {}): ConnectionStore {
  let state: ConnectionState = {
    status: "connecting",
    unauthorized: false,
    instance: null,
    ...initial,
  };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (patch) => {
      const next = { ...state, ...patch };
      if (
        next.status === state.status &&
        next.unauthorized === state.unauthorized &&
        next.instance === state.instance
      ) {
        return;
      }
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

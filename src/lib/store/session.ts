import { toApiError } from "../errors";
import type { SessionEndReason } from "../rpc";
import type { SessionInfo } from "../types";
import type { SliceContext } from "./ctx";
import { idle, ready, type Resource } from "./resource";

export interface SessionState {
  /** Who is signed in (`data.user` is `null` when nobody is) and whether first-admin setup is due. */
  session: Resource<SessionInfo>;
}

export interface SessionActions {
  loadSession: () => Promise<void>;
  /** Takes the answer of `login`, `setupAdmin` or `getSession`, then loads what the user sees. */
  setSession: (info: SessionInfo) => Promise<void>;
  /** Signs in (`login`), then loads what the user sees. Rejects with the `ApiError` of a refusal. */
  login: (email: string, password: string) => Promise<SessionInfo>;
  /** Creates the first admin (`setupAdmin`), who is signed in at once. */
  setupAdmin: (token: string, email: string, password: string) => Promise<SessionInfo>;
  /** Ends this page's session (`logout`) and forgets the user's data. */
  logout: () => Promise<void>;
  /**
   * The session is gone (`session-ended`, `logout`, or any answer `unauthenticated`): forgets the
   * user's data and shows the sign-in page. `reason` is the sentence shown there (see
   * `sessionEndedText`); without one, a user who was signed in gets `SESSION_ENDED_TEXT`, and
   * `null` says there is nothing to explain (a deliberate sign-out). Calling it again while
   * signed out changes nothing, the first sentence stays.
   */
  signedOut: (reason?: string | null) => void;
  /** Handles a `session-ended` event (also the transport's own on a 401, with `reason: null`). */
  sessionEnded: (reason: SessionEndReason | null) => void;
}

export interface SessionSlice extends SessionState, SessionActions {
  /** Why the sign-in page is shown over a page that was signed in (`null` normally). */
  signedOutReason: string | null;
}

/** What the sign-in page says when the session ended without a reason (a 401, or `reason: null`). */
export const SESSION_ENDED_TEXT = "Your session has ended. Sign in again.";

/** The sentence the sign-in page shows after `session-ended`. */
export function sessionEndedText(reason: SessionEndReason | null): string {
  switch (reason) {
    case "passwordChanged":
      return "You were signed out because your password was changed. Please sign in again.";
    case "disabled":
      return "You were signed out because your account was turned off. Ask an administrator if you need access again.";
    case "removed":
      return "You were signed out because your account was removed.";
    default:
      return SESSION_ENDED_TEXT;
  }
}

export function createSessionSlice({ api, set, get, load, resetData }: SliceContext): SessionSlice {
  async function setSession(info: SessionInfo): Promise<void> {
    // Another account in the same page: nothing of the previous one may stay.
    const previous = get().session.data?.user ?? null;
    if (previous && info.user?.id !== previous.id) resetData();
    set({ session: ready(info), signedOutReason: null });
    if (info.user) await get().loadSignedIn();
  }

  // True while `logout` runs: the `session-ended` the server (or the mock) sends for it is not news.
  let leaving = false;

  return {
    session: idle(),
    signedOutReason: null,
    loadSession: () => load("session", () => api.getSession()),
    setSession,
    async login(email, password) {
      const info = await api.login({ email, password }).catch(rethrow);
      await setSession(info);
      return info;
    },
    async setupAdmin(token, email, password) {
      const info = await api.setupAdmin({ token, email, password }).catch(rethrow);
      await setSession(info);
      return info;
    },
    async logout() {
      leaving = true;
      try {
        await api.logout();
      } catch (error) {
        // A session that is gone already is what was asked for; anything else is shown.
        if (!isSignedOutError(error)) throw toApiError(error);
      } finally {
        leaving = false;
      }
      get().signedOut(null);
    },
    sessionEnded(reason) {
      get().signedOut(leaving ? null : sessionEndedText(reason));
    },
    signedOut(reason) {
      const data = get().session.data;
      const alreadyOut = data?.user === null;
      resetData();
      set((s) => ({
        session: ready({
          user: null,
          needsSetup: data?.needsSetup ?? false,
          serverVersion: data?.serverVersion ?? "",
        }),
        // The first sentence stays; a user who was never signed in has nothing to be told.
        signedOutReason: alreadyOut
          ? s.signedOutReason
          : reason === undefined
            ? data?.user
              ? SESSION_ENDED_TEXT
              : null
            : reason,
      }));
    },
  };
}

function rethrow(error: unknown): never {
  throw toApiError(error);
}

/** True for an error that means "the session is gone". */
export function isSignedOutError(error: unknown): boolean {
  return toApiError(error).code === "unauthenticated";
}

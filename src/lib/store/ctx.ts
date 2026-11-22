import type { Api } from "../api";
import type { Resource } from "./resource";
import type { AppState } from "./state";

/** Names of the state fields that hold a plain `Resource`. */
export type ResourceKey = {
  [K in keyof AppState]: AppState[K] extends Resource<unknown> ? K : never;
}[keyof AppState];

export type Loader = <K extends ResourceKey>(
  key: K,
  fetch: () => Promise<NonNullable<AppState[K]["data"]>>,
) => Promise<void>;

/** What every slice gets: the backend, the store's `set` and `get`, and the helpers. */
export interface SliceContext {
  api: Api;
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;
  get: () => AppState;
  /**
   * Runs a load for a resource, keeping the previous data while loading and on failure. Only the
   * newest load of a resource may write: an older answer that arrives late is dropped, and so is
   * any answer that arrives after the user's data was forgotten.
   */
  load: Loader;
  /** Discards the answers of loads of `key` that are still on their way (the data was set another way). */
  invalidate: (key: ResourceKey) => void;
  /** Forgets everything that belongs to the signed-in user (all but the session and navigation). */
  resetData: () => void;
  /**
   * Changes every time the user's data is forgotten. A slice that fetches outside `load` reads it
   * before the call and drops the answer when it changed.
   */
  generation: () => number;
  /** Runs `listener` whenever the user's data is forgotten (slices drop their queued work). */
  onReset: (listener: () => void) => void;
  /**
   * Runs a call of the server for an action: an `unauthenticated` answer ends the session
   * (`signedOut`), and every failure is rethrown as an `ApiError` for the caller to show.
   */
  call: <T>(run: () => Promise<T>) => Promise<T>;
}

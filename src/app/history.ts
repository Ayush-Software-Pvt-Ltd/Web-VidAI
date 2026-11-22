/**
 * The address bar and the place in the store, kept in step in both directions (SPEC section 16).
 * There is no router package: `pathOf` and `placeOf` (`route.ts`) map a place to a path and back,
 * and `bindHistory` does the rest with the History API.
 *
 * A screen never touches `window.history`. To go somewhere it calls the store's navigation
 * actions (`goTo`, `setView`, `openSettings`, `openAdmin`, `showTimeline`, `selectChannel`, ...);
 * the binding sees the place change and pushes one entry. Back and Forward come back as `popstate`
 * and are applied with `goTo`.
 *
 * - While signed in: a place the store moves to is pushed (the query string stays, the hash goes);
 *   Back and Forward move the store; an address that names no place shows the library and is
 *   replaced by `/`; `/admin/...` for a person who is not an admin shows the library too.
 * - While signed out nothing moves the store: a deep link opened signed out stays in the address
 *   bar, and when the person has signed in the place it names is shown. A session that ended keeps
 *   the address (signing in again returns there); a deliberate sign out goes back to `/`.
 * - `/setup` is not a place: it belongs to the first-admin page (`#<token>` stays while setup is
 *   due) and, once an admin exists or somebody is signed in, it is replaced by `/`.
 */
import type { AppState, AppStore, Place } from "@/lib/store";
import { isSetupPath, pathOf, placeOf } from "./route";

/** The place the store shows now. */
export function currentPlace(state: AppState): Place {
  switch (state.view) {
    case "settings":
      return { view: "settings", section: state.settingsSection };
    case "admin":
      return { view: "admin", section: state.adminSection };
    case "timeline":
      return state.timelineVideoId === null
        ? { view: "main" }
        : { view: "timeline", videoId: state.timelineVideoId };
    default:
      return { view: state.view };
  }
}

/** Starts the binding and returns the function that stops it. */
export function bindHistory(store: AppStore, win: Window = window): () => void {
  const home = () => `/${win.location.search}`;
  const here = () => win.location.pathname;
  const replace = (url: string) => {
    win.history.replaceState(win.history.state, "", url);
  };
  const withSearch = (path: string) => `${path}${win.location.search}`;

  let signedIn = false;

  /** Shows the place the address names (the first time after sign in, and on Back and Forward). */
  function applyAddress() {
    const state = store.getState();
    const place = placeOf(here());
    const isAdmin = state.session.data?.user?.role === "admin";
    if (place === null || (place.view === "admin" && !isAdmin)) {
      replace(home());
      state.goTo({ view: "main" });
      return;
    }
    const path = pathOf(place);
    if (here() !== path) replace(withSearch(path));
    state.goTo(place);
  }

  function sync() {
    const state = store.getState();
    const user = state.session.data?.user ?? null;

    if (!user) {
      const wasSignedIn = signedIn;
      signedIn = false;
      const info = state.session.data;
      if (info && isSetupPath(here()) && !info.needsSetup) replace(home());
      else if (wasSignedIn && state.signedOutReason === null && !isSetupPath(here())) {
        // A deliberate sign out starts again from the library.
        replace(home());
      }
      return;
    }

    if (!signedIn) {
      signedIn = true;
      applyAddress();
      return;
    }

    const place = currentPlace(state);
    if (place.view === "admin" && user.role !== "admin") {
      state.goTo({ view: "main" });
      replace(home());
      return;
    }
    const path = pathOf(place);
    if (path !== here()) win.history.pushState(null, "", withSearch(path));
  }

  const onPopState = () => {
    if (signedIn) applyAddress();
  };

  // The store changes in several steps (signing out resets the data, then the session), so the
  // binding looks at the state once those steps are done.
  let queued = false;
  let stopped = false;
  const stop = store.subscribe(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!stopped) sync();
    });
  });
  win.addEventListener("popstate", onPopState);
  sync();
  return () => {
    stopped = true;
    stop();
    win.removeEventListener("popstate", onPopState);
  };
}

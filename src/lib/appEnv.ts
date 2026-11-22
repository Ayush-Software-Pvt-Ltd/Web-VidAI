/**
 * The one way UI code reaches the backend and the app store: through `AppEnvContext`.
 *
 * ```tsx
 * const api = useApi();                                  // backend commands
 * const library = useAppState((s) => s.library);         // re-renders on change
 * const store = useAppStoreApi();                        // getState() inside handlers
 * const session = useSession();                         // the signed-in user, or null
 * const isAdmin = useIsAdmin();                          // may use the admin area
 * const platform = usePlatform();                        // shortcut keys of the browser's system
 * ```
 *
 * The app uses the default value (the real `api` and `useAppStore`). Tests give every test its own
 * mock backend and store with `<AppEnvContext value={{ api, store }}>` (see `src/test/app.tsx`),
 * so components never import `api` or `useAppStore` directly (an ESLint rule enforces it).
 */
import { createContext, useContext } from "react";
import { useStore } from "zustand";
import type { Api } from "./api";
import { api as defaultApi } from "./ipc";
import { detectPlatform, type PlatformInfo, platformInfo } from "./platform";
import { type AppState, type AppStore, useAppStore } from "./store";
import type { SessionUser } from "./types";

export interface AppEnv {
  api: Api;
  store: AppStore;
}

export const AppEnvContext = createContext<AppEnv>({ api: defaultApi, store: useAppStore });

/** The backend and store of this part of the tree. */
export function useAppEnv(): AppEnv {
  return useContext(AppEnvContext);
}

/** The backend commands. */
export function useApi(): Api {
  return useContext(AppEnvContext).api;
}

/**
 * Shortcut keys and how they are shown, by the operating system of the browser (`platform.ts`).
 * Only the keyboard traits matter in a browser; the window frame traits are off.
 */
export function usePlatform(): PlatformInfo {
  return platformInfo(detectPlatform());
}

/** The app store itself, for `getState()` inside event handlers. */
export function useAppStoreApi(): AppStore {
  return useContext(AppEnvContext).store;
}

/** Reads from the app store with a selector (re-renders when the selected value changes). */
export function useAppState<T>(selector: (state: AppState) => T): T {
  return useStore(useContext(AppEnvContext).store, selector);
}

/** The signed-in user, `null` while nobody is (or the session is still loading). */
export function useSession(): SessionUser | null {
  return useAppState((state) => state.session.data?.user ?? null);
}

/** Whether the signed-in user has the admin role (the server still checks every admin call). */
export function useIsAdmin(): boolean {
  return useSession()?.role === "admin";
}

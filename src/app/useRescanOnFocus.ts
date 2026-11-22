import { useEffect } from "react";
import { useAppStoreApi } from "@/lib/appEnv";

/** Focus and visibility changes come in pairs; one rescan per this many ms is enough. */
export const RESCAN_THROTTLE_MS = 2000;

/**
 * The library is refreshed when the tab becomes visible again or the window gets focus: files may
 * have been added on the server meanwhile. `getLibrary` scans, and the store coalesces
 * overlapping requests (`refreshLibrary`). Only while somebody is signed in.
 */
export function useRescanOnFocus(): void {
  const store = useAppStoreApi();
  useEffect(() => {
    let last = Date.now();
    const rescan = () => {
      if (!store.getState().session.data?.user) return;
      const now = Date.now();
      if (now - last < RESCAN_THROTTLE_MS) return;
      last = now;
      void store.getState().refreshLibrary();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") rescan();
    };
    window.addEventListener("focus", rescan);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", rescan);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [store]);
}

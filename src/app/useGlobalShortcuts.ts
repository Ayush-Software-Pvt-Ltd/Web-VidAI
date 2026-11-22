import { useEffect } from "react";
import { usePlatform, useAppStoreApi } from "@/lib/appEnv";
import { isShortcut } from "@/lib/platform";

/**
 * App-wide keyboard shortcuts: Cmd+, (Ctrl+, on Windows and Linux) toggles Settings. A key the
 * browser keeps for itself is never taken: on a Mac the browser owns Cmd+, so there Settings is
 * reached with its sidebar button (`PlatformInfo.offersShortcut`).
 */
export function useGlobalShortcuts(enabled: boolean): void {
  const store = useAppStoreApi();
  const { platform, offersShortcut } = usePlatform();
  const offered = offersShortcut(["mod", ","]);
  useEffect(() => {
    if (!enabled || !offered) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isShortcut(event, platform, ",")) {
        event.preventDefault();
        store.getState().toggleSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled, offered, store, platform]);
}

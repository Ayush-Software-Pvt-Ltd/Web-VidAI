import { useEffect, useRef } from "react";
import { toast } from "./toastStore";

/**
 * Closes the current toasts when `screen` changes (not on mount), following the rule in
 * `toastStore.ts`. Each level of navigation calls it with its own key: the shell with the
 * top-level screen, Settings with its section.
 */
export function useToastScreen(screen: string): void {
  const previous = useRef(screen);
  useEffect(() => {
    if (previous.current === screen) return;
    previous.current = screen;
    toast.leaveScreen();
  }, [screen]);
}

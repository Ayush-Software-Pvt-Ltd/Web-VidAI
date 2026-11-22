import { useEffect } from "react";
import { usePlatform } from "@/lib/appEnv";
import { isShortcut } from "@/lib/platform";
import { SEARCH_INPUT_ID } from "./viewStore";

/** A dialog or menu is open, so global shortcuts must not move focus behind it. */
function overlayOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]',
    ) !== null
  );
}

/** Cmd+F (Ctrl+F on Windows and Linux) focuses and selects the search field while the main window is shown. */
export function useSearchShortcut(): void {
  const { platform } = usePlatform();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isShortcut(event, platform, "f")) return;
      if (overlayOpen()) return;
      const input = document.getElementById(SEARCH_INPUT_ID);
      if (!(input instanceof HTMLInputElement)) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [platform]);
}

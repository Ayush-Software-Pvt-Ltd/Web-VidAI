import { useEffect, useState, type ReactElement } from "react";
import { KeyRegistryContext, createKeyRegistry } from "../keys";
import { PlaybackContext, type PlaybackStore } from "../playback";

/**
 * Stands in for the screen's key owner in tests of the panel alone: one document listener that asks
 * the claims for C and Escape (the screen does this in `screen/useShortcuts.ts`, with more rules;
 * the joined tests in `joined*.test.tsx` use the real one).
 */
export function KeyOwner({
  playback,
  children,
}: {
  playback: PlaybackStore;
  children: ReactElement;
}) {
  const [registry] = useState(createKeyRegistry);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]')) {
        return;
      }
      if (event.defaultPrevented) return;
      const typing = target?.closest("input, textarea, select, [contenteditable]") != null;
      if (event.key === "Escape") {
        if (registry.run("Escape")) event.preventDefault();
      } else if (
        event.key.toLowerCase() === "c" &&
        !(event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) &&
        !typing
      ) {
        if (registry.run("c")) event.preventDefault();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [registry]);
  return (
    <KeyRegistryContext value={registry}>
      <PlaybackContext value={playback}>{children}</PlaybackContext>
    </KeyRegistryContext>
  );
}

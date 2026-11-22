import { useEffect, useEffectEvent } from "react";
import { usePlatform } from "@/lib/appEnv";
import { isShortcut } from "@/lib/platform";

/** Cmd+Enter (Ctrl+Enter on Windows and Linux) calls `onSubmit` while the component is mounted. */
export function useSubmitShortcut(onSubmit: () => void): void {
  const submit = useEffectEvent(onSubmit);
  const { platform } = usePlatform();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isShortcut(event, platform, "Enter") || event.isComposing) return;
      event.preventDefault();
      submit();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [platform]);
}

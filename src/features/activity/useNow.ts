import { useEffect, useState } from "react";

/** The current time in ms, updated every `intervalMs` while `enabled` (for running clocks). */
export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const update = () => {
      setNow(Date.now());
    };
    const first = setTimeout(update, 0);
    const timer = setInterval(update, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [enabled, intervalMs]);
  return now;
}

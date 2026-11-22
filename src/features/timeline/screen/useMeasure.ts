import { useCallback, useEffect, useState } from "react";
import type { Box } from "../model";

const ZERO: Box = { width: 0, height: 0 };

/**
 * The size of an element in layout (CSS) px, kept up to date by a `ResizeObserver` (attach `ref` to
 * the element), which reports it as soon as it observes. `getBoundingClientRect` is not used: under
 * a CSS `zoom` on <html> (the app's text size) it counts in screen px, so a size read from it would
 * not match the one the observer reports (and the styles use) a moment later.
 */
export function useMeasure(): [(node: HTMLDivElement | null) => void, Box] {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<Box>(ZERO);
  const ref = useCallback((next: HTMLDivElement | null) => setNode(next), []);
  useEffect(() => {
    if (!node) return;
    const apply = (width: number, height: number) =>
      setSize((was) => (was.width === width && was.height === height ? was : { width, height }));
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) apply(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [ref, size];
}

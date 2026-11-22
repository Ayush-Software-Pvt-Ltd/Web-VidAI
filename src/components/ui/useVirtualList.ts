/**
 * A small windowing hook for long lists with rows of different heights (the job log keeps up to
 * 5,000 entries; the edit log and the admin Queue page can grow long too). The list must start at
 * the top of the scrolling element. Rows are absolutely positioned at their offset; each rendered row is measured
 * with a ResizeObserver and its height is remembered by key, so expanding a row or wrapping text
 * is handled. Rows that grow above the visible area shift the scroll position by the same amount,
 * so the content under the reader's eyes does not jump.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Key, type RefObject } from "react";

export interface VirtualRow {
  index: number;
  key: Key;
  start: number;
  /** The height the row is laid out with (measured, or estimated until measured). */
  size: number;
}

export interface VirtualListOptions {
  count: number;
  getKey: (index: number) => Key;
  /** Height used until a row is measured. */
  estimateSize: (index: number) => number;
  /** The scrolling element; it must be mounted together with the list. */
  viewportRef: RefObject<HTMLElement | null>;
  /** Render the end of the list regardless of the scroll position (the log follows new entries). */
  atEnd: boolean;
  /** Extra pixels rendered above and below the visible area. */
  overscan?: number;
}

export interface VirtualList {
  rows: VirtualRow[];
  totalSize: number;
  /**
   * Attach to every rendered row: `ref={measure}` plus `data-key`, `data-start` and `data-size`
   * (the row's `key`, `start` and `size`).
   */
  measure: (element: HTMLElement | null) => (() => void) | undefined;
}

/** Used before the viewport has been laid out (first paint, and jsdom in tests). */
const FALLBACK_HEIGHT = 800;

/** The first index whose row ends after `offset`. */
function findIndex(starts: Float64Array, count: number, offset: number): number {
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid + 1] ?? 0) <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function useVirtualList({
  count,
  getKey,
  estimateSize,
  viewportRef,
  atEnd,
  overscan = 600,
}: VirtualListOptions): VirtualList {
  const [sizes, setSizes] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const atEndRef = useRef(atEnd);
  const observerRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    atEndRef.current = atEnd;
  }, [atEnd]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setScrollTop(viewport.scrollTop);
      });
    };
    const resize = new ResizeObserver(() => {
      setHeight(viewport.clientHeight);
      setScrollTop(viewport.scrollTop);
    });
    resize.observe(viewport);
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      viewport.removeEventListener("scroll", onScroll);
    };
  }, [viewportRef]);

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    },
    [],
  );

  const starts = useMemo(() => {
    const result = new Float64Array(count + 1);
    for (let i = 0; i < count; i++) {
      const key = String(getKey(i));
      result[i + 1] = (result[i] ?? 0) + (sizes.get(key) ?? estimateSize(i));
    }
    return result;
  }, [count, getKey, estimateSize, sizes]);

  const totalSize = starts[count] ?? 0;
  const visibleHeight = height > 0 ? height : FALLBACK_HEIGHT;
  const top = atEnd ? Math.max(0, totalSize - visibleHeight) : scrollTop;

  const rows: VirtualRow[] = [];
  if (count > 0) {
    const first = findIndex(starts, count, Math.max(0, top - overscan));
    const limit = top + visibleHeight + overscan;
    for (let i = first; i < count && (starts[i] ?? 0) < limit; i++) {
      const start = starts[i] ?? 0;
      rows.push({ index: i, key: getKey(i), start, size: (starts[i + 1] ?? start) - start });
    }
  }

  const measure = useCallback(
    (element: HTMLElement | null) => {
      if (!element || typeof ResizeObserver === "undefined") return undefined;
      const observer = (observerRef.current ??= new ResizeObserver((entries) => {
        const viewport = viewportRef.current;
        const changed: [string, number][] = [];
        let shift = 0;
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const key = el.dataset.key;
          const size = entry.borderBoxSize[0]?.blockSize ?? el.getBoundingClientRect().height;
          const previous = Number(el.dataset.size);
          if (key === undefined || size === 0 || size === previous) continue;
          changed.push([key, size]);
          // Rows above the visible area: keep what the reader looks at in place.
          if (viewport && Number(el.dataset.start) + previous <= viewport.scrollTop) {
            shift += size - previous;
          }
        }
        if (changed.length === 0) return;
        if (shift !== 0 && viewport && !atEndRef.current) viewport.scrollTop += shift;
        setSizes((prev) => {
          const next = new Map(prev);
          for (const [key, size] of changed) next.set(key, size);
          return next;
        });
      }));
      observer.observe(element);
      return () => {
        observer.unobserve(element);
      };
    },
    [viewportRef],
  );

  return { rows, totalSize, measure };
}

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { clampScroll, fitZoom, scrollToReveal, zoomAround, type View } from "../model";

interface Manual {
  pxPerFrame: number;
  scroll: number;
}

export interface ViewControl {
  view: View;
  /** True while the whole timeline is fitted to the width (it follows resizes). */
  fitted: boolean;
  fit: () => void;
  /** Zooms by `steps` (fractions allowed) keeping the frame under `anchorX` where it is. */
  zoom: (steps: number, anchorX: number) => void;
  scrollBy: (dx: number) => void;
  /** Scrolls only as far as needed to show `frame`. */
  reveal: (frame: number) => void;
}

/** The zoom and scroll of the tracks: fitted to the width until the user zooms or scrolls. */
export function useView(duration: number, width: number): ViewControl {
  const [manual, setManual] = useState<Manual | null>(null);
  const view: View = manual
    ? {
        pxPerFrame: manual.pxPerFrame,
        scroll: clampScroll(manual.scroll, duration, manual.pxPerFrame, width),
      }
    : { pxPerFrame: fitZoom(duration, width), scroll: 0 };
  const latest = useRef({ view, duration, width });
  useLayoutEffect(() => {
    latest.current = { view, duration, width };
  });

  const fit = useCallback(() => setManual(null), []);
  const zoom = useCallback((steps: number, anchorX: number) => {
    const { view: now, duration: d, width: w } = latest.current;
    const next = zoomAround(now, steps, anchorX, d, w);
    setManual({ pxPerFrame: next.pxPerFrame, scroll: next.scroll });
  }, []);
  const scrollBy = useCallback((dx: number) => {
    const { view: now, duration: d, width: w } = latest.current;
    const scroll = clampScroll(now.scroll + dx, d, now.pxPerFrame, w);
    if (scroll !== now.scroll) setManual({ pxPerFrame: now.pxPerFrame, scroll });
  }, []);
  const reveal = useCallback((frame: number) => {
    const { view: now, duration: d, width: w } = latest.current;
    if (w <= 0) return;
    const scroll = scrollToReveal(now, frame, d, w);
    if (scroll !== now.scroll) setManual({ pxPerFrame: now.pxPerFrame, scroll });
  }, []);
  return { view, fitted: manual === null, fit, zoom, scrollBy, reveal };
}

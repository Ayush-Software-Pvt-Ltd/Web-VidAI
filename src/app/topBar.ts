/**
 * The width variants of the window's top bar (`topbar-max-<N>:`, declared in src/styles.css).
 */
import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Widths (CSS px) below which the top bar's content changes, used as `topbar-max-<N>:` variants
 * (the `@custom-variant` list at the top of src/styles.css must match it).
 */
export const TOP_BAR_BREAKPOINTS = [680, 760, 800, 820, 900, 960, 1100] as const;

/** The `data-topbar` tokens for a top bar `width` CSS px wide: every breakpoint it is below. */
export function topBarTokens(width: number): string {
  return TOP_BAR_BREAKPOINTS.filter((b) => width < b)
    .map((b) => `max-${b}`)
    .join(" ");
}

/**
 * Keeps the `data-topbar` tokens of the top bar in step with its content width. This stands in
 * for CSS container queries, which WebKit evaluates against the zoomed width under the page zoom
 * of the text size (src/styles.css explains it); a ResizeObserver reports CSS px at every zoom.
 */
export function useTopBarTokens(ref: RefObject<HTMLElement | null>): string {
  const [tokens, setTokens] = useState("");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      setTokens(topBarTokens(el.clientWidth - (Number.isNaN(padding) ? 0 : padding)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return tokens;
}

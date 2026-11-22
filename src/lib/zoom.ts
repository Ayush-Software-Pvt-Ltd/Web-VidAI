/**
 * Screen px and layout px under the page zoom (CSS `zoom` on <html>, `applyPageZoom` in
 * src/app/appearance.ts). Chromium reports pointer coordinates (`clientX`, `clientY`) and
 * `getBoundingClientRect()` in screen px, while styles, `offsetWidth` and `ResizeObserver` are in
 * layout px: at a zoom of 1.5 a drag of 30 screen px is 20 layout px. Code that moves something
 * by a pointer distance, or sizes something from a measured rectangle, converts with these.
 */

/**
 * How many screen px one layout px of `el` is: the page zoom as `el` sees it (nested zoom
 * included), 1 without zoom, in a browser that reports layout px, and when `el` has no size.
 * Measure an element that is wide, `offsetWidth` is a whole number.
 */
export function screenPerLayout(el: HTMLElement): number {
  const layout = el.offsetWidth;
  const screen = el.getBoundingClientRect().width;
  return layout > 0 && screen > 0 ? screen / layout : 1;
}

/** `screenPx` (a pointer distance, a measured rectangle) in the layout px of `el`. */
export function toLayoutPx(screenPx: number, el: HTMLElement): number {
  return screenPx / screenPerLayout(el);
}

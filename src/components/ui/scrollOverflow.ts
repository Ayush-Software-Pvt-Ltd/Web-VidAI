/** When a scroll area really scrolls (`ScrollArea`). */

/**
 * How far content must reach past the viewport to count as scrollable, in CSS px. Under the page
 * zoom of the text size the layout is fractional, and the browser rounds a viewport's height
 * and its scroll height separately (a 641.3 px viewport can report a scroll height of 642 with
 * content a quarter as tall), so a strict comparison sees overflow that is not there.
 */
export const OVERFLOW_TOLERANCE = 1;

/** Whether `viewport` really scrolls, vertically and horizontally. */
export function overflowOf(viewport: {
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
}): { x: boolean; y: boolean } {
  return {
    x: viewport.scrollWidth - viewport.clientWidth > OVERFLOW_TOLERANCE,
    y: viewport.scrollHeight - viewport.clientHeight > OVERFLOW_TOLERANCE,
  };
}

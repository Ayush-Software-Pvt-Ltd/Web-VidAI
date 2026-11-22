/**
 * Where the model list opens: always below its field (SPEC sections 7a and 9). Radix flips a
 * popover above its anchor when there is no room below, which covered the API URL and API Key
 * rows of the field that is low in the window. So before the list opens, `roomBelow` scrolls the
 * nearest scrolling ancestor of the field (the Settings pane) just far enough that the whole
 * list fits below it, and returns the height the list may take: at most `MAX_LIST_HEIGHT`, less
 * when the field cannot be scrolled further (the onboarding card does not scroll), and `null`
 * when the window is too short for any useful list (then the list may open above instead).
 * Rectangles and the window are in screen px, the heights in layout px (`src/lib/zoom.ts`).
 */
import { screenPerLayout } from "@/lib/zoom";

/** The tallest the whole list (search box, rows, footer) is, in layout px. */
export const MAX_LIST_HEIGHT = 260;
/** The least height worth opening below for (layout px): the search box, a few rows, the footer. */
const MIN_LIST_HEIGHT = 140;
/**
 * The gap between the field and the list (`sideOffset` of the popover). The gaps are screen px:
 * the popper wrapper undoes the page zoom (src/styles.css), only the list itself is zoomed.
 */
const SIDE_OFFSET = 3;
/** The gap kept between the list and the window edge (`collisionPadding`). */
const EDGE_GAP = 8;

/** The nearest ancestor of `el` that scrolls vertically, or `null`. */
export function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/**
 * Scrolls (without animation) so the list fits below `anchor` when it can, and returns the
 * height the list may take, `null` when even `MIN_LIST_HEIGHT` does not fit below.
 */
export function roomBelow(anchor: HTMLElement): number | null {
  const windowHeight = window.innerHeight;
  const zoom = screenPerLayout(anchor);
  const needed = (): number => {
    const bottom = anchor.getBoundingClientRect().bottom;
    return bottom + SIDE_OFFSET + MAX_LIST_HEIGHT * zoom + EDGE_GAP - windowHeight;
  };
  const missing = needed();
  const parent = scrollParentOf(anchor);
  if (missing > 0 && parent) {
    // Never scroll the field itself out of the top of what scrolls.
    const slack =
      anchor.getBoundingClientRect().top - parent.getBoundingClientRect().top - EDGE_GAP;
    const left = parent.scrollHeight - parent.clientHeight - parent.scrollTop;
    const by = Math.min(missing, Math.max(0, slack), Math.max(0, left));
    if (by > 0) parent.scrollTop += by;
  }
  const room =
    (windowHeight - anchor.getBoundingClientRect().bottom - SIDE_OFFSET - EDGE_GAP) / zoom;
  if (room < MIN_LIST_HEIGHT) return null;
  return Math.min(MAX_LIST_HEIGHT, Math.floor(room));
}

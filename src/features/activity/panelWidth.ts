/**
 * Width of the activity panel: what the user chose by dragging (or with the keyboard), kept across
 * launches in localStorage, and clamped to what the window allows right now.
 */

export const PANEL_MIN_WIDTH = 300;
export const PANEL_MAX_WIDTH = 640;
/** Share of the content area (list and panel) the panel takes until the user resizes it. */
const DEFAULT_SHARE = 0.36;
const DEFAULT_MAX = 400;
/** Used before the content area is measured (and in jsdom, which has no layout). */
const FALLBACK_WIDTH = 340;

const STORAGE_KEY = "vidai.activityPanelWidth";

/**
 * The widths the panel may take when the content area (list plus panel) is `available` px wide
 * and the list needs at least `minContentWidth`. `available` is 0 while unknown.
 */
export function widthRange(available: number, minContentWidth: number) {
  const max =
    available > 0
      ? Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, available - minContentWidth))
      : PANEL_MAX_WIDTH;
  return { min: PANEL_MIN_WIDTH, max };
}

export function clampWidth(width: number, range: { min: number; max: number }): number {
  return Math.round(Math.min(range.max, Math.max(range.min, width)));
}

/** The width before the user resized the panel: a share of the content area, within bounds. */
export function defaultWidth(available: number, minContentWidth: number): number {
  if (available <= 0) return FALLBACK_WIDTH;
  const range = widthRange(available, minContentWidth);
  return clampWidth(Math.min(DEFAULT_MAX, available * DEFAULT_SHARE), range);
}

/** The width the user chose, or `null` when they never resized the panel (or storage is off). */
export function loadStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function storeWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Storage can be unavailable; the width then lasts until the app quits.
  }
}

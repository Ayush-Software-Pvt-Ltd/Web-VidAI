/**
 * Appearance (SPEC section 16): the theme and the text size are kept per browser in local
 * storage, never on the server, so every person and every browser has their own.
 *
 * - `applyStoredAppearance()` runs first in `main.tsx`, before React renders, so the page never
 *   flashes the wrong theme or size (an inline script in `index.html` would be refused by the
 *   Content-Security-Policy, which allows scripts only from the server itself).
 * - `useAppearance()` (mounted by the shell) keeps `data-theme` and the page zoom of <html> in
 *   step with the stored choice and gives the page its layout floor; other tabs of the same
 *   browser follow through the `storage` event.
 * - `useAppearanceSettings()`, `saveAppearance()` and `stepTextSize()` are what the Appearance
 *   section of Settings uses.
 *
 * The text size is applied as CSS `zoom` on <html> (`zoomFactor`), and `--page-zoom` tells the
 * styles about it: popups (menus, selects, tooltips) are positioned with it so they stay at their
 * anchor, and the size limits of dialogs, sheets and toasts divide the viewport by it. Cmd/Ctrl
 * with `=`, `+`, `-` and `0` stay with the browser's own zoom.
 */
import { useLayoutEffect, useSyncExternalStore } from "react";
import { TEXT_SIZE, type Theme } from "@/lib/types";

export type TextStep = "bigger" | "smaller" | "default";

/** What is kept per browser. */
export interface Appearance {
  theme: Theme;
  /** In px, between `TEXT_SIZE.min` and `TEXT_SIZE.max`. */
  textSize: number;
}

/** The key in local storage (a JSON object with `theme` and `textSize`). */
export const APPEARANCE_KEY = "vidai.appearance";

export const DEFAULT_APPEARANCE: Appearance = { theme: "system", textSize: TEXT_SIZE.default };

const THEMES: readonly Theme[] = ["system", "light", "dark"];

/** `size` as a whole number within the allowed range. */
export function clampTextSize(size: number): number {
  return Math.min(TEXT_SIZE.max, Math.max(TEXT_SIZE.min, Math.round(size)));
}

/** The text size after one step, within range. */
export function nextTextSize(current: number, step: TextStep): number {
  return clampTextSize(
    step === "default" ? TEXT_SIZE.default : current + (step === "bigger" ? 1 : -1),
  );
}

/** The page zoom the page uses for a text size. */
export function zoomFactor(textSize: number): number {
  return clampTextSize(textSize) / TEXT_SIZE.base;
}

/** Reads what a stored string says; anything missing or damaged falls back to the defaults. */
export function parseAppearance(raw: string | null): Appearance {
  if (raw === null) return DEFAULT_APPEARANCE;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_APPEARANCE;
    const { theme, textSize } = value as { theme?: unknown; textSize?: unknown };
    return {
      theme: THEMES.find((candidate) => candidate === theme) ?? DEFAULT_APPEARANCE.theme,
      textSize:
        typeof textSize === "number" && Number.isFinite(textSize)
          ? clampTextSize(textSize)
          : DEFAULT_APPEARANCE.textSize,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(APPEARANCE_KEY);
  } catch {
    // Storage can be off (private mode, policy): the defaults apply and nothing is kept.
    return null;
  }
}

// The snapshot must be the same object while nothing changed, so it is remembered by raw text.
let lastRaw: string | null | undefined;
let lastAppearance: Appearance = DEFAULT_APPEARANCE;
// What a browser without usable storage keeps for this page only.
let unstored: Appearance | null = null;

/** The appearance of this browser now. */
export function getAppearance(): Appearance {
  const raw = readRaw();
  if (raw === null && unstored) return unstored;
  if (raw !== lastRaw) {
    lastRaw = raw;
    lastAppearance = parseAppearance(raw);
  }
  return lastAppearance;
}

const listeners = new Set<() => void>();

function notify() {
  for (const listener of [...listeners]) listener();
}

function onStorage(event: StorageEvent) {
  // Another tab changed it (a null key means the whole storage was cleared).
  if (event.key === null || event.key === APPEARANCE_KEY) notify();
}

/** Calls `listener` when the appearance changes here or in another tab of this browser. */
export function subscribeAppearance(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

/** Keeps a change of the theme and/or the text size and tells everything that shows them. */
export function saveAppearance(change: Partial<Appearance>): Appearance {
  const current = getAppearance();
  const next: Appearance = {
    theme: change.theme ?? current.theme,
    textSize: clampTextSize(change.textSize ?? current.textSize),
  };
  try {
    window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify(next));
    unstored = null;
  } catch {
    unstored = next;
  }
  notify();
  return next;
}

/** Changes the text size by one step (not below the smallest or above the largest). */
export function stepTextSize(step: TextStep): Appearance {
  return saveAppearance({ textSize: nextTextSize(getAppearance().textSize, step) });
}

/** The appearance of this browser, re-rendering when it changes (also from another tab). */
export function useAppearanceSettings(): Appearance {
  return useSyncExternalStore(subscribeAppearance, getAppearance, () => DEFAULT_APPEARANCE);
}

/**
 * Sets the page zoom on <html>; 1 removes it. `--page-zoom` tells the styles (src/styles.css, and
 * the viewport-sized dialogs) about it, because CSS `zoom` does not scale `vw`/`vh` and makes
 * anchored popups land off their anchor.
 */
export function applyPageZoom(factor: number, root: HTMLElement = document.documentElement) {
  if (factor === 1) {
    root.style.removeProperty("zoom");
    root.style.removeProperty("--page-zoom");
  } else {
    root.style.setProperty("zoom", String(factor));
    root.style.setProperty("--page-zoom", String(factor));
  }
}

/** The smallest layout the UI is designed for, in CSS px at the base text size. */
export const MIN_LAYOUT_SIZE = { width: 980, height: 620 } as const;

/**
 * Gives the page its floor (`MIN_LAYOUT_SIZE`): `data-web-page` on <html> and the two custom
 * properties tell src/styles.css to keep #root at least that large (in zoomed CSS px, so 980 x
 * zoom by 620 x zoom on screen) and to let the page scroll in a smaller browser window. Fixed
 * layers are not part of the page: they follow the visible window. Returns the undo.
 */
export function applyWebPageFloor(root: HTMLElement = document.documentElement): () => void {
  root.dataset.webPage = "";
  root.style.setProperty("--page-min-width", `${MIN_LAYOUT_SIZE.width}px`);
  root.style.setProperty("--page-min-height", `${MIN_LAYOUT_SIZE.height}px`);
  return () => {
    delete root.dataset.webPage;
    root.style.removeProperty("--page-min-width");
    root.style.removeProperty("--page-min-height");
  };
}

/** Sets `data-theme` on <html>: the theme to force, or none to follow the system. */
export function applyThemeAttribute(theme: Theme, root: HTMLElement = document.documentElement) {
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

/** Applies the stored appearance and the page floor to <html>; call it before the first render. */
export function applyStoredAppearance(root: HTMLElement = document.documentElement): void {
  const { theme, textSize } = getAppearance();
  applyThemeAttribute(theme, root);
  applyPageZoom(zoomFactor(textSize), root);
  applyWebPageFloor(root);
}

/**
 * Keeps <html> in step with the stored appearance for as long as the shell is mounted: the theme
 * attribute, the page zoom and the page floor. They go back to plain when it unmounts.
 */
export function useAppearance(): void {
  const { theme, textSize } = useAppearanceSettings();

  useLayoutEffect(() => applyWebPageFloor(), []);

  useLayoutEffect(() => {
    applyPageZoom(zoomFactor(textSize));
    return () => {
      applyPageZoom(1);
    };
  }, [textSize]);

  useLayoutEffect(() => {
    applyThemeAttribute(theme);
    return () => {
      applyThemeAttribute("system");
    };
  }, [theme]);
}

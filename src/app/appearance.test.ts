import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEXT_SIZE } from "@/lib/types";
import {
  APPEARANCE_KEY,
  applyStoredAppearance,
  clampTextSize,
  DEFAULT_APPEARANCE,
  getAppearance,
  nextTextSize,
  parseAppearance,
  saveAppearance,
  stepTextSize,
  useAppearance,
  useAppearanceSettings,
  zoomFactor,
} from "./appearance";

const root = document.documentElement;

function reset() {
  window.localStorage.clear();
  root.removeAttribute("style");
  root.removeAttribute("data-theme");
  delete root.dataset.webPage;
}

beforeEach(reset);
afterEach(reset);

describe("the numbers", () => {
  it("steps and clamps the text size", () => {
    expect(nextTextSize(15, "bigger")).toBe(16);
    expect(nextTextSize(15, "smaller")).toBe(14);
    expect(nextTextSize(19, "default")).toBe(TEXT_SIZE.default);
    expect(nextTextSize(TEXT_SIZE.max, "bigger")).toBe(TEXT_SIZE.max);
    expect(nextTextSize(TEXT_SIZE.min, "smaller")).toBe(TEXT_SIZE.min);
    expect(clampTextSize(99)).toBe(TEXT_SIZE.max);
    expect(clampTextSize(1)).toBe(TEXT_SIZE.min);
  });

  it("zooms by the text size over the base size", () => {
    expect(zoomFactor(TEXT_SIZE.base)).toBe(1);
    expect(zoomFactor(26)).toBeCloseTo(20 / 13, 6);
    expect(zoomFactor(1)).toBeCloseTo(11 / 13, 6);
  });
});

describe("what is stored", () => {
  it("falls back to the defaults for anything missing or damaged", () => {
    expect(getAppearance()).toEqual(DEFAULT_APPEARANCE);
    for (const raw of ["", "nope", "[]", "null", '{"theme":"neon","textSize":"big"}']) {
      expect(parseAppearance(raw)).toEqual(DEFAULT_APPEARANCE);
    }
    expect(parseAppearance('{"theme":"dark","textSize":99}')).toEqual({
      theme: "dark",
      textSize: TEXT_SIZE.max,
    });
  });

  it("keeps a change in local storage, never anywhere else", () => {
    saveAppearance({ theme: "dark" });
    stepTextSize("bigger");
    expect(JSON.parse(window.localStorage.getItem(APPEARANCE_KEY) ?? "{}")).toEqual({
      theme: "dark",
      textSize: TEXT_SIZE.default + 1,
    });
    expect(getAppearance()).toEqual({ theme: "dark", textSize: TEXT_SIZE.default + 1 });
    // The same object while nothing changed (a stable snapshot for React).
    expect(getAppearance()).toBe(getAppearance());
  });
});

describe("applied to the page", () => {
  it("applies the stored choice before anything renders", () => {
    window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme: "light", textSize: 18 }));
    applyStoredAppearance();
    expect(root.dataset.theme).toBe("light");
    expect(parseFloat(root.style.zoom)).toBeCloseTo(18 / 13, 4);
    expect(root.dataset.webPage).toBe("");
    expect(root.style.getPropertyValue("--page-min-width")).toBe("980px");
    expect(root.style.getPropertyValue("--page-min-height")).toBe("620px");
  });

  it("follows a change at once and goes back to plain when the shell goes away", () => {
    const { unmount } = renderHook(() => useAppearance());
    expect(root.dataset.theme).toBeUndefined();
    expect(parseFloat(root.style.zoom)).toBeCloseTo(zoomFactor(TEXT_SIZE.default), 4);
    act(() => {
      saveAppearance({ theme: "dark", textSize: 12 });
    });
    expect(root.dataset.theme).toBe("dark");
    expect(parseFloat(root.style.zoom)).toBeCloseTo(12 / 13, 4);
    expect(parseFloat(root.style.getPropertyValue("--page-zoom"))).toBeCloseTo(12 / 13, 4);
    unmount();
    expect(root.dataset.theme).toBeUndefined();
    expect(root.style.zoom).toBe("");
    expect(root.dataset.webPage).toBeUndefined();
  });

  it("removes the zoom at exactly the base size", () => {
    const { unmount } = renderHook(() => useAppearance());
    act(() => {
      saveAppearance({ textSize: TEXT_SIZE.base });
    });
    expect(root.style.zoom).toBe("");
    expect(root.style.getPropertyValue("--page-zoom")).toBe("");
    unmount();
  });

  it("follows another tab of the same browser", () => {
    const { result, unmount } = renderHook(() => {
      useAppearance();
      return useAppearanceSettings();
    });
    expect(result.current.theme).toBe("system");
    act(() => {
      // What another tab does: it writes, and this tab only gets the event.
      window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme: "dark", textSize: 17 }));
      window.dispatchEvent(new StorageEvent("storage", { key: APPEARANCE_KEY }));
    });
    expect(result.current).toEqual({ theme: "dark", textSize: 17 });
    expect(root.dataset.theme).toBe("dark");
    expect(parseFloat(root.style.zoom)).toBeCloseTo(17 / 13, 4);
    act(() => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(result.current).toEqual(DEFAULT_APPEARANCE);
    unmount();
  });
});

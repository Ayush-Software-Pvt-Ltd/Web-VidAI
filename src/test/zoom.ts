import { vi } from "vitest";

export interface LayoutSize {
  width: number;
  height: number;
}

/**
 * Makes jsdom behave like Chromium under a page zoom of `zoom`: `offsetWidth` and `offsetHeight`
 * are the layout size `sizeOf` gives for an element, and `getBoundingClientRect()` is that size
 * times `zoom` (screen px). Pointer events of a test are then in screen px as well.
 */
export function mockPageZoom(
  zoom: number,
  sizeOf: (el: HTMLElement) => LayoutSize = () => ({ width: 100, height: 100 }),
): void {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return Math.round(sizeOf(this).width);
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return Math.round(sizeOf(this).height);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const { width, height } = sizeOf(this);
    return new DOMRect(0, 0, width * zoom, height * zoom);
  });
}

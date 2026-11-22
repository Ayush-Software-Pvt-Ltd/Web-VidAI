import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_LIST_HEIGHT, roomBelow, scrollParentOf } from "./modelListPlacement";

/** A scrolling pane of `clientHeight` at the top of a 700 px window, with a field in it. */
function setup({
  scrollHeight,
  fieldTop,
  zoom = 1,
}: {
  scrollHeight: number;
  fieldTop: number;
  /** The page zoom: rectangles are in screen px, `offsetWidth` in layout px. */
  zoom?: number;
}) {
  const pane = document.createElement("div");
  pane.style.overflowY = "auto";
  const field = document.createElement("div");
  pane.append(field);
  document.body.append(pane);
  Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
  Object.defineProperty(pane, "clientHeight", { value: 700, configurable: true });
  Object.defineProperty(pane, "scrollHeight", { value: scrollHeight, configurable: true });
  pane.getBoundingClientRect = () => ({ top: 0, bottom: 700 }) as DOMRect;
  // The field moves up as the pane scrolls, like in a browser.
  Object.defineProperty(field, "offsetWidth", { value: 300, configurable: true });
  field.getBoundingClientRect = () =>
    ({
      top: fieldTop - pane.scrollTop,
      bottom: fieldTop - pane.scrollTop + 28,
      width: 300 * zoom,
    }) as DOMRect;
  return { pane, field };
}

describe("roomBelow", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("finds the nearest scrolling ancestor", () => {
    const { pane, field } = setup({ scrollHeight: 1400, fieldTop: 100 });
    expect(scrollParentOf(field)).toBe(pane);
  });

  it("leaves a field with room below where it is", () => {
    const { pane, field } = setup({ scrollHeight: 1400, fieldTop: 100 });
    expect(roomBelow(field)).toBe(MAX_LIST_HEIGHT);
    expect(pane.scrollTop).toBe(0);
  });

  it("scrolls a low field up so the list fits below it", () => {
    const { pane, field } = setup({ scrollHeight: 1400, fieldTop: 560 });
    expect(roomBelow(field)).toBe(MAX_LIST_HEIGHT);
    expect(pane.scrollTop).toBeGreaterThan(0);
    expect(field.getBoundingClientRect().bottom + 3 + MAX_LIST_HEIGHT).toBeLessThanOrEqual(700);
  });

  it("caps the height to the room when the pane cannot scroll further", () => {
    const { pane, field } = setup({ scrollHeight: 700, fieldTop: 500 });
    expect(roomBelow(field)).toBe(700 - 528 - 3 - 8);
    expect(pane.scrollTop).toBe(0);
  });

  it("gives up (null) when the window is too short for a useful list", () => {
    const { field } = setup({ scrollHeight: 700, fieldTop: 640 });
    expect(roomBelow(field)).toBeNull();
  });

  describe.each([1.1538, 1.54])("with the page zoomed to %s", (zoom) => {
    it("scrolls a low field up so the list, which is zoomed too, fits below it", () => {
      const { pane, field } = setup({ scrollHeight: 1400, fieldTop: 440, zoom });
      expect(roomBelow(field)).toBe(MAX_LIST_HEIGHT);
      expect(pane.scrollTop).toBeGreaterThan(0);
      // The gaps are screen px, the list is MAX_LIST_HEIGHT layout px high.
      const bottom = field.getBoundingClientRect().bottom;
      expect(bottom + 3 + MAX_LIST_HEIGHT * zoom + 8).toBeLessThanOrEqual(700 + 1e-6);
    });

    it("returns the room in layout px when the pane cannot scroll further", () => {
      const { field } = setup({ scrollHeight: 700, fieldTop: 372, zoom });
      expect(roomBelow(field)).toBe(Math.floor((700 - 400 - 3 - 8) / zoom));
    });

    it("gives up (null) when the room, in layout px, is too small for a useful list", () => {
      // 150 screen px of room: more than MIN_LIST_HEIGHT, but less in layout px.
      const { field } = setup({ scrollHeight: 700, fieldTop: 511, zoom });
      expect(roomBelow(field)).toBeNull();
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_LIST_HEIGHT, roomBelow, scrollParentOf } from "./modelListPlacement";

/** A scrolling pane of `clientHeight` at the top of a 700 px window, with a field in it. */
function setup({ scrollHeight, fieldTop }: { scrollHeight: number; fieldTop: number }) {
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
  field.getBoundingClientRect = () =>
    ({ top: fieldTop - pane.scrollTop, bottom: fieldTop - pane.scrollTop + 28 }) as DOMRect;
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
});

import { afterEach, describe, expect, it } from "vitest";
import {
  clampWidth,
  defaultWidth,
  loadStoredWidth,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  storeWidth,
  widthRange,
} from "./panelWidth";

// The content area (list and panel) next to the 236 px sidebar.
const AT_980 = 980 - 236;
const AT_1240 = 1240 - 236;
const LIST_MIN = 420;

afterEach(() => {
  window.localStorage.clear();
});

describe("panel width", () => {
  it("leaves the list its minimum and never goes below the panel's own", () => {
    expect(widthRange(AT_1240, LIST_MIN)).toEqual({ min: PANEL_MIN_WIDTH, max: 584 });
    expect(widthRange(AT_980, LIST_MIN)).toEqual({ min: PANEL_MIN_WIDTH, max: 324 });
    expect(widthRange(600, LIST_MIN)).toEqual({ min: PANEL_MIN_WIDTH, max: PANEL_MIN_WIDTH });
    expect(widthRange(2400, LIST_MIN).max).toBe(PANEL_MAX_WIDTH);
    // Not measured yet.
    expect(widthRange(0, LIST_MIN).max).toBe(PANEL_MAX_WIDTH);
  });

  it("defaults to a share of the content area", () => {
    expect(defaultWidth(AT_980, LIST_MIN)).toBe(300);
    expect(defaultWidth(AT_1240, LIST_MIN)).toBe(361);
    expect(defaultWidth(1800, LIST_MIN)).toBe(400);
  });

  it("clamps a chosen width to the current range", () => {
    expect(clampWidth(500, widthRange(AT_980, LIST_MIN))).toBe(324);
    expect(clampWidth(120, widthRange(AT_1240, LIST_MIN))).toBe(300);
    expect(clampWidth(410.4, widthRange(AT_1240, LIST_MIN))).toBe(410);
  });

  it("remembers the chosen width and ignores garbage", () => {
    expect(loadStoredWidth()).toBeNull();
    storeWidth(432.6);
    expect(loadStoredWidth()).toBe(433);
    storeWidth(null);
    expect(loadStoredWidth()).toBeNull();
    window.localStorage.setItem("vidai.activityPanelWidth", "wide");
    expect(loadStoredWidth()).toBeNull();
  });
});

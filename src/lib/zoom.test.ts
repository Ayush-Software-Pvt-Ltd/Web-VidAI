import { describe, expect, it } from "vitest";
import { mockPageZoom } from "@/test/zoom";
import { screenPerLayout, toLayoutPx } from "./zoom";

describe("screen px and layout px", () => {
  it.each([1, 1.1538, 1.54])("reads the zoom of an element (%s)", (zoom) => {
    mockPageZoom(zoom, () => ({ width: 400, height: 100 }));
    const el = document.createElement("div");
    expect(screenPerLayout(el)).toBeCloseTo(zoom, 3);
    expect(toLayoutPx(zoom * 30, el)).toBeCloseTo(30, 3);
  });

  it("is 1 for an element without a size", () => {
    mockPageZoom(1.54, () => ({ width: 0, height: 0 }));
    const el = document.createElement("div");
    expect(screenPerLayout(el)).toBe(1);
    expect(toLayoutPx(12, el)).toBe(12);
  });
});

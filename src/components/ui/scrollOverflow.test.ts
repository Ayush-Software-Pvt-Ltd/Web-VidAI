import { describe, expect, it } from "vitest";
import { overflowOf } from "./scrollOverflow";

const box = (scrollHeight: number, clientHeight: number, scrollWidth = 100, clientWidth = 100) => ({
  scrollHeight,
  clientHeight,
  scrollWidth,
  clientWidth,
});

describe("overflowOf", () => {
  it("ignores the rounding of a fractional layout", () => {
    // Measured in the app at text size 15: a list viewport with two rows.
    expect(overflowOf(box(642, 641))).toEqual({ x: false, y: false });
    expect(overflowOf(box(641, 641, 101, 100))).toEqual({ x: false, y: false });
  });

  it("sees content that really overflows", () => {
    expect(overflowOf(box(643, 641))).toEqual({ x: false, y: true });
    expect(overflowOf(box(2000, 641, 400, 100))).toEqual({ x: true, y: true });
  });
});

/// <reference types="node" />
// styles.css is read from disk (Vitest runs in the repository root): the test setup turns CSS
// imports off (`css: false`).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOP_BAR_BREAKPOINTS, topBarTokens } from "./topBar";

/** Every source file of the UI, tests excluded, by path. */
const sources = Object.entries(
  import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

describe("top bar width variants", () => {
  it("lists every breakpoint the bar is below", () => {
    expect(topBarTokens(1200)).toBe("");
    expect(topBarTokens(1100)).toBe("");
    expect(topBarTokens(1099.5)).toBe("max-1100");
    expect(topBarTokens(744)).toBe("max-760 max-800 max-820 max-900 max-960 max-1100");
    // The default window at the default text size: the job summary still fits.
    expect(topBarTokens(807)).toBe("max-820 max-900 max-960 max-1100");
    expect(topBarTokens(600)).toBe(TOP_BAR_BREAKPOINTS.map((b) => `max-${b}`).join(" "));
  });

  it("has one CSS variant per breakpoint", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const declared = [
      ...css.matchAll(
        /@custom-variant topbar-max-(\d+) \(&:where\(\[data-topbar~="max-(\d+)"\] \*\)\);/g,
      ),
    ];
    expect(declared.every((m) => m[1] === m[2])).toBe(true);
    expect(declared.map((m) => Number(m[1]))).toEqual([...TOP_BAR_BREAKPOINTS]);
  });

  it("is the only way the top bar adapts to its width", () => {
    const known = new Set<number>(TOP_BAR_BREAKPOINTS);
    expect(sources.length).toBeGreaterThan(50);
    for (const [file, text] of sources) {
      // Container queries misjudge widths under the page zoom of the text size (WebKit).
      expect(text, file).not.toMatch(/@(max-|min-)?\[\d+px\]\/topbar:|@container\/topbar/);
      for (const m of text.matchAll(/topbar-max-(\d+):/g)) {
        expect(known.has(Number(m[1])), `${file}: topbar-max-${m[1]}`).toBe(true);
      }
    }
  });
});

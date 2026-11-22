import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";
import { runTestCleanups } from "./cleanup";

// `findBy*` and `waitFor` wait for a condition and return as soon as it holds, so their limit
// only catches things that never happen. The default (1 s) assumes a fast, idle machine; keep
// it well below the test timeout in vite.config.ts so a miss reports what was not found.
configure({ asyncUtilTimeout: 20_000 });

afterEach(() => {
  // Unmount first, then stop the stores and mock backends the components used.
  cleanup();
  runTestCleanups();
});

// jsdom lacks these browser APIs that Radix UI uses.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const g = globalThis as { ResizeObserver?: unknown };
g.ResizeObserver ??= ResizeObserverStub;
const proto = Element.prototype as Partial<Element>;
if (typeof proto.scrollIntoView !== "function") proto.scrollIntoView = () => {};
if (typeof proto.hasPointerCapture !== "function") proto.hasPointerCapture = () => false;
if (typeof proto.setPointerCapture !== "function") proto.setPointerCapture = () => {};
if (typeof proto.releasePointerCapture !== "function") proto.releasePointerCapture = () => {};

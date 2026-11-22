/**
 * The whole app in a test: the real `App` (shell, address bar, every real screen) over a mock
 * backend, opened at an address, driven by `userEvent`.
 *
 * ```tsx
 * const { user, app } = await openApp({ path: "/settings", user: "user" });
 * ```
 */
import { afterEach, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import type { ScenarioName } from "@/lib/mock";
import { App } from "../App";
import { setupApp, type SetupOptions } from "./app";

export interface OpenOptions extends Omit<SetupOptions, "load"> {
  /** The address the page is opened at. Default `/`. */
  path?: string;
  scenarios?: ScenarioName[];
}

/** Opens the app at `path` as `user` (signed in by default) and returns the user and the app. */
export async function openApp({
  path = "/",
  scenarios = ["default"],
  ...options
}: OpenOptions = {}) {
  window.history.replaceState(null, "", path);
  const app = await setupApp(scenarios, { ...options, load: false });
  const view = app.render(<App />);
  return { user: userEvent.setup(), app, backend: app.backend, ...view };
}

/** Puts the address bar and the stored settings back before and after every test of a file. */
export function resetAddress(): void {
  const reset = () => {
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
  };
  beforeEach(reset);
  afterEach(reset);
}

import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupApp } from "@/test/app";
import { findMainPage, findSettingsPage, querySettingsPage } from "@/test/pages";
import { App } from "../App";
import { APPEARANCE_KEY } from "./appearance";
import { RESCAN_THROTTLE_MS } from "./useRescanOnFocus";

const root = document.documentElement;

function reset() {
  window.localStorage.clear();
  root.removeAttribute("style");
  root.removeAttribute("data-theme");
  delete root.dataset.webPage;
  window.history.replaceState(null, "", "/");
}

beforeEach(reset);
afterEach(() => {
  reset();
  vi.useRealTimers();
});

describe("the page in a browser", () => {
  it("gives the page its layout floor and the stored theme and size, and takes them away again", async () => {
    window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme: "dark", textSize: 26 }));
    const app = await setupApp(["default"], { load: false });
    const { unmount } = app.render(<App />);
    await findMainPage();
    expect(root.dataset.webPage).toBe("");
    expect(root.style.getPropertyValue("--page-min-width")).toBe("980px");
    expect(root.dataset.theme).toBe("dark");
    expect(parseFloat(root.style.zoom)).toBeCloseTo(20 / 13, 4);
    unmount();
    expect(root.dataset.webPage).toBeUndefined();
    expect(root.dataset.theme).toBeUndefined();
    expect(root.style.zoom).toBe("");
  });

  it("leaves Cmd+, to the browser on a Mac", async () => {
    // jsdom reads as a Mac: the browser keeps Cmd+, for its own settings.
    const app = await setupApp(["default"], { load: false });
    app.render(<App />);
    await findMainPage();
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(querySettingsPage()).toBeNull();
    expect(app.store.getState().view).toBe("main");
  });

  it("takes Ctrl+, on Windows and toggles Settings back", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0)");
    const user = userEvent.setup();
    const app = await setupApp(["default"], { load: false });
    app.render(<App />);
    await findMainPage();
    await user.keyboard("{Control>},{/Control}");
    await findSettingsPage();
    await user.keyboard("{Control>},{/Control}");
    expect(await findMainPage()).toBeInTheDocument();
  });

  it("does not take the shortcut on the sign-in page", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0)");
    const app = await setupApp(["signed-out"], { user: null, load: false });
    app.render(<App />);
    await screen.findByRole("button", { name: "Sign in" });
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    expect(app.store.getState().view).toBe("main");
  });
});

describe("the library is scanned again when the person comes back", () => {
  it("rescans on focus, at most once per throttle window, only when signed in", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = await setupApp(["default"], { load: false });
    app.render(<App />);
    await findMainPage();
    const refresh = vi.spyOn(app.store.getState(), "refreshLibrary").mockResolvedValue(undefined);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESCAN_THROTTLE_MS + 10);
    });
    fireEvent.focus(window);
    fireEvent.focus(window);
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESCAN_THROTTLE_MS + 10);
    });
    fireEvent.focus(window);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("does nothing while signed out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const app = await setupApp(["signed-out"], { user: null, load: false });
    app.render(<App />);
    await screen.findByRole("button", { name: "Sign in" });
    const refresh = vi.spyOn(app.store.getState(), "refreshLibrary").mockResolvedValue(undefined);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RESCAN_THROTTLE_MS + 10);
    });
    fireEvent.focus(window);
    expect(refresh).not.toHaveBeenCalled();
  });
});

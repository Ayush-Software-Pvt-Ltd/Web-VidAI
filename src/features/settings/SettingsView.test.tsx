import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsTarget } from "@/lib/store";
import { setupApp } from "@/test/app";
import { SettingsView } from "./SettingsView";

beforeEach(() => {
  window.history.replaceState(null, "", "/settings/channels");
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
});

const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36";

/** `agent` is the browser's user agent: Windows gets Ctrl+, from the page, a Mac keeps Cmd+, for itself. */
async function setup(open?: SettingsTarget, agent = WINDOWS) {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(agent);
  const app = await setupApp(["default"], { user: "user" });
  act(() => {
    app.store.getState().openSettings(open);
  });
  const view = app.render(<SettingsView />);
  return { user: userEvent.setup(), ...app, unmount: view.unmount };
}

const nav = () => screen.getByRole("navigation", { name: "Settings" });
const NAME = "Travel Diary";
const EDITED = `${NAME}edited`;
const draft = () => screen.getByRole("textbox", { name: "Channel name" });
const question = () => screen.findByRole("dialog", { name: `Save changes to “${NAME}”?` });

describe("Settings frame", () => {
  it("lists Appearance, Channels and Import and Export and shows the section of the store", async () => {
    const { store } = await setup({ section: "channels" });
    const labels = [...nav().querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Appearance", "Channels", "Import and Export"]);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Channels");
    expect(within(nav()).getByRole("button", { name: "Channels" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(draft()).toHaveValue(NAME);
    expect(store.getState().settingsSection).toBe("channels");
  });

  it("opens the section the address named", async () => {
    const app = await setupApp(["default"], { user: "user" });
    act(() => {
      app.store.getState().goTo({ view: "settings", section: "importExport" });
    });
    app.render(<SettingsView />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Import and Export");
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
  });

  it("switches sections through the store, so the address follows", async () => {
    const { user, store } = await setup({ section: "channels" });
    await user.click(within(nav()).getByRole("button", { name: "Appearance" }));
    expect(store.getState().settingsSection).toBe("appearance");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Appearance");
    expect(screen.getByRole("group", { name: "Text size" })).toBeInTheDocument();
    await user.click(within(nav()).getByRole("button", { name: "Import and Export" }));
    expect(store.getState().settingsSection).toBe("importExport");
    expect(screen.getByRole("button", { name: "Import" })).toBeInTheDocument();
  });

  it("follows a section the address changed to", async () => {
    const { store } = await setup({ section: "channels" });
    act(() => {
      store.getState().goTo({ view: "settings", section: "appearance" });
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Appearance");
  });

  it("closes with Done, Esc and Ctrl+,", async () => {
    const { user, store } = await setup({ section: "appearance" });
    await user.keyboard("{Escape}");
    expect(store.getState().view).toBe("main");
    act(() => {
      store.getState().setView("settings");
    });
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(store.getState().view).toBe("main");
    act(() => {
      store.getState().setView("settings");
    });
    fireEvent.keyDown(document.body, { key: ",", ctrlKey: true });
    expect(store.getState().view).toBe("main");
  });

  it("leaves Cmd+, to the Mac browser", async () => {
    const mac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
    const { store } = await setup({ section: "appearance" }, mac);
    fireEvent.keyDown(document.body, { key: ",", metaKey: true });
    expect(store.getState().view).toBe("settings");
  });

  it("takes the target it was opened with and clears it", async () => {
    const { store } = await setup({ section: "channels", videoType: "short" });
    expect(screen.getByRole("textbox", { name: "Short 9:16 prompt" })).toBeInTheDocument();
    expect(store.getState().settingsTarget).toBeNull();
    act(() => {
      store.getState().openSettings({ section: "channels", videoType: "long" });
    });
    expect(await screen.findByRole("textbox", { name: "Long 16:9 prompt" })).toBeInTheDocument();
    expect(store.getState().settingsTarget).toBeNull();
  });
});

describe("Settings frame: the unsaved-changes guard", () => {
  async function dirty() {
    const ctx = await setup({ section: "channels" });
    await ctx.user.type(draft(), "edited");
    return ctx;
  }

  it("Stay keeps the draft and the section when another section is chosen", async () => {
    const { user, store } = await dirty();
    await user.click(within(nav()).getByRole("button", { name: "Appearance" }));
    await question();
    expect(
      screen.getByText("You changed the name. They are lost unless you save them."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(draft()).toHaveValue(EDITED);
    expect(store.getState().settingsSection).toBe("channels");
  });

  it("Discard drops the draft and switches", async () => {
    const { user, store } = await dirty();
    await user.click(within(nav()).getByRole("button", { name: "Import and Export" }));
    await question();
    await user.click(screen.getByRole("button", { name: "Discard Changes" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Import and Export");
    expect(store.getState().settingsSection).toBe("importExport");
    // Back in Channels the draft is gone.
    await user.click(within(nav()).getByRole("button", { name: "Channels" }));
    expect(draft()).toHaveValue(NAME);
  });

  it("Save saves, then switches", async () => {
    const { user, store } = await dirty();
    await user.click(within(nav()).getByRole("button", { name: "Appearance" }));
    await question();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(store.getState().settingsSection).toBe("appearance");
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Appearance");
  });

  it("guards a section the address changed to: Stay puts the address back", async () => {
    const { user, store } = await dirty();
    act(() => {
      store.getState().goTo({ view: "settings", section: "appearance" });
    });
    await question();
    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(store.getState().settingsSection).toBe("channels");
    expect(draft()).toHaveValue(EDITED);
  });

  it("guards a new target while a draft is open", async () => {
    const { user, store } = await dirty();
    act(() => {
      store.getState().openSettings({ section: "channels", videoType: "short" });
    });
    await question();
    await user.click(screen.getByRole("button", { name: "Discard Changes" }));
    expect(screen.getByRole("textbox", { name: "Short 9:16 prompt" })).toBeInTheDocument();
    expect(draft()).toHaveValue(NAME);
  });

  it("guards Esc, Done and Ctrl+, from leaving Settings", async () => {
    const { user, store } = await dirty();
    // Esc in the text field only leaves the field; a second Esc leaves the screen.
    await user.keyboard("{Escape}");
    expect(store.getState().view).not.toBe("main");
    await user.keyboard("{Escape}");
    await question();
    expect(store.getState().view).toBe("settings");
    await user.click(screen.getByRole("button", { name: "Stay" }));

    await user.click(screen.getByRole("button", { name: "Done" }));
    await question();
    await user.click(screen.getByRole("button", { name: "Stay" }));

    fireEvent.keyDown(document.body, { key: ",", ctrlKey: true });
    await question();
    expect(store.getState().view).toBe("settings");
    await user.click(screen.getByRole("button", { name: "Discard Changes" }));
    expect(store.getState().view).toBe("main");
  });

  describe("the browser's Back", () => {
    let seen: string[];
    const onPop = () => {
      seen.push(window.location.pathname);
    };
    beforeEach(() => {
      seen = [];
      window.history.replaceState(null, "", "/");
      window.history.pushState(null, "", "/settings/channels");
      window.addEventListener("popstate", onPop);
    });
    afterEach(() => {
      window.removeEventListener("popstate", onPop);
    });

    const back = async () => {
      act(() => {
        window.history.back();
      });
      await waitFor(() => {
        expect(window.location.pathname).not.toBe("");
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
    };

    it("goes through when nothing is unsaved", async () => {
      await setup({ section: "channels" });
      await back();
      expect(seen).toEqual(["/"]);
    });

    it("asks first, keeps the address, and goes after Discard", async () => {
      const { user } = await setup({ section: "channels" });
      await user.type(draft(), "edited");
      await back();
      await question();
      // The shell (a listener after the guard) has not been told, and the address is back.
      expect(seen).toEqual([]);
      expect(window.location.pathname).toBe("/settings/channels");
      await user.click(screen.getByRole("button", { name: "Discard Changes" }));
      expect(seen).toEqual(["/"]);
      expect(window.location.pathname).toBe("/");
    });

    it("Stay leaves everything as it was", async () => {
      const { user } = await setup({ section: "channels" });
      await user.type(draft(), "edited");
      await back();
      await question();
      await user.click(screen.getByRole("button", { name: "Stay" }));
      expect(seen).toEqual([]);
      expect(window.location.pathname).toBe("/settings/channels");
      expect(draft()).toHaveValue(EDITED);
    });
  });

  it("asks the browser before the tab is closed or reloaded, only with unsaved changes", async () => {
    const { user } = await setup({ section: "channels" });
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    await user.type(draft(), "edited");
    const unsaved = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unsaved);
    expect(unsaved.defaultPrevented).toBe(true);
  });

  it("stops asking once the screen is gone", async () => {
    const { unmount } = await dirty();
    unmount();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

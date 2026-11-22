/** The main page with the real library, activity panel, history pages, job sheets and footer. */
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLibraryView } from "@/features/library/viewStore";
import { setupApp, type TestApp } from "@/test/app";
import { MainWindow } from "./MainWindow";

let app: TestApp;

const HAIR = "Hair Oil Review";
const SERUM = "Serum Launch";

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  window.localStorage.clear();
  useLibraryView.getState().reset();
  app = await setupApp(["default"]);
  app.render(<MainWindow />);
});

const activity = () => screen.queryByRole("complementary", { name: "Activity" });
const rowButton = (name: string) => screen.getByRole("button", { name });

async function openPanel(user: ReturnType<typeof userEvent.setup>, name = HAIR) {
  await user.click(rowButton(name));
  return screen.findByRole("complementary", { name: "Activity" });
}

describe("the main page", () => {
  it("puts the library together: sidebar, top bar, list, footer", () => {
    expect(screen.getByRole("navigation", { name: "Channels" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search videos" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Filter videos" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Videos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Usage limits/ })).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", {
        name: "Archive, Edit Log, Disk Cleanup, Settings and Admin",
      }),
    ).toBeInTheDocument();
    expect(activity()).toBeNull();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  });

  it("focuses search with the search shortcut, filters the list, and Escape clears it", async () => {
    const user = userEvent.setup();
    await user.keyboard("{Meta>}f{/Meta}");
    const search = screen.getByRole("textbox", { name: "Search videos" });
    expect(search).toHaveFocus();
    await user.keyboard("night");
    expect(useLibraryView.getState().query).toBe("night");
    expect([...document.querySelectorAll("[data-row-main]")].map((el) => el.textContent)).toEqual([
      "Night Cream",
    ]);
    await user.keyboard("{Escape}");
    expect(useLibraryView.getState().query).toBe("");
  });

  it("opens the activity panel for a clicked row, and Settings from the footer", async () => {
    const user = userEvent.setup();
    await openPanel(user, SERUM);
    await user.click(screen.getByRole("button", { name: /^Settings/ }));
    expect(app.store.getState().view).toBe("settings");
  });
});

describe("Archive and Edit Log in the main page", () => {
  it.each([
    ["archive", "Archive"],
    ["editLog", "Edit Log"],
  ] as const)("show %s in place of the list and the panel", async (view, title) => {
    const user = userEvent.setup();
    await openPanel(user, SERUM);
    act(() => {
      app.store.getState().setView(view);
    });
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Videos" })).toBeNull();
    expect(activity()).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Search videos" })).toBeNull();
    // The sidebar stays.
    expect(screen.getByRole("navigation", { name: "Channels" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });
});

describe("Esc in the main window", () => {
  it("closes the panel from the list and from inside it, and returns focus to the row", async () => {
    const user = userEvent.setup();
    await openPanel(user);
    await user.keyboard("{Escape}");
    expect(activity()).toBeNull();
    expect(app.store.getState().selectedVideoId).toBeNull();
    expect(rowButton(HAIR)).toHaveFocus();

    const panel = await openPanel(user);
    within(panel).getByRole("button", { name: "Close activity" }).focus();
    await user.keyboard("{Escape}");
    expect(app.store.getState().selectedVideoId).toBeNull();
    expect(rowButton(HAIR)).toHaveFocus();
  });

  it("closes an open menu first and keeps the panel", async () => {
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(screen.getByRole("button", { name: `More for ${HAIR}` }));
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(activity()).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(activity()).toBeNull();
  });

  it("leaves Esc to the search field and to an open sheet", async () => {
    const user = userEvent.setup();
    await openPanel(user);
    await user.click(screen.getByRole("textbox", { name: "Search videos" }));
    await user.keyboard("oil{Escape}");
    expect(useLibraryView.getState().query).toBe("");
    expect(activity()).not.toBeNull();

    const row = rowButton("Night Cream").closest<HTMLElement>('[role="listitem"]');
    if (!row) throw new Error("no row");
    await user.click(within(row).getByRole("button", { name: "Start Editing" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(activity()).not.toBeNull();
  });
});

describe("Activity panel width", () => {
  const panelWidth = () =>
    Number.parseFloat(screen.getByRole("complementary", { name: "Activity" }).style.width);

  it("resizes with the keyboard within its bounds and resets with Enter", async () => {
    const user = userEvent.setup();
    await openPanel(user);
    const divider = screen.getByRole("separator", { name: "Resize activity panel" });
    expect(divider).toHaveAttribute("aria-valuemin", "300");
    expect(divider).toHaveAttribute("aria-valuemax", "640");
    const initial = panelWidth();
    divider.focus();
    await user.keyboard("{ArrowLeft}");
    expect(panelWidth()).toBe(initial + 16);
    await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(panelWidth()).toBe(initial + 80);
    await user.keyboard("{ArrowRight}");
    expect(panelWidth()).toBe(initial + 64);
    await user.keyboard("{End}");
    expect(panelWidth()).toBe(640);
    await user.keyboard("{Home}");
    expect(panelWidth()).toBe(300);
    await user.keyboard("{Enter}");
    expect(panelWidth()).toBe(initial);
    expect(window.localStorage.getItem("vidai.activityPanelWidth")).toBeNull();
  });

  it("leaves the list its minimum width: the panel may take only what is left beyond 420 px", async () => {
    // jsdom has no layout; the content area (list and panel) is 1000 px wide here.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    const user = userEvent.setup();
    await openPanel(user);
    const divider = screen.getByRole("separator", { name: "Resize activity panel" });
    expect(divider).toHaveAttribute("aria-valuemax", "580");
    divider.focus();
    await user.keyboard("{End}");
    expect(panelWidth()).toBe(580);
    await user.keyboard("{Home}");
    expect(panelWidth()).toBe(300);
  });

  it("follows a drag of the divider and remembers the width for the next panel", async () => {
    const user = userEvent.setup();
    await openPanel(user);
    const initial = panelWidth();
    const divider = screen.getByRole("separator", { name: "Resize activity panel" });
    fireEvent.pointerDown(divider, { button: 0, pointerId: 1, clientX: 800 });
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 760 });
    expect(panelWidth()).toBe(initial + 40);
    expect(document.documentElement.dataset.resizing).toBe("col");
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 100 });
    expect(panelWidth()).toBe(640);
    fireEvent.pointerUp(divider, { pointerId: 1, clientX: 100 });
    expect(document.documentElement.dataset.resizing).toBeUndefined();
    expect(window.localStorage.getItem("vidai.activityPanelWidth")).toBe("640");

    await user.keyboard("{Escape}");
    await openPanel(user, "Night Cream");
    expect(panelWidth()).toBe(640);
  });
});

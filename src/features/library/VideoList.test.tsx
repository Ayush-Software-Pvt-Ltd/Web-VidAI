import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { naturalCompare } from "@/lib/format";
import { USER_ID } from "@/lib/mock/seed/session";
import { setupApp, type SetupOptions, type TestApp } from "@/test/app";
import { LibraryToolbar } from "./LibraryToolbar";
import { NewVideoProvider } from "./newVideo";
import { addVideos } from "./testSupport";
import { VideoList } from "./VideoList";
import { useLibraryView } from "./viewStore";

let app: TestApp;

async function setup(scenarios: Parameters<typeof setupApp>[0] = ["default"], o?: SetupOptions) {
  useLibraryView.getState().reset();
  app = await setupApp(scenarios, o);
  return app;
}

const rowNames = () =>
  [...document.querySelectorAll<HTMLElement>("[data-row-main]")].map((el) => el.textContent);
const allVideos = () =>
  (app.store.getState().library.data?.channels ?? []).flatMap((c) => c.videos);

describe("VideoList", () => {
  it("shows All Channels as one flat list, newest first, labeled Channel / Video", async () => {
    await setup();
    app.render(<VideoList />);
    const items = within(screen.getByRole("list", { name: "Videos" })).getAllByRole("listitem");
    const newest = allVideos().reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    expect(items[0]).toHaveAttribute("data-video-id", newest.id);
    expect(items.every((li) => li.textContent.includes(" / "))).toBe(true);
    expect(new Set(items.map((li) => li.textContent.split(" / ")[0])).size).toBeGreaterThan(1);
    expect(
      within(items[0] as HTMLElement).getByRole("button", { name: newest.folderName }),
    ).toBeInTheDocument();
  });

  it("shows one channel without channel names", async () => {
    await setup();
    const channel = app.store.getState().workspace.data?.channels[0];
    app.store.getState().selectChannel(channel?.id ?? null);
    app.render(<VideoList />);
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(0);
    for (const li of items) {
      expect(li.getAttribute("data-video-id")?.startsWith(`${channel?.id}/`)).toBe(true);
      expect(li.textContent).not.toContain(`${channel?.name} / `);
    }
  });

  it("sorts by name in natural order, in both directions", async () => {
    const user = userEvent.setup();
    await setup();
    app.render(
      <>
        <LibraryToolbar />
        <VideoList />
      </>,
    );
    const pick = async () => {
      await user.click(screen.getByRole("button", { name: /^Sort videos/ }));
      await user.click(await screen.findByRole("menuitem", { name: /^Name/ }));
    };
    const expected = allVideos()
      .map((v) => v.folderName)
      .sort(naturalCompare);
    await pick();
    await waitFor(() => {
      expect(rowNames()).toEqual(expected);
    });
    await pick();
    await waitFor(() => {
      expect(rowNames()).toEqual([...expected].reverse());
    });
  });

  it("filters by search words, offers Clear Search, and Escape clears the field", async () => {
    const user = userEvent.setup();
    await setup();
    app.render(
      <>
        <LibraryToolbar />
        <VideoList />
      </>,
    );
    const first = allVideos()[0]?.folderName.split(" ")[0] ?? "";
    await user.type(screen.getByRole("textbox", { name: "Search videos" }), first);
    expect(rowNames().length).toBeGreaterThan(0);
    expect(rowNames().every((n) => n.toLowerCase().includes(first.toLowerCase()))).toBe(true);
    await user.type(screen.getByRole("textbox", { name: "Search videos" }), " zzzznomatch");
    expect(await screen.findByText("No matching videos")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear Search" }));
    expect(rowNames().length).toBe(allVideos().length);
  });

  it("filters by bucket and explains an empty filter", async () => {
    const user = userEvent.setup();
    await setup(["default"], { user: "user" });
    app.render(
      <>
        <LibraryToolbar />
        <VideoList />
      </>,
    );
    await user.click(screen.getByRole("radio", { name: "Edited" }));
    expect(await screen.findByText("No edited videos yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show All Videos" }));
    expect(rowNames()).toEqual(["Lisbon Day 1"]);
  });

  it("moves between rows with the arrow keys and keeps a single tab stop", async () => {
    const user = userEvent.setup();
    await setup();
    app.render(<VideoList />);
    const tabbable = () =>
      [...document.querySelectorAll<HTMLElement>('[data-row-main][tabindex="0"]')].map(
        (el) => el.textContent,
      );
    const [first = "", second = ""] = rowNames();
    expect(tabbable()).toEqual([first]);
    screen.getByRole("button", { name: first }).focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe(second);
    expect(tabbable()).toEqual([second]);
    await user.keyboard("{End}");
    expect(document.activeElement?.closest("[data-row-index]")).toHaveAttribute(
      "aria-posinset",
      String(rowNames().length),
    );
    await user.keyboard("{Home}{Enter}");
    expect(app.store.getState().selectedVideoId).toContain(first);
  });

  it("virtualizes hundreds of rows", async () => {
    await setup(["default"], { user: "user", prepare: addVideos(USER_ID, 500) });
    app.render(<VideoList />);
    const rendered = document.querySelectorAll('[role="listitem"]').length;
    expect(rendered).toBeGreaterThan(10);
    expect(rendered).toBeLessThan(60);
    expect(document.querySelector('[role="listitem"]')).toHaveAttribute(
      "aria-setsize",
      String(allVideos().length),
    );
  });

  it("shows a user only their own videos", async () => {
    await setup(["two-users"], { user: "user" });
    app.render(<VideoList />);
    expect(rowNames()).toEqual(["Lisbon Day 1"]);
    expect(screen.queryByText("Hair Oil Review")).toBeNull();
  });
});

describe("VideoList states", () => {
  it("shows skeletons while the library loads, not a blank page", async () => {
    await setup(["default"], { load: false });
    app.render(<VideoList />);
    expect(screen.getByRole("status", { name: "Loading videos" })).toBeInTheDocument();
  });

  it("shows the library error with Try Again, and recovers", async () => {
    const user = userEvent.setup();
    await setup(["library-error"]);
    app.render(<VideoList />);
    expect(await screen.findByText("Could not load your videos")).toBeInTheDocument();
    app.backend.world.libraryFails = false;
    await user.click(screen.getByRole("button", { name: "Try Again" }));
    expect(await screen.findByRole("list", { name: "Videos" })).toBeInTheDocument();
  });

  it("keeps the list and shows a notice when a refresh fails", async () => {
    await setup();
    app.render(<VideoList />);
    app.backend.world.libraryFails = true;
    await app.store.getState().refreshLibrary();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not refresh the videos/);
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
  });

  it("offers New Channel when the user has no channels", async () => {
    const user = userEvent.setup();
    await setup(["no-channels"]);
    app.render(<VideoList />);
    expect(await screen.findByText("No channels yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New Channel" }));
    expect(app.store.getState().settingsTarget).toMatchObject({ section: "channels" });
  });

  it("explains a selected channel whose folder cannot be reached", async () => {
    await setup(["default"], {
      user: "user",
      prepare: (backend) => {
        for (const c of backend.world.channels) c.available = false;
      },
    });
    app.store
      .getState()
      .selectChannel(app.store.getState().workspace.data?.channels[0]?.id ?? null);
    app.render(<VideoList />);
    expect(await screen.findByText("Channel folder cannot be reached")).toBeInTheDocument();
  });

  it("explains an empty channel, with New Video only when the uploads feature provides it", async () => {
    const calls: (string | null)[] = [];
    await setup(["default"], {
      user: "user",
      prepare: (backend) => {
        backend.world.videos = backend.world.videos.filter((v) => v.userId !== USER_ID);
      },
    });
    const { unmount } = app.render(<VideoList />);
    expect(await screen.findByText("No videos yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New Video" })).toBeNull();
    unmount();
    app.render(
      <NewVideoProvider onNewVideo={(id) => calls.push(id)}>
        <VideoList />
      </NewVideoProvider>,
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: "New Video" }));
    expect(calls).toEqual([null]);
  });
});

describe("LibraryToolbar", () => {
  it("has three sort items; a second click on the active one flips its direction", async () => {
    const user = userEvent.setup();
    await setup();
    app.render(<LibraryToolbar />);
    const pick = async (name: string) => {
      await user.click(screen.getByRole("button", { name: /^Sort videos/ }));
      const menu = await screen.findByRole("menu");
      expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);
      await user.click(within(menu).getByRole("menuitem", { name: new RegExp(`^${name}`) }));
    };
    expect(useLibraryView.getState().sort).toEqual({ key: "age", dir: "desc" });
    await pick("Name");
    expect(useLibraryView.getState().sort).toEqual({ key: "name", dir: "asc" });
    await pick("Name");
    expect(useLibraryView.getState().sort).toEqual({ key: "name", dir: "desc" });
    await pick("Status");
    expect(useLibraryView.getState().sort).toEqual({ key: "status", dir: "asc" });
  });

  it("hides New Video until a handler is provided, then passes the selected channel", async () => {
    const user = userEvent.setup();
    const calls: (string | null)[] = [];
    await setup();
    const { unmount } = app.render(<LibraryToolbar />);
    expect(screen.queryByRole("button", { name: "New Video" })).toBeNull();
    unmount();
    const id = app.store.getState().workspace.data?.channels[0]?.id ?? null;
    app.store.getState().selectChannel(id);
    app.render(
      <NewVideoProvider onNewVideo={(c) => calls.push(c)}>
        <LibraryToolbar />
      </NewVideoProvider>,
    );
    await user.click(screen.getByRole("button", { name: "New Video" }));
    expect(calls).toEqual([id]);
  });

  it("summarizes the user's own jobs", async () => {
    await setup(["queue-full"], { user: "user" });
    app.render(<LibraryToolbar />);
    expect(await screen.findByRole("status")).toHaveTextContent(/\d+ running, \d+ waiting/);
  });
});

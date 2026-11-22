import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ScenarioName } from "@/lib/mock";
import { setupApp, type SetupOptions, type TestApp } from "@/test/app";
import { LibrarySidebar } from "./LibrarySidebar";
import { channelCounts } from "./model";
import { useLibraryView } from "./viewStore";

let app: TestApp;

async function renderSidebar(scenarios: ScenarioName[] = ["default"], options?: SetupOptions) {
  useLibraryView.getState().reset();
  app = await setupApp(scenarios, options);
  app.render(<LibrarySidebar />);
  return within(screen.getByRole("navigation", { name: "Channels" }));
}

const channelNames = () => (app.store.getState().workspace.data?.channels ?? []).map((c) => c.name);

describe("LibrarySidebar", () => {
  it("lists All Channels and the user's channels with [not edited/editing/edited] counts", async () => {
    const nav = await renderSidebar();
    const library = app.store.getState().library.data?.channels ?? [];
    const total = channelCounts(library.flatMap((c) => c.videos));
    const all = nav.getByRole("button", { name: /^All Channels/ });
    expect(all).toHaveAttribute("aria-current", "page");
    expect(all).toHaveTextContent(`[${total.notEdited}/${total.editing}/${total.edited}]`);
    for (const entry of library) {
      const name = channelNames()[library.indexOf(entry)] ?? "";
      const counts = channelCounts(entry.videos);
      expect(nav.getByRole("button", { name: new RegExp(`^${name}`) })).toHaveTextContent(
        `[${counts.notEdited}/${counts.editing}/${counts.edited}]`,
      );
    }
    expect(channelNames().length).toBeGreaterThan(1);
  });

  it("selects a channel and All Channels through the navigation actions", async () => {
    const user = userEvent.setup();
    const nav = await renderSidebar();
    const [first = "", second = ""] = channelNames();
    await user.click(nav.getByRole("button", { name: new RegExp(`^${first}`) }));
    const id = app.store.getState().selectedChannelId;
    expect(id).toBe(app.store.getState().workspace.data?.channels[0]?.id);
    expect(nav.getByRole("button", { name: new RegExp(`^${first}`) })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(nav.getByRole("button", { name: new RegExp(`^${second}`) })).not.toHaveAttribute(
      "aria-current",
    );
    await user.click(nav.getByRole("button", { name: /^All Channels/ }));
    expect(app.store.getState().selectedChannelId).toBeNull();
  });

  it("tints a channel with a failed job and marks one with a running job", async () => {
    const nav = await renderSidebar();
    const failed = (app.store.getState().library.data?.channels ?? []).filter((c) =>
      c.videos.some((v) => v.job?.state === "failed"),
    );
    expect(failed.length).toBeGreaterThan(0);
    const names = channelNames();
    const library = app.store.getState().library.data?.channels ?? [];
    library.forEach((entry, index) => {
      const button = nav.getByRole("button", { name: new RegExp(`^${names[index]}`) });
      if (failed.includes(entry)) expect(button).toHaveClass("bg-danger-soft");
      else expect(button).not.toHaveClass("bg-danger-soft");
    });
  });

  it("marks a channel whose folder cannot be reached, with a tooltip, and no counts", async () => {
    const user = userEvent.setup();
    const nav = await renderSidebar(["default"], {
      prepare: (backend) => {
        const channel = backend.world.channels.find((c) => c.userId === backend.world.users[0]?.id);
        if (channel) channel.available = false;
      },
    });
    const missing = nav.getByRole("button", { name: /folder not reachable$/ });
    expect(missing).not.toHaveTextContent("[");
    await user.hover(missing);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/cannot be reached right now/);
  });

  it("opens Settings at Channels from New channel", async () => {
    const user = userEvent.setup();
    const nav = await renderSidebar();
    await user.click(nav.getByRole("button", { name: "New channel" }));
    const state = app.store.getState();
    expect(state.view).toBe("settings");
    expect(state.settingsTarget).toMatchObject({ section: "channels" });
  });

  it("shows an empty state with the one New Channel button when there are no channels", async () => {
    const user = userEvent.setup();
    const nav = await renderSidebar(["no-channels"]);
    expect(nav.getByText("No channels yet")).toBeInTheDocument();
    const buttons = nav.getAllByRole("button", { name: /new channel/i });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0] as HTMLElement);
    expect(app.store.getState().view).toBe("settings");
  });

  it("shows only the signed-in user's channels", async () => {
    const nav = await renderSidebar(["two-users"], { user: "user" });
    expect(channelNames()).toEqual(["Travel Diary"]);
    expect(nav.getByRole("button", { name: /^Travel Diary/ })).toBeInTheDocument();
    expect(nav.queryAllByRole("button")).toHaveLength(3);
  });
});

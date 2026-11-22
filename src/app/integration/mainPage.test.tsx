/** The joined app: signing in, the main page, the activity panel and Start Editing. */
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { findMainPage } from "@/test/pages";
import { openApp, resetAddress } from "@/test/whole";

resetAddress();

const row = (name: string) => {
  const main = [...document.querySelectorAll<HTMLElement>("[data-row-main]")].find(
    (el) => el.textContent === name,
  );
  const item = main?.closest<HTMLElement>('[role="listitem"]');
  if (!item) throw new Error(`no row ${name}`);
  return item;
};

describe("a person signs in", () => {
  it("lands on the main page with the sidebar, the list and the footer", async () => {
    const { user } = await openApp({ scenarios: ["signed-out"], user: null });
    await user.type(await screen.findByLabelText("Email"), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "user-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await findMainPage();
    expect(window.location.pathname).toBe("/");
    // Their own channel and video, and nobody else's.
    const channels = screen.getByRole("navigation", { name: "Channels" });
    expect(within(channels).getByText("Travel Diary")).toBeInTheDocument();
    expect(within(channels).queryByText("Beauty Channel")).toBeNull();
    expect(await screen.findByText("Lisbon Day 1")).toBeInTheDocument();
    expect(screen.queryByText("Serum Launch")).toBeNull();
    // The footer: account, entries, no Admin.
    expect(screen.getByRole("button", { name: "Account of user@example.com" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Settings/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Admin/ })).toBeNull();
  });
});

describe("the main page", () => {
  it("selects a channel and shows only its videos", async () => {
    const { user } = await openApp();
    await findMainPage();
    expect(await screen.findByText("Hair Oil Review")).toBeInTheDocument();
    expect(screen.getByText("Earbuds Short")).toBeInTheDocument();
    const channels = screen.getByRole("navigation", { name: "Channels" });
    await user.click(within(channels).getByRole("button", { name: /Tech Reviews/ }));
    expect(screen.queryByRole("list", { name: "Videos" })).toBeNull();
    expect(screen.getByText("Earbuds Short")).toBeInTheDocument();
    expect(screen.queryByText("Hair Oil Review")).toBeNull();
  });

  it("opens a video's activity panel and closes it again with Esc", async () => {
    const { user } = await openApp();
    await findMainPage();
    await user.click(await screen.findByRole("button", { name: "Serum Launch" }));
    const panel = await screen.findByRole("complementary", { name: "Activity" });
    expect(within(panel).getByText("Serum Launch")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("complementary", { name: "Activity" })).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Serum Launch" })).toHaveFocus();
  });
});

describe("a channel whose folder cannot be reached", () => {
  it("is marked in the sidebar and says so instead of listing videos", async () => {
    const { user } = await openApp({ scenarios: ["unreachable-channel"] });
    await findMainPage();
    expect(await screen.findByText("Hair Oil Review")).toBeInTheDocument();
    expect(screen.queryByText("Earbuds Short")).toBeNull();
    const channels = screen.getByRole("navigation", { name: "Channels" });
    await user.click(within(channels).getByRole("button", { name: /folder not reachable$/ }));
    expect(await screen.findByText(/cannot be reached right now/)).toBeInTheDocument();
  });
});

describe("Start Editing with Urgent", () => {
  it("puts the job ahead of a waiting one, and the row says so", async () => {
    const { user, app } = await openApp({ scenarios: ["urgent"] });
    await findMainPage();
    await screen.findByText("Hair Oil Review");
    expect(within(row("Desk Lamp Review")).getByText(/Waiting, position 2/)).toBeInTheDocument();

    await user.click(within(row("Hair Oil Review")).getByRole("button", { name: "Start Editing" }));
    const sheet = await screen.findByRole("dialog");
    await user.click(within(sheet).getByRole("checkbox", { name: /Urgent/ }));
    await user.click(within(sheet).getByRole("button", { name: "Start Editing" }));

    await waitFor(() => {
      expect(within(row("Hair Oil Review")).getByText("Urgent")).toBeInTheDocument();
    });
    expect(within(row("Hair Oil Review")).getByText(/Waiting, position 2/)).toBeInTheDocument();
    // The one that waited before moves back.
    expect(within(row("Desk Lamp Review")).getByText(/Waiting, position 3/)).toBeInTheDocument();
    expect(within(row("Webcam Comparison")).getByText(/Waiting, position 1/)).toBeInTheDocument();
    expect(app.job("Hair Oil").urgent).toBe(true);
  });
});

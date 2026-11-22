/** The joined app: the video list is named after the channel the person picked in the sidebar. */
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { findMainPage } from "@/test/pages";
import { openApp, resetAddress } from "@/test/whole";

resetAddress();

describe("the label of the video list", () => {
  it("names only the picked channel, and just Videos for All Channels", async () => {
    const { user, app } = await openApp();
    const sidebar = await findMainPage();
    await screen.findByRole("list", { name: "Videos" });
    const channels = app.store.getState().workspace.data?.channels ?? [];
    expect(channels.length).toBeGreaterThan(1);

    await user.click(within(sidebar).getByRole("button", { name: /^Tech Reviews/ }));
    expect(await screen.findByRole("list", { name: "Videos in Tech Reviews" })).toBeInTheDocument();
    for (const other of channels.filter((c) => c.name !== "Tech Reviews")) {
      expect(screen.queryByRole("list", { name: new RegExp(other.name) })).toBeNull();
    }

    await user.click(within(sidebar).getByRole("button", { name: /^All Channels/ }));
    expect(await screen.findByRole("list", { name: "Videos" })).toBeInTheDocument();
  });
});

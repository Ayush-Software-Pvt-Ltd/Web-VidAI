/** The joined app: Archive and Edit Log open from the sidebar and close with Done and with Esc. */
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { findMainPage } from "@/test/pages";
import { openApp, resetAddress } from "@/test/whole";

resetAddress();

/** The sidebar's own entry (the rows have an Archive button of their own). */
const entry = (title: string) =>
  within(
    screen.getByRole("navigation", { name: "Archive, Edit Log, Disk Cleanup, Settings and Admin" }),
  ).getByRole("button", { name: title });

describe.each([
  ["Archive", "/archive"],
  ["Edit Log", "/edit-log"],
] as const)("%s", (title, path) => {
  it("opens from the sidebar and closes with Done, back to the list", async () => {
    const { user } = await openApp();
    await findMainPage();
    await screen.findByRole("list", { name: "Videos" });
    await user.click(entry(title));
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    expect(window.location.pathname).toBe(path);
    expect(screen.queryByRole("list", { name: "Videos" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("list", { name: "Videos" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("heading", { name: title })).toBeNull();
  });

  it("closes with Esc", async () => {
    const { user } = await openApp();
    await findMainPage();
    await screen.findByRole("list", { name: "Videos" });
    await user.click(entry(title));
    await screen.findByRole("heading", { name: title });
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("list", { name: "Videos" })).toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
  });

  it("gives focus back to the sidebar entry after Done and after Esc", async () => {
    const { user } = await openApp();
    await findMainPage();
    await screen.findByRole("list", { name: "Videos" });
    await user.click(entry(title));
    await user.click(await screen.findByRole("button", { name: "Done" }));
    await screen.findByRole("list", { name: "Videos" });
    expect(entry(title)).toHaveFocus();

    await user.click(entry(title));
    await screen.findByRole("heading", { name: title });
    await user.keyboard("{Escape}");
    await screen.findByRole("list", { name: "Videos" });
    expect(entry(title)).toHaveFocus();
  });

  it("closes with the entry that opened it", async () => {
    const { user } = await openApp();
    await findMainPage();
    await screen.findByRole("list", { name: "Videos" });
    await user.click(entry(title));
    await screen.findByRole("heading", { name: title });
    await user.click(entry(title));
    expect(await screen.findByRole("list", { name: "Videos" })).toBeInTheDocument();
    expect(entry(title)).toHaveFocus();
  });

  it("opens at its address and closes with Esc", async () => {
    const { user } = await openApp({ path });
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("list", { name: "Videos" })).toBeInTheDocument();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
  });
});

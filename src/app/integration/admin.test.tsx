/** The joined app: the Admin area with its real pages, for an admin and for a user. */
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { findAdminPage, findMainPage, queryAdminPage } from "@/test/pages";
import { openApp, resetAddress } from "@/test/whole";

resetAddress();

const SECTIONS = [
  ["users", "Users"],
  ["harness", "Harness and Model"],
  ["limits", "Queues and Limits"],
  ["storage", "Storage"],
  ["queue", "Queue"],
  ["system", "System"],
] as const;

const nav = () => screen.getByRole("navigation", { name: "Admin" });
const heading = () => screen.getByRole("heading", { level: 1 });

describe("the Admin area, as an admin", () => {
  it("opens from the sidebar and reaches every section by the nav", async () => {
    const { user } = await openApp();
    await findMainPage();
    await user.click(await screen.findByRole("button", { name: /^Admin/ }));
    await findAdminPage();
    for (const [slug, label] of SECTIONS) {
      await user.click(within(nav()).getByRole("button", { name: label }));
      await waitFor(() => {
        expect(heading()).toHaveTextContent(label);
      });
      expect(window.location.pathname).toBe(`/admin/${slug}`);
      expect(within(nav()).getByRole("button", { name: label })).toHaveAttribute(
        "aria-current",
        "page",
      );
    }
  });

  it.each(SECTIONS)("opens /admin/%s at its address", async (slug, label) => {
    await openApp({ path: `/admin/${slug}` });
    await findAdminPage();
    expect(heading()).toHaveTextContent(label);
    expect(window.location.pathname).toBe(`/admin/${slug}`);
  });

  it("leaves with Done and with Esc", async () => {
    const { user } = await openApp({ path: "/admin/storage" });
    await findAdminPage();
    await user.click(screen.getByRole("button", { name: "Done" }));
    await findMainPage();
    expect(window.location.pathname).toBe("/");

    await user.click(screen.getByRole("button", { name: /^Admin/ }));
    await findAdminPage();
    await user.keyboard("{Escape}");
    await findMainPage();
    expect(window.location.pathname).toBe("/");
  });
});

describe("the Admin area, as a user", () => {
  it("has no Admin entry in the sidebar", async () => {
    await openApp({ user: "user" });
    await findMainPage();
    await screen.findByText("Lisbon Day 1");
    expect(screen.queryByRole("button", { name: /^Admin/ })).toBeNull();
  });

  it.each(SECTIONS)(
    "never reaches /admin/%s: the library shows and the address is replaced by /",
    async (slug) => {
      const { app } = await openApp({ path: `/admin/${slug}`, user: "user" });
      await findMainPage();
      expect(queryAdminPage()).toBeNull();
      await waitFor(() => {
        expect(window.location.pathname).toBe("/");
      });
      // Nothing of the Admin area was even asked for.
      expect(app.store.getState().adminUsers.status).toBe("idle");
    },
  );
});

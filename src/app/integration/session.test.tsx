/** The joined app: Disk Cleanup, signing out and a second user, and the connection notice. */
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { addVideos } from "@/features/library/testSupport";
import { ADMIN_ID } from "@/lib/mock/seed/session";
import { findMainPage } from "@/test/pages";
import { openApp, resetAddress } from "@/test/whole";

resetAddress();

const footer = () =>
  within(
    screen.getByRole("navigation", { name: "Archive, Edit Log, Disk Cleanup, Settings and Admin" }),
  );

describe("Disk Cleanup", () => {
  it("opens from the sidebar and returns with Done and with Esc", async () => {
    const { user } = await openApp();
    await findMainPage();
    await screen.findByRole("list", { name: "Videos" });
    await user.click(footer().getByRole("button", { name: "Disk Cleanup" }));
    expect(await screen.findByRole("heading", { name: "Disk Cleanup" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/disk");
    expect(await screen.findByRole("region", { name: "Disk use" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Done" }));
    await findMainPage();
    expect(window.location.pathname).toBe("/");

    await user.click(footer().getByRole("button", { name: "Disk Cleanup" }));
    await screen.findByRole("heading", { name: "Disk Cleanup" });
    await user.keyboard("{Escape}");
    await findMainPage();
    expect(screen.queryByRole("heading", { name: "Disk Cleanup" })).toBeNull();
  });

  it("opens from a video's menu with the question for that video", async () => {
    const { user } = await openApp();
    await findMainPage();
    await user.click(await screen.findByRole("button", { name: "More for Serum Launch" }));
    await user.click(await screen.findByRole("menuitem", { name: /Disk Cleanup/ }));
    const ask = await screen.findByRole("alertdialog");
    expect(ask).toHaveTextContent("Serum Launch will lose its working files.");
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("heading", { name: "Disk Cleanup" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/disk");
  });
});

describe("signing out", () => {
  it("returns to the sign-in page, and a second user sees none of the first user's rows", async () => {
    const { user, app } = await openApp({ scenarios: ["two-users"] });
    await findMainPage();
    expect(await screen.findByText("Serum Launch")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Account of admin@example.com" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByText("Serum Launch")).toBeNull();
    expect(app.store.getState().library.data).toBeNull();
    expect(window.location.pathname).toBe("/");

    await user.type(screen.getByLabelText("Email"), "user@example.com");
    await user.type(screen.getByLabelText("Password"), "user-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await findMainPage();
    expect(await screen.findByText("Lisbon Day 1")).toBeInTheDocument();
    expect(screen.queryByText("Serum Launch")).toBeNull();
    expect(screen.queryByText("Beauty Channel")).toBeNull();
    expect(screen.getByRole("button", { name: "Account of user@example.com" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Admin/ })).toBeNull();
  });

  it("comes back to the sign-in page, with the reason, when the server ends the session", async () => {
    const { app } = await openApp({ path: "/settings/appearance" });
    await screen.findByRole("navigation", { name: "Settings" });
    act(() => {
      app.store.getState().sessionEnded("passwordChanged");
    });
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByText(/because your password was changed/)).toBeInTheDocument();
  });
});

describe("the connection notice", () => {
  it("shows when the stream is lost, and reconnecting hides it and reloads the lists", async () => {
    const { backend, app } = await openApp();
    await findMainPage();
    await screen.findByRole("list", { name: "Videos" });
    expect(screen.queryByRole("alert")).toBeNull();

    act(() => {
      backend.connection.update({ status: "lost" });
    });
    const notice = await screen.findByRole("alert");
    expect(within(notice).getByText("VidAI cannot be reached")).toBeInTheDocument();

    // Something changed on the server while the page could not hear it.
    addVideos(ADMIN_ID, 1)(backend);
    expect(screen.queryByText("Bulk 0000")).toBeNull();

    act(() => {
      backend.connection.update({ status: "connected" });
    });
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
    expect(await screen.findByText("Bulk 0000")).toBeInTheDocument();
    expect(app.store.getState().library.status).toBe("ready");
  });
});

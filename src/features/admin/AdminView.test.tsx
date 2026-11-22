import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdminSection } from "@/lib/store";
import { setupApp } from "@/test/app";
import { AdminView, NOT_ADMIN } from "./AdminView";

beforeEach(() => {
  window.history.replaceState(null, "", "/admin/users");
});
afterEach(() => {
  document.body.style.pointerEvents = "";
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
  window.history.replaceState(null, "", "/");
});

async function open(section?: AdminSection) {
  const app = await setupApp(["default"]);
  act(() => {
    app.store.getState().openAdmin(section);
  });
  app.render(<AdminView />);
  return app;
}

const nav = () => screen.getByRole("navigation", { name: "Admin" });

describe("AdminView", () => {
  it("tells anybody but an admin that only an admin can open it", async () => {
    const app = await setupApp(["as-user"], { user: "user" });
    app.render(<AdminView />);
    expect(screen.getByText(NOT_ADMIN)).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Admin" })).not.toBeInTheDocument();
  });

  it("lists the six sections and opens the one of the store", async () => {
    await open("limits");
    const links = within(nav()).getAllByRole("button");
    expect(links.map((l) => l.textContent)).toEqual([
      "Users",
      "Harness and Model",
      "Queues and Limits",
      "Storage",
      "Queue",
      "System",
    ]);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Queues and Limits");
    expect(within(nav()).getByRole("button", { name: "Queues and Limits" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(await screen.findByText("Pacing")).toBeInTheDocument();
  });

  it("moves between sections through the store, so the address follows", async () => {
    const user = userEvent.setup();
    const app = await open("users");
    await screen.findByText("Accounts");
    await user.click(within(nav()).getByRole("button", { name: "Storage" }));
    expect(await screen.findByText("Storage folders")).toBeInTheDocument();
    expect(app.store.getState().adminSection).toBe("storage");
    await user.click(within(nav()).getByRole("button", { name: "Queue" }));
    expect(await screen.findByText("Timeline changes")).toBeInTheDocument();
    expect(app.store.getState().adminSection).toBe("queue");
  });

  it("opens the real Harness and Model and System pages", async () => {
    const user = userEvent.setup();
    await open("harness");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Harness and Model");
    expect(await screen.findByRole("radiogroup")).toHaveAccessibleName(
      "How should VidAI run edits?",
    );
    await user.click(within(nav()).getByRole("button", { name: "System" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("System");
    expect(await screen.findByRole("region", { name: "This server" })).toBeInTheDocument();
  });

  it("goes back to the video list with Done and with Esc", async () => {
    const user = userEvent.setup();
    const app = await open("users");
    await screen.findByText("Accounts");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(app.store.getState().view).toBe("main");
    act(() => {
      app.store.getState().openAdmin("users");
    });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(app.store.getState().view).toBe("main");
  });
});

describe("AdminView: unsaved changes", () => {
  async function dirty() {
    const user = userEvent.setup();
    const app = await open("limits");
    const retries = await screen.findByLabelText("Retries after a model error");
    await user.clear(retries);
    await user.type(retries, "3");
    return { user, app };
  }

  it("asks before another section is opened, and Stay keeps the draft and the section", async () => {
    const { user, app } = await dirty();
    await user.click(within(nav()).getByRole("button", { name: "Users" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Save changes to “Queues and Limits”?");
    expect(dialog).toHaveTextContent("retries after a model error");
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(app.store.getState().adminSection).toBe("limits");
    expect(screen.getByLabelText("Retries after a model error")).toHaveValue("3");
  });

  it("Discard opens the section and forgets the draft", async () => {
    const { user, app } = await dirty();
    const before = app.backend.world.adminSettings.maxModelRetries;
    await user.click(within(nav()).getByRole("button", { name: "Users" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Discard Changes" }));
    expect(await screen.findByText("Accounts")).toBeInTheDocument();
    expect(app.backend.world.adminSettings.maxModelRetries).toBe(before);
    await user.click(within(nav()).getByRole("button", { name: "Queues and Limits" }));
    expect(await screen.findByLabelText("Retries after a model error")).toHaveValue(String(before));
  });

  it("Save saves the draft and then opens the section", async () => {
    const { user, app } = await dirty();
    await user.click(within(nav()).getByRole("button", { name: "Users" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Accounts")).toBeInTheDocument();
    expect(app.backend.world.adminSettings.maxModelRetries).toBe(3);
  });

  it("asks before Done leaves, and a draft with a wrong number cannot be saved from the question", async () => {
    const user = userEvent.setup();
    const app = await open("limits");
    const retries = await screen.findByLabelText("Retries after a model error");
    await user.clear(retries);
    await user.type(retries, "99");
    await user.click(screen.getByRole("button", { name: "Done" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    // Saving was not possible, so the screen stays where it was.
    expect(app.store.getState().view).not.toBe("main");
    expect(screen.getByLabelText("Retries after a model error")).toHaveValue("99");
  });

  it("asks the browser's own question when the tab closes with unsaved changes", async () => {
    await dirty();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not ask when nothing changed", async () => {
    const user = userEvent.setup();
    await open("limits");
    await screen.findByText("Pacing");
    await user.click(within(nav()).getByRole("button", { name: "Users" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

/** The joined app: Settings with its real sections, the unsaved-changes guard, Back and Forward. */
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { findMainPage, findSettingsPage } from "@/test/pages";
import { openApp, resetAddress } from "@/test/whole";

resetAddress();

const NAME = "Travel Diary";
const nav = () => screen.getByRole("navigation", { name: "Settings" });
/** A field the person can edit: the first Long 16:9 style of the channel. */
const nameField = () =>
  screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Long 16:9 style" });
let original = "";
const question = () => screen.findByRole("dialog", { name: `Save changes to “${NAME}”?` });
const heading = () => screen.getByRole("heading", { level: 1 });

/** Back in the browser, then a moment for the guard's listener and the shell's. */
async function back() {
  act(() => {
    window.history.back();
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("every section of Settings", () => {
  it("is reachable from the sidebar and by its address", async () => {
    const { user } = await openApp({ user: "user" });
    await findMainPage();
    await user.click(await screen.findByRole("button", { name: /^Settings/ }));
    await findSettingsPage();
    expect(window.location.pathname.startsWith("/settings")).toBe(true);

    const sections = [
      [
        "Appearance",
        "/settings/appearance",
        () => screen.getByRole("group", { name: "Text size" }),
      ],
      ["Channels", "/settings/channels", () => nameField()],
      [
        "Import and Export",
        "/settings/import-export",
        () => screen.getByRole("button", { name: "Export" }),
      ],
    ] as const;
    for (const [label, path, content] of sections) {
      await user.click(within(nav()).getByRole("button", { name: label }));
      expect(heading()).toHaveTextContent(label);
      expect(window.location.pathname).toBe(path);
      expect(content()).toBeInTheDocument();
    }
  });

  it.each([
    ["/settings/appearance", "Appearance"],
    ["/settings/channels", "Channels"],
    ["/settings/import-export", "Import and Export"],
  ])("opens %s at its address", async (path, label) => {
    await openApp({ path, user: "user" });
    await findSettingsPage();
    expect(heading()).toHaveTextContent(label);
    expect(window.location.pathname).toBe(path);
  });

  it("leaves with Done and Esc, back to the list", async () => {
    const { user } = await openApp({ path: "/settings/appearance", user: "user" });
    await findSettingsPage();
    await user.click(screen.getByRole("button", { name: "Done" }));
    await findMainPage();
    expect(window.location.pathname).toBe("/");

    await user.click(screen.getByRole("button", { name: /^Settings/ }));
    await findSettingsPage();
    await user.keyboard("{Escape}");
    await findMainPage();
    expect(window.location.pathname).toBe("/");
  });
});

describe("the unsaved-changes guard in the whole app", () => {
  async function changedChannel() {
    const ctx = await openApp({ path: "/settings/channels", user: "user" });
    await findSettingsPage();
    original = nameField().value;
    await ctx.user.type(nameField(), " Two");
    return ctx;
  }

  it("asks when leaving a changed channel for another section, Stay keeps the draft", async () => {
    const { user } = await changedChannel();
    await user.click(within(nav()).getByRole("button", { name: "Appearance" }));
    await question();
    expect(screen.getByText(/You changed the Long 16:9 style\./)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(nameField()).toHaveValue(`${original} Two`);
    expect(window.location.pathname).toBe("/settings/channels");
  });

  it("Discard Changes goes on and drops the draft", async () => {
    const { user } = await changedChannel();
    await user.click(within(nav()).getByRole("button", { name: "Appearance" }));
    await question();
    await user.click(screen.getByRole("button", { name: "Discard Changes" }));
    expect(heading()).toHaveTextContent("Appearance");
    await user.click(within(nav()).getByRole("button", { name: "Channels" }));
    expect(nameField()).toHaveValue(original);
  });

  it("asks for Done and Esc too, and Save keeps the change", async () => {
    const { user, app } = await changedChannel();
    await user.click(screen.getByRole("button", { name: "Done" }));
    await question();
    await user.click(screen.getByRole("button", { name: "Stay" }));
    // Esc in the text field only leaves the field; the next Esc asks.
    act(() => {
      nameField().focus();
    });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.keyboard("{Escape}");
    await question();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await findMainPage();
    const channel = app.store.getState().workspace.data?.channels.find((c) => c.name === NAME);
    expect(channel?.long.styles[0]?.text).toBe(`${original} Two`);
  });
});

describe("Back and Forward", () => {
  it("the browser's Back and the Done button behave the same with a changed channel", async () => {
    const { user } = await openApp({ user: "user" });
    await findMainPage();
    await user.click(await screen.findByRole("button", { name: /^Settings/ }));
    await findSettingsPage();
    await user.click(within(nav()).getByRole("button", { name: "Channels" }));
    original = nameField().value;
    await user.type(nameField(), " Two");

    // Back asks first, and the address stays.
    await back();
    await question();
    expect(window.location.pathname).toBe("/settings/channels");
    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(nameField()).toHaveValue(`${original} Two`);

    // Done asks the same question; Discard Changes then leaves.
    await user.click(screen.getByRole("button", { name: "Done" }));
    await question();
    await user.click(screen.getByRole("button", { name: "Discard Changes" }));
    await findMainPage();
    expect(window.location.pathname).toBe("/");
  });

  it("goes back to the list without a question when nothing is changed, and forward again", async () => {
    const { user } = await openApp({ user: "user" });
    await findMainPage();
    await user.click(await screen.findByRole("button", { name: /^Settings/ }));
    await findSettingsPage();
    await back();
    await findMainPage();
    expect(window.location.pathname).toBe("/");
    act(() => {
      window.history.forward();
    });
    await findSettingsPage();
    await waitFor(() => {
      expect(window.location.pathname.startsWith("/settings")).toBe(true);
    });
  });
});

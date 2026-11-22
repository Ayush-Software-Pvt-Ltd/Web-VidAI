/** The real Channels section inside the Settings frame: the target it opens with and the guard. */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { recordedApp } from "@/features/jobs/recordedApp";
import type { SettingsTarget } from "@/lib/store";
import { ADMIN_CHANNEL_TECH } from "@/lib/mock/seed/workspace";
import { SettingsView } from "../SettingsView";
import { BEAUTY, TECH } from "./testing";

async function openSettings(target: SettingsTarget) {
  const app = await recordedApp();
  act(() => {
    app.store.getState().openSettings(target);
  });
  app.render(<SettingsView />);
  return { user: userEvent.setup(), ...app };
}

const nav = () => screen.getByRole("navigation", { name: "Settings" });

describe("Channels in the Settings frame", () => {
  it("opens the channel and the type of the target, also while Settings is open", async () => {
    const { store } = await openSettings({
      section: "channels",
      channelId: ADMIN_CHANNEL_TECH,
      videoType: "short",
    });
    expect(screen.getByRole("heading", { name: TECH })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Short 9:16 prompt" })).toBeInTheDocument();
    act(() => {
      store.getState().openSettings({ section: "channels", videoType: "long" });
    });
    expect(await screen.findByRole("textbox", { name: "Long 16:9 prompt" })).toBeInTheDocument();
  });

  it("asks before another section replaces an unsaved channel", async () => {
    const { user, store } = await openSettings({ section: "channels" });
    await user.type(screen.getByRole("textbox", { name: "Long 16:9 style" }), " edited");
    await user.click(within(nav()).getByRole("button", { name: "Appearance" }));
    expect(
      await screen.findByRole("dialog", { name: `Save changes to “${BEAUTY}”?` }),
    ).toBeInTheDocument();
    expect(screen.getByText(/You changed the Long 16:9 style/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(store.getState().settingsSection).toBe("appearance");
    });
    await user.click(within(nav()).getByRole("button", { name: "Channels" }));
    expect(await screen.findByRole("textbox", { name: "Long 16:9 style" })).toHaveValue(
      "The long style of this channel. edited",
    );
  });
});

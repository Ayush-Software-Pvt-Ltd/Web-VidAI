import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPEARANCE_KEY, useAppearance } from "@/app/appearance";
import { TEXT_SIZE } from "@/lib/types";
import { setupApp } from "@/test/app";
import { AppearanceSection } from "./AppearanceSection";

/** The section inside what the shell provides: the hook that applies the choice to the page. */
function Harness() {
  useAppearance();
  return <AppearanceSection />;
}

function reset() {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
}
beforeEach(reset);
afterEach(reset);

async function setup() {
  const app = await setupApp(["default"]);
  app.render(<Harness />);
  return { user: userEvent.setup(), ...app };
}

const size = () => screen.getByRole("status", { name: /^Text size/ });
const bigger = () => screen.getByRole("button", { name: "Make Text Bigger" });
const smaller = () => screen.getByRole("button", { name: "Make Text Smaller" });
const theme = () => document.documentElement.dataset.theme;
const stored = (): unknown => JSON.parse(window.localStorage.getItem(APPEARANCE_KEY) ?? "null");

describe("Appearance", () => {
  it("applies and keeps the theme at once", async () => {
    const { user } = await setup();
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
    expect(theme()).toBeUndefined();

    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(theme()).toBe("dark");
    expect(stored()).toMatchObject({ theme: "dark" });

    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(theme()).toBe("light");
    await user.click(screen.getByRole("radio", { name: "System" }));
    expect(theme()).toBeUndefined();
    expect(stored()).toMatchObject({ theme: "system" });
  });

  it("says the choice is kept in this browser", async () => {
    await setup();
    expect(screen.getByText(/kept in this browser/)).toBeInTheDocument();
  });

  it("shows the choice this browser kept", async () => {
    window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme: "dark", textSize: 17 }));
    await setup();
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(size()).toHaveTextContent("17 pt");
    expect(theme()).toBe("dark");
  });

  it("steps the text size one point at a time and keeps every step", async () => {
    const { user } = await setup();
    expect(size()).toHaveTextContent(`${String(TEXT_SIZE.default)} pt`);
    await user.click(bigger());
    await user.click(bigger());
    expect(size()).toHaveTextContent(`${String(TEXT_SIZE.default + 2)} pt`);
    expect(stored()).toMatchObject({ textSize: TEXT_SIZE.default + 2 });
    await user.click(smaller());
    expect(size()).toHaveTextContent(`${String(TEXT_SIZE.default + 1)} pt`);
    expect(stored()).toMatchObject({ textSize: TEXT_SIZE.default + 1 });
  });

  it("zooms the page with the text size", async () => {
    const { user } = await setup();
    await user.click(bigger());
    expect(document.documentElement.style.getPropertyValue("--page-zoom")).not.toBe("");
  });

  it("disables Bigger at the largest size", async () => {
    window.localStorage.setItem(
      APPEARANCE_KEY,
      JSON.stringify({ theme: "system", textSize: TEXT_SIZE.max - 1 }),
    );
    const { user } = await setup();
    expect(bigger()).toBeEnabled();
    await user.click(bigger());
    expect(size()).toHaveTextContent(`${String(TEXT_SIZE.max)} pt`);
    expect(bigger()).toBeDisabled();
    expect(smaller()).toBeEnabled();
  });

  it("disables Smaller at the smallest size", async () => {
    window.localStorage.setItem(
      APPEARANCE_KEY,
      JSON.stringify({ theme: "system", textSize: TEXT_SIZE.min }),
    );
    await setup();
    expect(smaller()).toBeDisabled();
    expect(bigger()).toBeEnabled();
  });

  it("offers Reset to Default only away from the default", async () => {
    const { user } = await setup();
    expect(screen.queryByRole("button", { name: "Reset to Default" })).not.toBeInTheDocument();
    await user.click(smaller());
    await user.click(screen.getByRole("button", { name: "Reset to Default" }));
    expect(size()).toHaveTextContent(`${String(TEXT_SIZE.default)} pt`);
    expect(screen.queryByRole("button", { name: "Reset to Default" })).not.toBeInTheDocument();
    expect(stored()).toMatchObject({ textSize: TEXT_SIZE.default });
  });

  it("still applies the choice on this page when the browser cannot keep it", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const { user } = await setup();
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await user.click(bigger());
    expect(theme()).toBe("dark");
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(size()).toHaveTextContent(`${String(TEXT_SIZE.default + 1)} pt`);
  });

  it("follows a change made in another tab of the browser", async () => {
    await setup();
    act(() => {
      window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme: "light", textSize: 18 }));
      window.dispatchEvent(new StorageEvent("storage", { key: APPEARANCE_KEY }));
    });
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
    expect(size()).toHaveTextContent("18 pt");
    expect(theme()).toBe("light");
  });

  it("does not offer the zoom keys the browser keeps for itself", async () => {
    await setup();
    expect(screen.queryByText(/Anywhere in VidAI/)).not.toBeInTheDocument();
  });
});

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setupApp } from "@/test/app";
import { findMainPage } from "@/test/pages";
import { App } from "./App";

describe("App", () => {
  it("shows the shell, with the toast area and the tooltips around it", async () => {
    const app = await setupApp(["default"], { load: false });
    app.render(<App />);
    expect(await findMainPage()).toBeInTheDocument();
    // The toast region the whole page shares (Radix renders it as a labelled region).
    expect(document.querySelector("[data-sonner-toaster], [role=region]")).not.toBeNull();
  });

  it("does not show the dev gallery unless asked", async () => {
    const app = await setupApp(["signed-out"], { user: null, load: false });
    app.render(<App />);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});

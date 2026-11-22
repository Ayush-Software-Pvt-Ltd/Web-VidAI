/** The joined app: the timeline route, reached from the activity panel and by its address. */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerEnvContext, type PlayerEnv } from "@/features/timeline/screen/playerEnv";
import { FakeBridge, mockMeasure } from "@/features/timeline/screen/testSupport";
import { encodeVideoId } from "@/lib/videoId";
import { setupApp } from "@/test/app";
import { findMainPage } from "@/test/pages";
import { resetAddress } from "@/test/whole";
import { App } from "../../App";

resetAddress();
afterEach(() => {
  vi.restoreAllMocks();
});

const SERUM = "c0ffee00000000000000000000000001/Serum Launch";

/**
 * The whole app with a stand-in for the one thing jsdom cannot do: the HyperFrames player element
 * (it loads a script from the server and plays video). Everything else is real.
 */
async function openWithPlayer(path: string) {
  mockMeasure();
  window.history.replaceState(null, "", path);
  const app = await setupApp(["default"], { load: false });
  const bridges: FakeBridge[] = [];
  const env: PlayerEnv = {
    loadScript: () => Promise.resolve(),
    createBridge: (host) => {
      const bridge = new FakeBridge(false);
      bridge.host = host;
      bridges.push(bridge);
      return bridge;
    },
    readyTimeoutMs: 60_000,
  };
  app.render(
    <PlayerEnvContext value={env}>
      <App />
    </PlayerEnvContext>,
  );
  return { user: userEvent.setup(), app };
}

const backButton = () => screen.findByRole("button", { name: "Back to Library" });

describe("the timeline route", () => {
  it("opens at its address for a video with a project, and Back returns to the list", async () => {
    const { user, app } = await openWithPlayer(`/timeline/${encodeVideoId(SERUM)}`);
    await screen.findByTestId("frame-box");
    expect(window.location.pathname).toBe(`/timeline/${encodeVideoId(SERUM)}`);
    expect(app.store.getState().timelineVideoId).toBe(SERUM);
    await user.click(await backButton());
    await findMainPage();
    expect(app.store.getState().view).toBe("main");
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
  });

  it("opens from Open timeline in the activity panel, and Back returns to the video", async () => {
    const { user, app } = await openWithPlayer("/");
    await findMainPage();
    await user.click(await screen.findByRole("button", { name: "Serum Launch" }));
    await screen.findByRole("complementary", { name: "Activity" });
    await user.click(await screen.findByRole("button", { name: "Open timeline" }));
    await screen.findByTestId("frame-box");
    expect(window.location.pathname).toBe(`/timeline/${encodeVideoId(SERUM)}`);
    expect(screen.queryByRole("navigation", { name: "Channels" })).toBeNull();

    await user.click(await backButton());
    await findMainPage();
    // The video is still the selected one: its panel is open again.
    expect(app.store.getState().selectedVideoId).toBe(SERUM);
    expect(await screen.findByRole("complementary", { name: "Activity" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
  });

  it("the browser's Back leaves the timeline the same way", async () => {
    const { user } = await openWithPlayer("/");
    await findMainPage();
    await user.click(await screen.findByRole("button", { name: "Serum Launch" }));
    await user.click(await screen.findByRole("button", { name: "Open timeline" }));
    await screen.findByTestId("frame-box");
    window.history.back();
    await findMainPage();
    expect(window.location.pathname).toBe("/");
  });

  it("says so for a video without a project, with a way back", async () => {
    const { user } = await openWithPlayer(
      `/timeline/${encodeVideoId("c0ffee00000000000000000000000001/Hair Oil Review")}`,
    );
    expect(await screen.findByText(/no project/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Back to Library/ }));
    await findMainPage();
  });
});

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { VideoAction, VideoView } from "@/lib/types";
import { buttonActionsOf, menuActionsOf } from "./actions";
import { JobActionButtons } from "./JobActionButtons";
import { JobDialogs } from "./JobDialogs";
import { recordedApp, type RecordedApp } from "./recordedApp";

async function setup(scenarios: Parameters<typeof recordedApp>[0] = {}) {
  const env = await recordedApp(scenarios);
  return env;
}

function show(env: RecordedApp, video: VideoView) {
  env.render(
    <>
      <JobActionButtons video={video} />
      <JobDialogs />
    </>,
  );
}

const names = () => screen.getAllByRole("button").map((b) => b.textContent);

describe("JobActionButtons", () => {
  it("shows one button per action of the server and nothing else", async () => {
    const env = await setup();
    const video = { ...env.video("Hair Oil"), actions: ["startEdit"] satisfies VideoAction[] };
    show(env, video);
    expect(names()).toEqual(["Start Editing"]);
  });

  it("shows nothing for a video without actions", async () => {
    const env = await setup();
    const { container } = env.render(
      <JobActionButtons video={{ ...env.video("Hair Oil"), actions: [] }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps Upload, Disk Cleanup and Unarchive for the row menu", async () => {
    const env = await setup();
    const actions: VideoAction[] = ["review", "upload", "diskCleanup", "archive", "unarchive"];
    const video = { ...env.video("Serum Launch"), actions };
    expect(buttonActionsOf(video)).toEqual(["review", "archive"]);
    expect(menuActionsOf(video)).toEqual(["upload", "diskCleanup", "unarchive"]);
    show(env, video);
    expect(names()).toEqual(["Review", "Archive"]);
  });

  it("puts Start now first", async () => {
    const env = await setup();
    const video = {
      ...env.video("Hair Oil"),
      actions: ["stop", "startNow"] satisfies VideoAction[],
    };
    show(env, video);
    expect(names()).toEqual(["Start now", "Stop Editing"]);
  });

  it("opens Start Editing from its button, and Review opens the timeline", async () => {
    const env = await setup();
    const video = {
      ...env.video("Serum Launch"),
      actions: ["startEdit", "review"] satisfies VideoAction[],
    };
    show(env, video);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(env.store.getState().view).toBe("timeline");
    await user.click(screen.getByRole("button", { name: "Start Editing" }));
    expect(await screen.findByRole("dialog", { name: "Start Editing" })).toBeInTheDocument();
  });

  it("words the buttons of a final render for a render", async () => {
    const env = await setup({ scenarios: ["queue-full"] });
    const running = { ...env.video("Render A"), actions: ["stop"] satisfies VideoAction[] };
    show(env, running);
    expect(names()).toEqual(["Stop Rendering"]);
  });

  it("words the continue of a failed render as rendering again", async () => {
    const env = await setup({ scenarios: ["queue-full"] });
    const render = env.video("Render A");
    if (!render.job) throw new Error("seed changed");
    const failed = {
      ...render,
      job: { ...render.job, state: "failed" as const },
      actions: ["continue", "stop"] satisfies VideoAction[],
    };
    show(env, failed);
    expect(names()).toEqual(["Render Again", "Stop Rendering"]);
  });

  it("marks the main action only where emphasis is on", async () => {
    const env = await setup({ scenarios: ["busy"] });
    const paused = env.video("Serum D");
    expect(paused.actions).toContain("continue");
    env.render(<JobActionButtons video={paused} emphasis />);
    expect(screen.getByRole("button", { name: "Continue Editing" }).className).toMatch(/bg-accent/);
    expect(screen.getByRole("button", { name: "Stop Editing" }).className).not.toMatch(
      /bg-accent\b/,
    );
  });

  it("shows the running command on its button and disables the others until it is done", async () => {
    const env = await setup({ scenarios: ["busy"] });
    const video = env.video("Serum A");
    env.render(<JobActionButtons video={video} />);
    const pause = screen.getByRole("button", { name: "Pause Editing" });
    act(() => {
      fireEvent.click(pause);
    });
    expect(screen.getByRole("button", { name: "Stop Editing" })).toBeDisabled();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop Editing" })).toBeEnabled();
    });
    expect(env.calls("pauseJob")).toEqual([{ jobId: video.job?.id }]);
  });

  it("is icon-only in a narrow list, with the wording as the name", async () => {
    const env = await setup({ scenarios: ["busy"] });
    env.render(<JobActionButtons video={env.video("Serum A")} compact />);
    const pause = screen.getByRole("button", { name: "Pause Editing" });
    expect(within(pause).queryByText("Pause Editing")).not.toBeInTheDocument();
  });
});

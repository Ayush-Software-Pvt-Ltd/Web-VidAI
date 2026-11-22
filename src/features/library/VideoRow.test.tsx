/**
 * What a row says and offers (SPEC section 16): its status, what a waiting job waits for, the
 * progress bar, the actions the server lists, the row menu and the "Uploading" state.
 */
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_ID } from "@/lib/mock/seed/session";
import type { ScenarioName } from "@/lib/mock";
import { setupApp, type SetupOptions, type TestApp } from "@/test/app";
import { rowOf } from "./testSupport";
import { VideoList } from "./VideoList";
import { useLibraryView } from "./viewStore";

let app: TestApp;

async function renderList(scenarios: ScenarioName[], options: SetupOptions = { user: "user" }) {
  useLibraryView.getState().reset();
  app = await setupApp(scenarios, options);
  app.render(<VideoList />);
}

const inRow = (name: string) => within(rowOf(name));

afterEach(() => {
  vi.useRealTimers();
});

describe("VideoRow status and waiting text", () => {
  it("says Waiting, position N under a queued edit and has no progress numbers", async () => {
    await renderList(["queue-full"]);
    const queued = inRow("Edit E");
    expect(queued.getByText("Queued")).toBeInTheDocument();
    expect(queued.getByText("Waiting, position 2")).toBeInTheDocument();
    expect(inRow("Timeline C").getByText("Waiting, position 1")).toBeInTheDocument();
    expect(queued.queryByText("Urgent")).toBeNull();
  });

  it("shows Urgent as a small badge next to the position", async () => {
    await renderList(["urgent"], {
      user: "user",
      prepare: (backend) => {
        const job = backend.world.jobs.find((j) => j.view.videoId.endsWith("/Porto Food Tour"));
        if (job) job.view.urgent = true;
      },
    });
    const row = inRow("Porto Food Tour");
    expect(row.getByText(/^Waiting, position \d+$/)).toBeInTheDocument();
    expect(row.getByText("Urgent")).toBeInTheDocument();
  });

  it("counts down the start delay and leaves Start now to the server (admins only)", async () => {
    await renderList(["start-delay"]);
    const row = inRow("Held A");
    expect(row.getByText("Waiting, position 1")).toBeInTheDocument();
    expect(row.getByRole("timer")).toHaveTextContent(/^(Earliest start|Starts) in \d+ (s|min|h)/);
    // The server offers Start now only to an administrator, so this user has no such button.
    expect(row.queryByRole("button", { name: "Start now" })).toBeNull();
  });

  it("says why a queued edit waits when the user's own limit is reached", async () => {
    await renderList(["queue-full"], {
      user: "user",
      prepare: (backend) => {
        backend.world.adminSettings.maxEditsPerUser = 1;
      },
    });
    expect(inRow("Edit E").getByText(/You can edit 1 video at a time/)).toBeInTheDocument();
  });

  it("shows the progress bar of a running edit with its stage and percent", async () => {
    await renderList(["queue-full"]);
    const row = inRow("Edit C");
    expect(row.getByText("Editing")).toBeInTheDocument();
    const bar = row.getByRole("progressbar");
    expect(bar).toHaveAccessibleName(/^Progress of Edit C/);
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(row.getByText(/^\d+%$/)).toBeInTheDocument();
    expect(row.getByRole("timer", { name: /^Active for / })).toBeInTheDocument();
  });

  it("ticks the active time of a running job", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderList(["queue-full"]);
    const clock = inRow("Edit C").getByRole("timer", { name: /^Active for / });
    const before = clock.getAttribute("aria-label");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(clock.getAttribute("aria-label")).not.toBe(before);
  });
});

describe("VideoRow actions", () => {
  it("shows only the actions the server lists", async () => {
    await renderList(["queue-full"]);
    const start = inRow("Lisbon Day 1");
    expect(start.getByRole("button", { name: "Start Editing" })).toBeInTheDocument();
    expect(start.queryByRole("button", { name: "Stop Editing" })).toBeNull();
    const running = inRow("Edit C");
    expect(running.getByRole("button", { name: "Pause Editing" })).toBeInTheDocument();
    expect(running.getByRole("button", { name: "Stop Editing" })).toBeInTheDocument();
    expect(running.queryByRole("button", { name: "Start Editing" })).toBeNull();
  });

  it("opens the Timeline from Review", async () => {
    const user = userEvent.setup();
    await renderList(["queue-full"]);
    await user.click(inRow("Timeline C").getByRole("button", { name: "Review" }));
    const state = app.store.getState();
    expect(state.view).toBe("timeline");
    expect(state.timelineVideoId).toBe(app.video("Timeline C").id);
  });

  it("keeps the rare actions in the menu next to View activity, and no Reveal or Open", async () => {
    const user = userEvent.setup();
    await renderList(["queue-full"]);
    await user.click(inRow("Edit E").getByRole("button", { name: "More for Edit E" }));
    const menu = await screen.findByRole("menu");
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(items).toEqual(["Upload Files", "View activity"]);
    expect(within(menu).queryByText(/Finder|Reveal|Open /)).toBeNull();
    await user.click(within(menu).getByRole("menuitem", { name: "View activity" }));
    expect(app.store.getState().selectedVideoId).toBe(app.video("Edit E").id);
  });

  it("selects a row only from the row itself, never from its controls", async () => {
    const user = userEvent.setup();
    await renderList(["queue-full"]);
    await user.click(inRow("Edit C").getByRole("button", { name: "Pause Editing" }));
    expect(app.store.getState().selectedVideoId).toBeNull();
    await user.click(screen.getByText("Lisbon Day 1"));
    expect(app.store.getState().selectedVideoId).toBe(app.video("Lisbon Day 1").id);
  });
});

describe("VideoRow upload state", () => {
  const uploading: SetupOptions = {
    user: "user",
    prepare: (backend) => {
      const video = backend.world.videos.find((v) => v.userId === USER_ID);
      if (!video) throw new Error("no video");
      backend.world.uploads.push({
        id: "up-1",
        userId: USER_ID,
        channelId: video.channelId,
        videoId: `${video.channelId}/${video.folderName}`,
        name: "a-roll.mp4",
        size: 100,
        received: 40,
        done: false,
        modifiedAt: 0,
      });
    },
  };

  it("says Uploading quietly and offers no Start Editing", async () => {
    await renderList(["default"], uploading);
    const row = inRow("Lisbon Day 1");
    expect(app.video("Lisbon Day 1").uploading).toBe(true);
    expect(row.getByText("Uploading")).toBeInTheDocument();
    expect(row.queryByRole("button", { name: "Start Editing" })).toBeNull();
    expect(row.queryByRole("progressbar")).toBeNull();
  });
});

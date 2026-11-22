import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { addJob } from "@/lib/mock/seed/jobs";
import { ADMIN_EMAIL, ADMIN_ID, USER_EMAIL } from "@/lib/mock/seed/session";
import { ADMIN_CHANNEL_BEAUTY } from "@/lib/mock/seed/workspace";
import { renderApp } from "@/test/app";
import { QueuePage } from "./QueuePage";

async function open(
  scenarios: Parameters<typeof renderApp>[1] = ["queue-full"],
  options?: Parameters<typeof renderApp>[2],
) {
  const app = await renderApp(<QueuePage />, scenarios, options);
  await screen.findByText("Timeline changes");
  return app;
}

/** The rows of one group, as the page orders them. */
function group(title: string): HTMLElement {
  const heading = screen.getByRole("heading", { name: title });
  const section = heading.closest("section");
  if (!section) throw new Error(`No group ${title}`);
  return section;
}

const titles = (section: HTMLElement) =>
  within(section)
    .queryAllByTestId("queue-row")
    .map((r) => /(Edit|Timeline|Render|Held|Serum) [A-Z]/.exec(r.textContent)?.[0] ?? "?");

describe("QueuePage", () => {
  it("groups the jobs of every user by line, with who they belong to", async () => {
    await open();
    expect(titles(group("Edits"))).toEqual(["Edit A", "Edit B", "Edit C", "Edit D", "Edit E"]);
    expect(titles(group("Timeline changes"))).toEqual(["Timeline A", "Timeline B", "Timeline C"]);
    expect(titles(group("Renders"))).toEqual(["Render A", "Render B"]);
    const rows = within(group("Edits")).getAllByTestId("queue-row");
    expect(rows[0]).toHaveTextContent(ADMIN_EMAIL);
    expect(rows[2]).toHaveTextContent(USER_EMAIL);
    expect(rows[0]).toHaveTextContent("Editing");
    expect(rows[3]).toHaveTextContent("Queued");
    expect(rows[3]).toHaveTextContent("position 1");
  });

  it("says how full each line is", async () => {
    const app = await open();
    const slots = app.backend.world.adminSettings.maxEdits;
    expect(group("Edits")).toHaveTextContent(`of ${String(slots)} slot`);
    expect(group("Edits")).toHaveTextContent("2 waiting");
    expect(group("Renders")).toHaveTextContent("1 waiting");
  });

  it("shows an empty line for each group when nothing is active", async () => {
    await open(["default"], {
      prepare: (backend) => {
        backend.world.jobs = [];
      },
    });
    expect(screen.getByText("No edit is running or waiting.")).toBeInTheDocument();
    expect(screen.getByText("No timeline change is running or waiting.")).toBeInTheDocument();
    expect(screen.getByText("No render is running or waiting.")).toBeInTheDocument();
    expect(screen.queryByTestId("queue-row")).not.toBeInTheDocument();
  });

  it("offers Urgent only on edits that wait", async () => {
    await open();
    expect(screen.getAllByRole("checkbox", { name: /^Urgent:/ })).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: /Urgent: .*Edit D/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Urgent: Edit A/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Urgent: Timeline C/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Urgent: Render B/ })).not.toBeInTheDocument();
  });

  it("moves an edit marked Urgent to the front of the waiting ones, and back", async () => {
    const user = userEvent.setup();
    const app = await open();
    const box = () => screen.getByRole("checkbox", { name: /Urgent: .*Edit E/ });
    await user.click(box());
    await waitFor(() => {
      expect(titles(group("Edits")).slice(3)).toEqual(["Edit E", "Edit D"]);
    });
    expect(box()).toBeChecked();
    expect(
      app.backend.world.jobs.find((j) => j.view.videoId.endsWith("/Edit E"))?.view.urgent,
    ).toBe(true);
    await user.click(box());
    await waitFor(() => {
      expect(titles(group("Edits")).slice(3)).toEqual(["Edit D", "Edit E"]);
    });
  });

  it("lets an edit held by the start delay start now", async () => {
    const user = userEvent.setup();
    const app = await open(["start-delay"]);
    // Only the first in line is held by the delay.
    expect(screen.getAllByRole("button", { name: /^Start now:/ })).toHaveLength(1);
    expect(group("Edits")).toHaveTextContent(/Starts in \d+ (s|min)/);
    await user.click(screen.getByRole("button", { name: /Start now: .*Held A/ }));
    await waitFor(() => {
      expect(
        app.backend.world.jobs.find((j) => j.view.videoId.endsWith("/Held A"))?.view.state,
      ).toBe("running");
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Start now: .*Held A/ })).not.toBeInTheDocument();
    });
    expect(
      within(group("Edits"))
        .getAllByTestId("queue-row")
        .find((r) => r.textContent.includes("Held A")),
    ).toHaveTextContent("Editing");
  });

  it("does not offer Start now on running jobs, timeline changes or renders", async () => {
    await open();
    expect(screen.queryByRole("button", { name: /Start now/ })).not.toBeInTheDocument();
  });

  it("follows the queue as it changes", async () => {
    const app = await open();
    await app.tick(40);
    await waitFor(() => {
      const rows = within(group("Edits")).getAllByTestId("queue-row");
      expect(rows.length).toBeLessThan(5);
    });
  });

  it("keeps a long list responsive: only a window of rows is drawn and one change redraws only its row", async () => {
    const user = userEvent.setup();
    const app = await open(["default"], {
      prepare: (backend) => {
        backend.world.jobs = [];
        const now = Date.now();
        for (let n = 0; n < 150; n += 1) {
          addJob(
            backend.world,
            {
              channelId: ADMIN_CHANNEL_BEAUTY,
              userId: ADMIN_ID,
              folderName: `Bulk ${String(n).padStart(3, "0")}`,
              state: "queued",
              joinedMinutesAgo: 200 - n,
            },
            now,
          );
        }
      },
    });
    await waitFor(() => {
      expect(within(group("Edits")).getAllByTestId("queue-row").length).toBeGreaterThan(5);
    });
    const rows = within(group("Edits")).getAllByTestId("queue-row");
    expect(rows.length).toBeLessThan(60);
    expect(app.store.getState().adminQueue.data?.jobs).toHaveLength(150);
    const second = rows[1];
    await user.click(within(rows[0] as HTMLElement).getByRole("checkbox"));
    await waitFor(() => {
      expect(app.store.getState().adminQueue.data?.jobs.some((j) => j.urgent)).toBe(true);
    });
    // The second row is the very same element after the list was redrawn.
    expect(within(group("Edits")).getAllByTestId("queue-row")).toContain(second);
  });

  it("draws the rows further down when the list is scrolled", async () => {
    await open(["default"], {
      prepare: (backend) => {
        backend.world.jobs = [];
        const now = Date.now();
        for (let n = 0; n < 300; n += 1) {
          addJob(
            backend.world,
            {
              channelId: ADMIN_CHANNEL_BEAUTY,
              userId: ADMIN_ID,
              folderName: `Bulk ${String(n).padStart(3, "0")}`,
              state: "queued",
              joinedMinutesAgo: 400 - n,
            },
            now,
          );
        }
      },
    });
    await waitFor(() => {
      expect(within(group("Edits")).getAllByTestId("queue-row").length).toBeGreaterThan(5);
    });
    expect(within(group("Edits")).queryByText(/Bulk 250/)).not.toBeInTheDocument();
    const viewport = group("Edits").querySelector<HTMLElement>("[data-radix-scroll-area-viewport]");
    if (!viewport) throw new Error("The line has no scrolling box.");
    act(() => {
      viewport.scrollTop = 250 * 57;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(await within(group("Edits")).findByText(/Bulk 250/)).toBeInTheDocument();
    expect(within(group("Edits")).queryByText(/Bulk 000/)).not.toBeInTheDocument();
  });
});

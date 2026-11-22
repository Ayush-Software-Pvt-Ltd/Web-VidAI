import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { recordedApp, type RecordedApp } from "@/features/jobs/recordedApp";
import { DiskCleanupPage } from "./DiskCleanupPage";
import { ACTIVE_JOB_TEXT, deleteLabel } from "./model";
import { requestDiskCleanup } from "./request";

async function open(scenarios: Parameters<typeof recordedApp>[0] = {}): Promise<RecordedApp> {
  const app = await recordedApp(scenarios);
  app.render(<DiskCleanupPage />);
  await screen.findByRole("checkbox", { name: "Select all that can be cleaned" });
  return app;
}

const box = (name: string) => screen.getByRole("checkbox", { name });
const folderNames = () =>
  screen
    .getAllByRole("checkbox")
    .map((c) => c.closest("label")?.textContent ?? c.getAttribute("aria-label") ?? "")
    .filter((text) => text !== "" && !text.startsWith("Select all"));

describe("DiskCleanupPage list", () => {
  it("lists the videos per channel, largest first, with the totals at the top", async () => {
    const app = await open();
    const sizes = app.store.getState().diskUse.data;
    expect(sizes).not.toBeNull();
    const names = folderNames();
    expect(names.indexOf("Serum Launch")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("Serum Launch")).toBeLessThan(names.indexOf("Lip Balm Haul"));
    const disk = screen.getByRole("region", { name: "Disk use" });
    expect(within(disk).getByText("Working files")).toBeInTheDocument();
    expect(within(disk).getByText("All your videos")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Beauty Channel" })).toBeInTheDocument();
    expect(screen.getAllByText(/Whole folder /).length).toBeGreaterThan(0);
  });

  it("starts with nothing chosen and the button disabled", async () => {
    await open();
    expect(screen.getByRole("button", { name: "Delete working files" })).toBeDisabled();
  });

  it("selects one video and names the count and the sum on the button", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(box("Serum Launch"));
    expect(
      screen.getByRole("button", { name: "Delete working files: 1 video, 12.3 GB" }),
    ).toBeEnabled();
  });

  it("selects every video that can be cleaned with 'Select all', and clears again", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("checkbox", { name: "Select all that can be cleaned" }));
    const rows = app.store
      .getState()
      .diskUse.data?.videos.filter((v) => (v.sizes?.working ?? 0) > 0);
    expect(
      screen.getByRole("button", { name: /^Delete working files: \d+ videos?, / }),
    ).toBeEnabled();
    expect(rows?.length ?? 0).toBeGreaterThan(1);
    await user.click(screen.getByRole("checkbox", { name: "Select all that can be cleaned" }));
    expect(screen.getByRole("button", { name: "Delete working files" })).toBeDisabled();
  });
});

describe("DiskCleanupPage blocked and measuring videos", () => {
  it("shows the server's sentence for a video with a running job and cannot select it", async () => {
    const user = userEvent.setup();
    await open({ scenarios: ["disk-large"] });
    const blocked = box("Interview Rough Cut");
    expect(blocked).toBeDisabled();
    expect(screen.getAllByText(ACTIVE_JOB_TEXT)).toHaveLength(1);
    await user.click(screen.getByRole("checkbox", { name: "Select all that can be cleaned" }));
    expect(blocked).not.toBeChecked();
    expect(box("Studio Tour Part 1")).toBeChecked();
  });

  it("says Measuring instead of zero while the server has not measured a folder", async () => {
    const app = await open({ scenarios: ["disk-large"] });
    expect(screen.getByRole("status")).toHaveTextContent("Measuring your videos");
    expect(screen.getAllByText("Measuring…").length).toBeGreaterThan(0);
    await app.tick(4);
    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
  });
});

describe("DiskCleanupPage cleaning", () => {
  it("confirms, deletes, shows the result per video and refreshes the library", async () => {
    const user = userEvent.setup();
    const app = await open();
    const serum = app.video("Serum Launch");
    expect(serum.actions).toContain("diskCleanup");
    await user.click(box("Serum Launch"));
    await user.click(screen.getByRole("button", { name: /^Delete working files: / }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Delete Working Files" }));
    expect(await screen.findByText("Freed 12.3 GB.")).toBeInTheDocument();
    expect(app.calls("cleanWorkingFiles")).toEqual([{ videoId: serum.id }]);
    expect(screen.getByText("Freed 12.3 GB from 1 video.")).toBeInTheDocument();
    await waitFor(() => {
      expect(app.video("Serum Launch").actions).not.toContain("diskCleanup");
    });
  });

  it("gives focus back to the page after the run", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(box("Serum Launch"));
    await user.click(screen.getByRole("button", { name: /^Delete working files: / }));
    await user.click(await screen.findByRole("button", { name: "Delete Working Files" }));
    await screen.findByText("Freed 12.3 GB.");
    await waitFor(() => {
      expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
      expect(document.activeElement).not.toBe(document.body);
    });
  });

  it("does nothing when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(box("Serum Launch"));
    await user.click(screen.getByRole("button", { name: /^Delete working files: / }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(app.calls("cleanWorkingFiles")).toEqual([]);
    expect(box("Serum Launch")).toBeChecked();
  });

  it("shows one refusal next to the other videos' results", async () => {
    const user = userEvent.setup();
    const app = await open();
    app.refuse("cleanWorkingFiles", "conflict", "The folder is busy.");
    await user.click(box("Serum Launch"));
    await user.click(box("Lip Balm Haul"));
    await user.click(screen.getByRole("button", { name: /^Delete working files: / }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/2 videos will lose their working files/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Delete Working Files" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The folder is busy.");
    // The mock's Lip Balm Haul keeps two files the cleanup cannot remove.
    expect(
      await screen.findByText("Freed 6.4 GB. 2 items could not be removed."),
    ).toBeInTheDocument();
    expect(app.calls("cleanWorkingFiles")).toHaveLength(2);
    expect(
      screen.getByText(/Freed 6\.4 GB from 1 video\. 1 video could not be cleaned/),
    ).toBeInTheDocument();
  });
});

describe("DiskCleanupPage from the video menu", () => {
  it("opens the confirmation for the video that asked", async () => {
    const app = await recordedApp();
    const laptop = app.video("Laptop Teardown");
    requestDiskCleanup(laptop.id);
    app.render(<DiskCleanupPage />);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Laptop Teardown")).toBeInTheDocument();
    expect(within(dialog).getByText(/This frees 3\.1 GB\./)).toBeInTheDocument();
    await userEvent
      .setup()
      .click(within(dialog).getByRole("button", { name: "Delete Working Files" }));
    await screen.findByText("Freed 3.1 GB.");
    expect(app.calls("cleanWorkingFiles")).toEqual([{ videoId: laptop.id }]);
  });

  it("asks nothing for a video that cannot be cleaned now", async () => {
    const app = await recordedApp({ scenarios: ["disk-large"] });
    requestDiskCleanup(app.video("Interview Rough Cut").id);
    app.render(<DiskCleanupPage />);
    await screen.findByRole("checkbox", { name: "Select all that can be cleaned" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("DiskCleanupPage refresh", () => {
  it("follows disk-use-changed: a video cleaned elsewhere leaves the list", async () => {
    const app = await open();
    const serum = app.video("Serum Launch");
    expect(screen.getByRole("checkbox", { name: "Serum Launch" })).toBeInTheDocument();
    await act(async () => {
      await app.backend.cleanWorkingFiles({ videoId: serum.id });
    });
    await waitFor(() => {
      expect(screen.queryByRole("checkbox", { name: "Serum Launch" })).not.toBeInTheDocument();
    });
    expect(screen.getByText(/other videos? (has|have) no working files/)).toBeInTheDocument();
  });

  it("goes back to the videos with Done and with Escape", async () => {
    const user = userEvent.setup();
    const app = await open();
    app.store.getState().setView("diskCleanup");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(app.store.getState().view).toBe("main");
    app.store.getState().setView("diskCleanup");
    await user.keyboard("{Escape}");
    expect(app.store.getState().view).toBe("main");
  });
});

describe("DiskCleanupPage empty", () => {
  it("says there is nothing to delete when no video has working files", async () => {
    const app = await recordedApp({
      prepare: (backend) => {
        for (const video of backend.world.videos) video.workingFiles = false;
        for (const [id, sizes] of Object.entries(backend.world.diskSizes)) {
          backend.world.diskSizes[id] = {
            ...sizes,
            total: sizes.total - sizes.working,
            working: 0,
          };
        }
      },
    });
    app.render(<DiskCleanupPage />);
    expect(await screen.findByText("No working files to delete")).toBeInTheDocument();
    expect(deleteLabel([])).toBe("Delete working files");
  });
});

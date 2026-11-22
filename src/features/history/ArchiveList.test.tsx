import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { setupApp, type TestApp } from "@/test/app";
import { ArchiveList } from "./ArchiveList";

let app: TestApp;

async function renderArchive() {
  app = await setupApp(["default"]);
  app.render(<ArchiveList />);
}

describe("ArchiveList", () => {
  it("lists the archived videos with their channel, folder and archive time", async () => {
    await renderArchive();
    const entry = await waitFor(() => {
      const first = app.store.getState().archived.data?.[0];
      if (!first) throw new Error("not loaded");
      return first;
    });
    const row = (await screen.findByText(entry.folderName)).closest("div.flex-col");
    expect(row).not.toBeNull();
    const inRow = within(row as HTMLElement);
    expect(inRow.getByText(entry.channelName)).toBeInTheDocument();
    expect(inRow.getByText(/^Archived /)).toBeInTheDocument();
  });

  it("unarchives a video, which leaves the list and returns to the library", async () => {
    const user = userEvent.setup();
    await renderArchive();
    const entry = (await waitFor(() => {
      const first = app.store.getState().archived.data?.[0];
      if (!first) throw new Error("not loaded");
      return first;
    })) as { videoId: string; folderName: string };
    await user.click(await screen.findByRole("button", { name: `Unarchive ${entry.folderName}` }));
    expect(await screen.findByText(/^Nothing archived/)).toBeInTheDocument();
    const ids = (app.store.getState().library.data?.channels ?? []).flatMap((c) =>
      c.videos.map((v) => v.id),
    );
    expect(ids).toContain(entry.videoId);
  });

  it("shows the server's refusal inline under the row", async () => {
    const user = userEvent.setup();
    await renderArchive();
    const entry = await waitFor(() => {
      const first = app.store.getState().archived.data?.[0];
      if (!first) throw new Error("not loaded");
      return first;
    });
    // Someone else (another browser) already unarchived it: the server refuses the second time.
    for (const video of app.backend.world.videos) {
      if (video.folderName === entry.folderName) video.archivedAt = null;
    }
    await user.click(await screen.findByRole("button", { name: `Unarchive ${entry.folderName}` }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This video is not archived.");
    expect(screen.getByRole("button", { name: `Unarchive ${entry.folderName}` })).toBeEnabled();
  });

  it("says when nothing is archived", async () => {
    app = await setupApp(["default"], { user: "user" });
    app.render(<ArchiveList />);
    expect(await screen.findByText(/^Nothing archived/)).toBeInTheDocument();
  });
});

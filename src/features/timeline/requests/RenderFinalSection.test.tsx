import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { JobDialogs } from "@/features/jobs";
import { TIMELINE_VIDEOS } from "@/lib/mock/seed/timeline";
import type { MockBackend, ScenarioName } from "@/lib/mock";
import { encodeVideoId } from "@/lib/videoId";
import { ONLY_ON_REQUEST } from "./RenderFinalSection";
import { RequestsPanel } from "./RequestsPanel";
import { must, requestsApp } from "./testApp";

const FINALS = [
  { name: "final_1080p.mp4", path: "output/final_1080p.mp4", size: 900_000_000, modifiedAt: 1_000 },
  {
    name: "final_2160p.mp4",
    path: "output/final_2160p.mp4",
    size: 3_100_000_000,
    modifiedAt: 9_000,
  },
];

async function setup(
  videoId: string = TIMELINE_VIDEOS.long,
  scenarios?: ScenarioName[],
  withFinals = false,
) {
  const app = await requestsApp(videoId, scenarios, {
    prepare: (backend: MockBackend) => {
      if (!withFinals) return;
      const video = must(
        backend.world.videos.find((v) => `${v.channelId}/${v.folderName}` === videoId),
      );
      video.output.finals = FINALS.map((file) => ({ ...file }));
    },
  });
  app.mount(
    <>
      <RequestsPanel videoId={app.videoId} />
      <JobDialogs />
    </>,
  );
  return app;
}

const renderButton = () => screen.getByRole("button", { name: "Render Final" });

async function startRender() {
  await userEvent.click(renderButton());
  const dialog = await screen.findByRole("dialog", { name: "Render Final" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Render Final" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Render Final" })).toBeNull();
  });
}

describe("Render Final", () => {
  it("is available when nothing else is going on, and says it is only made on request", async () => {
    await setup();
    expect(renderButton()).toBeEnabled();
    expect(screen.getByText(ONLY_ON_REQUEST)).toBeInTheDocument();
    expect(screen.queryByText("Finished videos")).toBeNull();
  });

  it("opens the sheet with the sizes", async () => {
    await setup();
    await userEvent.click(renderButton());
    const dialog = await screen.findByRole("dialog", { name: "Render Final" });
    expect(within(dialog).getByRole("radio", { name: "1080p" })).toBeChecked();
  });

  it("waits while a change request is not applied yet", async () => {
    await setup(TIMELINE_VIDEOS.notes);
    expect(renderButton()).toBeDisabled();
    expect(
      screen.getByText(/Render Final waits until all 2 change requests are applied\./),
    ).toBeInTheDocument();
    expect(renderButton()).toHaveAccessibleDescription(/change requests are applied/);
  });

  it("waits for a single change request with its own sentence", async () => {
    const app = await setup();
    await act(async () => {
      await app.store.getState().addTimelineNote(app.videoId, {
        frame: 100,
        shape: null,
        elementId: null,
        prompt: "Brighter",
      });
    });
    expect(renderButton()).toBeDisabled();
    expect(
      screen.getByText("Render Final waits until the change request is applied."),
    ).toBeInTheDocument();
  });

  it("waits while another job works on the video, and is enabled again afterwards", async () => {
    const app = await setup(TIMELINE_VIDEOS.locked, ["timeline", "timeline-locked"]);
    expect(renderButton()).toBeDisabled();
    expect(screen.getAllByText(/Render Final waits until/).length).toBeGreaterThan(0);
    for (let n = 0; n < 15 && renderButton().hasAttribute("disabled"); n += 1) await app.tick();
    expect(renderButton()).toBeEnabled();
  });

  it("says why a project with errors cannot be rendered", async () => {
    await setup(TIMELINE_VIDEOS.broken, ["timeline", "timeline-broken"]);
    expect(renderButton()).toBeDisabled();
    expect(
      screen.getByText(/The project has errors, so it cannot be rendered\./),
    ).toBeInTheDocument();
  });

  it("shows the progress of a render, with Stop that asks first", async () => {
    const app = await setup();
    await startRender();
    expect(renderButton()).toBeDisabled();
    expect(
      screen.getByText("A final render of this video is already queued or running."),
    ).toBeInTheDocument();
    await app.tick();
    expect(
      await screen.findByRole("progressbar", { name: "Progress of the final render" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop Rendering" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("Stop rendering?");
    await userEvent.click(within(confirm).getByRole("button", { name: "Keep Rendering" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("stops a render after the confirmation", async () => {
    const app = await setup();
    await startRender();
    await app.tick();
    await userEvent.click(await screen.findByRole("button", { name: "Stop Rendering" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Stop Rendering",
      }),
    );
    const bar = () => screen.queryByRole("progressbar", { name: "Progress of the final render" });
    for (let n = 0; n < 10 && bar(); n += 1) await app.tick();
    expect(bar()).toBeNull();
    await waitFor(() => {
      expect(renderButton()).toBeEnabled();
    });
  });

  it("finishes a render and lists the new video", async () => {
    const app = await setup();
    await startRender();
    for (let n = 0; n < 20 && !screen.queryByText("Finished videos"); n += 1) await app.tick();
    expect(await screen.findByText("Finished videos")).toBeInTheDocument();
    expect(renderButton()).toBeEnabled();
  });
});

describe("Finished videos", () => {
  it("lists the newest first, with the latest marked, size and age", async () => {
    await setup(TIMELINE_VIDEOS.long, undefined, true);
    const list = must(screen.getByText("Finished videos").parentElement);
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("final_2160p.mp4");
    expect(within(must(items[0])).getByText("Latest")).toBeInTheDocument();
    expect(items[0]).toHaveTextContent(/3\.1 GB|2\.9 GB/);
    expect(items[1]).toHaveTextContent("final_1080p.mp4");
    expect(within(must(items[1])).queryByText("Latest")).toBeNull();
  });

  it("downloads through the file address that carries the encoded video id", async () => {
    await setup(TIMELINE_VIDEOS.long, undefined, true);
    const link = screen.getByRole("link", { name: "Download final_2160p.mp4" });
    expect(link).toHaveAttribute("download");
    expect(link.getAttribute("href")).toBe(
      `/api/file?video=${encodeVideoId(TIMELINE_VIDEOS.long)}&path=${encodeURIComponent("output/final_2160p.mp4")}&download=1`,
    );
  });

  it("plays in a dialog from the same address without the download flag", async () => {
    await setup(TIMELINE_VIDEOS.long, undefined, true);
    await userEvent.click(screen.getByRole("button", { name: "Play final_1080p.mp4" }));
    const dialog = await screen.findByRole("dialog", { name: "final_1080p.mp4" });
    const player = dialog.querySelector("video");
    expect(player).not.toBeNull();
    expect(player?.getAttribute("src")).toBe(
      `/api/file?video=${encodeVideoId(TIMELINE_VIDEOS.long)}&path=${encodeURIComponent("output/final_1080p.mp4")}`,
    );
    expect(player).toHaveAttribute("controls");
  });

  it("says the video cannot be played in the page when the player fails", async () => {
    await setup(TIMELINE_VIDEOS.long, undefined, true);
    await userEvent.click(screen.getByRole("button", { name: "Play final_1080p.mp4" }));
    const dialog = await screen.findByRole("dialog", { name: "final_1080p.mp4" });
    act(() => {
      dialog.querySelector("video")?.dispatchEvent(new Event("error"));
    });
    expect(await within(dialog).findByText(/cannot be played in the page/)).toBeInTheDocument();
  });
});

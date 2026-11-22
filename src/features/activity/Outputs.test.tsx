import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobView, OutputFile, VideoOutput, VideoView } from "@/lib/types";
import { setupApp, type TestApp } from "@/test/app";
import { Outputs, TEXT_LIMIT_BYTES } from "./Outputs";

const NOW = Date.now();

function file(name: string, size: number, ageMinutes: number): OutputFile {
  return { name, path: `output/${name}`, size, modifiedAt: NOW - ageMinutes * 60_000 };
}

const NOTHING: VideoOutput = {
  project: null,
  finals: [],
  newestFinal: null,
  thumbnails: [],
  metaFile: null,
  infoFile: null,
};

/** A video of the default world with `output` (and, when given, `job`) swapped in. */
async function renderOutputs(
  output: Partial<VideoOutput>,
  options: { job?: JobView | null; prefix?: string } = {},
): Promise<{ env: TestApp; video: VideoView }> {
  const env = await setupApp();
  const base = env.video(options.prefix ?? "Draft Without");
  const video: VideoView = {
    ...base,
    output: { ...NOTHING, ...output },
    ...(options.job !== undefined ? { job: options.job } : {}),
  };
  env.render(<Outputs video={video} />);
  return { env, video };
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Outputs", () => {
  it("says there is nothing yet for a video that was never edited", async () => {
    await renderOutputs({});
    expect(screen.getByText("No outputs yet")).toBeVisible();
    expect(
      screen.getByText("Start Editing, and the project appears here when the edit is done."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open timeline" })).toBeNull();
  });

  it("explains an empty output by what the job did", async () => {
    const env = await setupApp(["busy"]);
    const running = env.video("Serum A").job;
    const failed = env.video("Serum A").job;
    if (!running || !failed) throw new Error("no job");
    const states: [Partial<JobView>, string][] = [
      [{ state: "running" }, "The project appears here when the edit is done."],
      [
        { state: "running", kind: "render" },
        "The finished video appears here when the render is done.",
      ],
      [{ state: "failed" }, "The job did not finish, so there is nothing to show yet."],
      [{ state: "stopped" }, "The job was stopped before it made anything."],
    ];
    for (const [change, sentence] of states) {
      const { unmount } = env.render(
        <Outputs video={{ ...env.video("Serum A"), job: { ...running, ...change } }} />,
      );
      expect(screen.getByText(sentence)).toBeVisible();
      unmount();
    }
  });

  it("shows the project with Open timeline, which opens the timeline of the video", async () => {
    const { env, video } = await renderOutputs({
      project: { path: "output/timeline.json", modifiedAt: NOW - 5 * 60_000 },
    });
    const section = screen.getByRole("region", { name: "Project" });
    expect(within(section).getByText("Timeline project")).toBeVisible();
    expect(within(section).getByText(/^Saved 5 minutes ago$/)).toBeVisible();
    await userEvent.click(within(section).getByRole("button", { name: "Open timeline" }));
    expect(env.store.getState().view).toBe("timeline");
    expect(env.store.getState().timelineVideoId).toBe(video.id);
    // No Reveal and no Open in another program any more.
    expect(screen.queryByRole("button", { name: /Reveal|Open in|Show in/ })).toBeNull();
  });

  it("plays each final in the page and downloads it, with the encoded video id", async () => {
    const { video } = await renderOutputs({
      finals: [file("old_final_v1.mp4", 12_000_000, 120), file("new_final_v2.mp4", 15_500_000, 5)],
      newestFinal: "output/new_final_v2.mp4",
    });
    const id = encodeURIComponent(video.id);
    expect(id).toContain("%2F");
    const section = screen.getByRole("region", { name: "Finished videos" });
    const players = Array.from(section.querySelectorAll("video"));
    // Newest first.
    expect(players.map((p) => p.getAttribute("src"))).toEqual([
      `/api/file?video=${id}&path=${encodeURIComponent("output/new_final_v2.mp4")}`,
      `/api/file?video=${id}&path=${encodeURIComponent("output/old_final_v1.mp4")}`,
    ]);
    for (const player of players) {
      expect(player).toHaveAttribute("controls");
      expect(player).toHaveAttribute("preload", "metadata");
    }
    expect(screen.getByRole("link", { name: "Download new_final_v2.mp4" })).toHaveAttribute(
      "href",
      `/api/file?video=${id}&path=${encodeURIComponent("output/new_final_v2.mp4")}&download=1`,
    );
    expect(screen.getByRole("link", { name: "Download old_final_v1.mp4" })).toHaveAttribute(
      "href",
      `/api/file?video=${id}&path=${encodeURIComponent("output/old_final_v1.mp4")}&download=1`,
    );
    expect(screen.getByText(/^14\.8 MB, rendered 5 minutes ago$/)).toBeVisible();
    expect(screen.getByText(/^11\.4 MB, rendered 2 hours ago$/)).toBeVisible();
    expect(screen.getAllByText("Latest")).toHaveLength(1);
  });

  it("does not call a single final the latest", async () => {
    await renderOutputs({
      finals: [file("a_final_v1.mp4", 1_000_000, 5)],
      newestFinal: "output/a_final_v1.mp4",
    });
    expect(screen.getByRole("region", { name: "Finished video" })).toBeVisible();
    expect(screen.queryByText("Latest")).toBeNull();
  });

  it("replaces a player that fails with a sentence, keeping the download", async () => {
    await renderOutputs({ finals: [file("a_final_v1.mp4", 1_000_000, 5)] });
    const player = screen.getByLabelText("Player of a_final_v1.mp4");
    fireEvent.error(player);
    expect(
      await screen.findByText("This video cannot be played in the page. Download it to watch it."),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Download a_final_v1.mp4" })).toBeVisible();
  });

  it("shows thumbnails as images that open in a new tab", async () => {
    const { env, video } = await renderOutputs({
      thumbnails: [file("thumbnail-1.png", 200_000, 5), file("thumbnail-2.jpg", 190_000, 5)],
    });
    const section = screen.getByRole("region", { name: "Thumbnails" });
    const links = within(section).getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute(
      "href",
      env.backend.fileUrl(video.id, "output/thumbnail-1.png"),
    );
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0]).toHaveAttribute("rel", "noreferrer");
    expect(section.querySelectorAll("img")).toHaveLength(2);
    // A thumbnail that cannot load becomes a quiet placeholder, not a broken image.
    const img = section.querySelector("img");
    if (!img) throw new Error("no image");
    fireEvent.error(img);
    await waitFor(() => {
      expect(section.querySelectorAll("img")).toHaveLength(1);
    });
  });

  it("shows info.txt and meta.txt as text fetched through the file URL", async () => {
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        // The mock's text addresses carry the content, not the file name: info.txt is asked first.
        fetched.push(url);
        return Promise.resolve(
          textResponse(fetched.length === 1 ? "Product: Serum" : "Title: Serum review"),
        );
      }),
    );
    const { env, video } = await renderOutputs({
      infoFile: "info.txt",
      metaFile: "output/meta.txt",
    });
    expect(await screen.findByLabelText("info.txt")).toHaveTextContent("Product: Serum");
    expect(await screen.findByLabelText("meta.txt")).toHaveTextContent("Title: Serum review");
    expect(fetched).toEqual([
      env.backend.fileUrl(video.id, "info.txt"),
      env.backend.fileUrl(video.id, "output/meta.txt"),
    ]);
    expect(screen.getByRole("link", { name: "Download info.txt" })).toHaveAttribute(
      "href",
      env.backend.fileUrl(video.id, "info.txt", { download: true }),
    );
  });

  it("shows the mock's own text for meta.txt and info.txt without any stubbed fetch", async () => {
    await renderOutputs({ infoFile: "info.txt", metaFile: "output/meta.txt" });
    expect(await screen.findByLabelText("info.txt")).toHaveTextContent("Product: Example Serum");
    expect(await screen.findByLabelText("meta.txt")).toHaveTextContent("an honest review");
  });

  it("says plainly when a text file cannot be loaded, and tries again", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        attempts += 1;
        return Promise.resolve(attempts === 1 ? textResponse("nope", 404) : textResponse("Back"));
      }),
    );
    await renderOutputs({ infoFile: "info.txt" });
    expect(await screen.findByText("Could not load info.txt.")).toBeVisible();
    expect(screen.queryByLabelText("info.txt")).toBeNull();
    // The rest of the panel does not depend on it.
    expect(screen.getByRole("link", { name: "Download info.txt" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(await screen.findByLabelText("info.txt")).toHaveTextContent("Back");
    expect(attempts).toBe(2);
  });

  it("says plainly when the request itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    await renderOutputs({ metaFile: "output/meta.txt" });
    expect(await screen.findByText("Could not load meta.txt.")).toBeVisible();
  });

  it("shows only the first part of a long text file and says so", async () => {
    const body = "a".repeat(TEXT_LIMIT_BYTES) + "TAIL-NOT-SHOWN".repeat(500);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(textResponse(body))),
    );
    await renderOutputs({ infoFile: "info.txt" });
    const pre = await screen.findByLabelText("info.txt");
    expect(pre.textContent).toHaveLength(TEXT_LIMIT_BYTES);
    expect(pre.textContent).not.toContain("TAIL");
    expect(
      screen.getByText("The file is longer than the preview. Download it to read the rest."),
    ).toBeVisible();
  });

  it("says an empty text file is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(textResponse(""))),
    );
    await renderOutputs({ infoFile: "info.txt" });
    expect(await screen.findByLabelText("info.txt")).toHaveTextContent("The file is empty.");
  });
});

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { jobsControllerFor } from "@/features/jobs";
import { LibraryToolbar, NewVideoProvider, VideoList } from "@/features/library";
import type { Api } from "@/lib/api";
import { AppEnvContext } from "@/lib/appEnv";
import { ApiError } from "@/lib/errors";
import type { MockBackend } from "@/lib/mock";
import { ADMIN_ID } from "@/lib/mock/seed/session";
import { ADMIN_CHANNEL_BEAUTY, ADMIN_CHANNEL_TECH } from "@/lib/mock/seed/workspace";
import { onTestCleanup } from "@/test/cleanup";
import { setupApp, type SetupOptions, type TestApp } from "@/test/app";
import { uploadsFor, useOpenNewVideo } from "./env";
import { CANCEL_CONFIRM_BYTES, MAX_PARALLEL } from "./uploadStore";
import { UploadsHost } from "./UploadsHost";

const GB = 1024 ** 3;

function Page() {
  const onNewVideo = useOpenNewVideo();
  return (
    <NewVideoProvider onNewVideo={onNewVideo}>
      <LibraryToolbar />
      <VideoList />
      <UploadsHost />
    </NewVideoProvider>
  );
}

function fileOf(name: string, size = 1000): File {
  const file = new File(["x"], name, { type: "video/mp4" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

/** The page on a mock; `wrap` can replace parts of the backend (a failing upload, say). */
async function openPage(
  scenarios: Parameters<typeof setupApp>[0] = ["default"],
  options: SetupOptions & { wrap?: (backend: MockBackend) => Api } = {},
) {
  const { wrap, ...setup } = options;
  const app = await setupApp(scenarios, setup);
  const api = wrap ? wrap(app.backend) : app.backend;
  const view = render(
    <TooltipProvider>
      <AppEnvContext value={{ api, store: app.store }}>
        <Page />
      </AppEnvContext>
    </TooltipProvider>,
  );
  const controller = uploadsFor(api, app.store);
  return { app, view, controller, api };
}

const user = () => userEvent.setup({ applyAccept: false });
const tick = (app: TestApp, times = 1) => act(() => app.tick(times));
const area = () => screen.getByRole("dialog", { name: "Upload files" });
const rowIn = (name: string) => {
  const found = document.querySelector<HTMLElement>(`[data-upload-row="${name}"]`);
  if (!found) throw new Error(`no upload row for ${name}`);
  return found;
};

async function chooseFiles(folder: "A-roll" | "B-roll", ...files: File[]) {
  await user().upload(within(area()).getByLabelText(`${folder} files`), files);
}

async function openAreaFromMenu(name: string) {
  await user().click(await screen.findByRole("button", { name: `More for ${name}` }));
  await user().click(await screen.findByRole("menuitem", { name: "Upload" }));
  return screen.findByRole("dialog", { name: "Upload files" });
}

afterEach(() => {
  window.localStorage.clear();
});

describe("New Video: the name", () => {
  it("asks for a name in the selected channel and refuses the obvious mistakes before sending", async () => {
    const { app } = await openPage();
    app.store.getState().selectChannel(ADMIN_CHANNEL_BEAUTY);
    const before = app.backend.world.videos.length;
    await user().click(await screen.findByRole("button", { name: "New Video" }));
    const dialog = await screen.findByRole("dialog", { name: "New Video" });
    expect(within(dialog).getByText(/In the channel/)).toHaveTextContent("Beauty");
    // The channel is chosen already: no channel field.
    expect(within(dialog).queryByText("Channel")).toBeNull();
    const name = within(dialog).getByLabelText("Name");
    expect(name).toHaveFocus();

    await user().click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("Give the video a name.")).toBeInTheDocument();
    expect(name).toHaveFocus();

    await user().type(name, "a/b");
    await user().click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("A name cannot contain a slash.")).toBeInTheDocument();
    expect(app.backend.world.videos).toHaveLength(before);
  });

  it("shows the server's refusal and stays on the name", async () => {
    const { app } = await openPage();
    app.store.getState().selectChannel(ADMIN_CHANNEL_BEAUTY);
    await user().click(await screen.findByRole("button", { name: "New Video" }));
    const dialog = await screen.findByRole("dialog", { name: "New Video" });
    await user().type(within(dialog).getByLabelText("Name"), "Hair Oil Review{Enter}");
    expect(
      await within(dialog).findByText("A video with this name already exists in this channel."),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "New Video" })).toBeInTheDocument();
    // Typing again clears the sentence.
    await user().type(within(dialog).getByLabelText("Name"), " 2");
    expect(within(dialog).queryByText(/already exists/)).toBeNull();
  });

  it("makes the folder and turns into the upload area of the new video", async () => {
    const { app } = await openPage();
    app.store.getState().selectChannel(ADMIN_CHANNEL_BEAUTY);
    await user().click(await screen.findByRole("button", { name: "New Video" }));
    const dialog = await screen.findByRole("dialog", { name: "New Video" });
    await user().type(within(dialog).getByLabelText("Name"), "  Eye Cream Test {Enter}");
    const files = await screen.findByRole("dialog", { name: "Upload files" });
    expect(files).toHaveTextContent("Eye Cream Test was created in Beauty");
    expect(within(files).getByRole("heading", { name: "A-roll" })).toBeInTheDocument();
    expect(within(files).getByRole("heading", { name: "B-roll" })).toBeInTheDocument();
    expect(files).toHaveTextContent("up to 50 GB each");
    expect(app.backend.world.videos.map((v) => v.folderName)).toContain("Eye Cream Test");
    expect(screen.queryByRole("dialog", { name: "New Video" })).toBeNull();
  });

  it("asks for the channel under All Channels and offers only reachable ones", async () => {
    const { app } = await openPage(["default"], {
      prepare: (backend) => {
        const first = backend.world.channels.find((c) => c.id === ADMIN_CHANNEL_BEAUTY);
        if (first) first.available = false;
      },
    });
    app.store.getState().selectChannel(null);
    await user().click(await screen.findByRole("button", { name: "New Video" }));
    const dialog = await screen.findByRole("dialog", { name: "New Video" });
    expect(within(dialog).getByRole("combobox", { name: "Channel" })).toHaveTextContent("Tech");
    await user().type(within(dialog).getByLabelText("Name"), "Gadget Test{Enter}");
    await screen.findByRole("dialog", { name: "Upload files" });
    const made = app.backend.world.videos.find((v) => v.folderName === "Gadget Test");
    expect(made?.channelId).toBe(ADMIN_CHANNEL_TECH);
  });

  it("says so when no channel can take a video", async () => {
    const { app } = await openPage(["default"], {
      prepare: (backend) => {
        for (const channel of backend.world.channels) channel.available = false;
      },
    });
    app.store.getState().selectChannel(null);
    // An unreachable channel lists no videos, so the empty list offers New Video too; the first
    // one is the toolbar's.
    const [toolbarButton] = await screen.findAllByRole("button", { name: "New Video" });
    await user().click(toolbarButton as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "New Video" });
    expect(within(dialog).getByText("There is no channel to put it in")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("closes with Cancel without making anything", async () => {
    const { app } = await openPage();
    app.store.getState().selectChannel(ADMIN_CHANNEL_BEAUTY);
    const before = app.backend.world.videos.length;
    await user().click(await screen.findByRole("button", { name: "New Video" }));
    await user().click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(app.backend.world.videos).toHaveLength(before);
  });
});

describe("the upload area and its rows", () => {
  it("sends a chosen file with progress, speed and time left, and finishes it", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles("A-roll", fileOf("clip.mp4", 1000));
    const row = await waitFor(() => {
      const found = rowIn("clip.mp4");
      expect(found).toHaveAttribute("data-phase", "sending");
      return found;
    });
    expect(row).toHaveTextContent("A-roll");
    expect(within(row).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");

    await tick(app);
    expect(row).toHaveTextContent("20%");
    expect(row).toHaveTextContent("200 B of 1000 B");
    expect(within(row).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "20");
    await tick(app, 4);
    await waitFor(() => {
      expect(row).toHaveAttribute("data-phase", "done");
    });
    expect(row).toHaveTextContent("Uploaded - 1000 B");
    expect(app.backend.world.uploads.find((u) => u.name === "clip.mp4")?.done).toBe(true);
    // The library row stops saying Uploading.
    await waitFor(() => {
      expect(app.video("Night Cream").uploading).toBe(false);
    });
    await user().click(within(area()).getByRole("button", { name: "Clear finished" }));
    expect(document.querySelector('[data-upload-row="clip.mp4"]')).toBeNull();
  });

  it("shows speed and time left once the server reports a speed", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles("A-roll", fileOf("speedy.mp4", 1_000_000));
    await waitFor(() => {
      expect(rowIn("speedy.mp4")).toHaveAttribute("data-phase", "sending");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick(app);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick(app);
    expect(rowIn("speedy.mp4").textContent).toMatch(/\/s - .+ left/);
  });

  it("puts a file dropped on the B-roll box into the B-roll folder", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    const zone = document.querySelector<HTMLElement>('[data-dropzone="broll"]');
    if (!zone) throw new Error("no B-roll zone");
    const file = fileOf("closeup.mp4");
    fireEvent.dragOver(zone, { dataTransfer: { files: [file], items: [] } });
    fireEvent.drop(zone, { dataTransfer: { files: [file], items: [] } });
    await screen.findByText("closeup.mp4");
    expect(app.backend.world.uploads.find((u) => u.name === "closeup.mp4")?.folder).toBe("broll");
    expect(rowIn("closeup.mp4")).toHaveTextContent("B-roll");
  });

  it("pauses, resumes from what the server has, and finishes", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles("A-roll", fileOf("clip.mp4", 1000));
    await waitFor(() => {
      expect(rowIn("clip.mp4")).toHaveAttribute("data-phase", "sending");
    });
    await tick(app, 2);
    await user().click(within(rowIn("clip.mp4")).getByRole("button", { name: "Pause clip.mp4" }));
    await waitFor(() => {
      expect(rowIn("clip.mp4")).toHaveAttribute("data-phase", "paused");
    });
    expect(rowIn("clip.mp4")).toHaveTextContent("Paused at 40%");
    await tick(app, 3);
    expect(rowIn("clip.mp4")).toHaveTextContent("Paused at 40%");

    await user().click(within(rowIn("clip.mp4")).getByRole("button", { name: "Resume clip.mp4" }));
    await tick(app, 3);
    await waitFor(() => {
      expect(rowIn("clip.mp4")).toHaveAttribute("data-phase", "done");
    });
  });

  it("cancels a small upload at once and gives the name back", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles("A-roll", fileOf("clip.mp4", 1000));
    await waitFor(() => {
      expect(rowIn("clip.mp4")).toHaveAttribute("data-phase", "sending");
    });
    await tick(app);
    await user().click(within(rowIn("clip.mp4")).getByRole("button", { name: "Cancel clip.mp4" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => {
      expect(document.querySelector('[data-upload-row="clip.mp4"]')).toBeNull();
    });
    await waitFor(() => {
      expect(app.backend.world.uploads.some((u) => u.name === "clip.mp4")).toBe(false);
    });
  });

  it("asks before cancelling an upload that has sent more than a little", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    const size = CANCEL_CONFIRM_BYTES * 10;
    await chooseFiles("A-roll", fileOf("big.mp4", size));
    await waitFor(() => {
      expect(rowIn("big.mp4")).toHaveAttribute("data-phase", "sending");
    });
    await tick(app);
    await user().click(within(rowIn("big.mp4")).getByRole("button", { name: "Cancel big.mp4" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Cancel this upload?" });
    expect(confirm).toHaveTextContent("big.mp4 is 20% uploaded");
    await user().click(within(confirm).getByRole("button", { name: "Keep uploading" }));
    expect(rowIn("big.mp4")).toBeInTheDocument();
    expect(app.backend.world.uploads.some((u) => u.name === "big.mp4")).toBe(true);

    await user().click(within(rowIn("big.mp4")).getByRole("button", { name: "Cancel big.mp4" }));
    await user().click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel upload" }),
    );
    await waitFor(() => {
      expect(app.backend.world.uploads.some((u) => u.name === "big.mp4")).toBe(false);
    });
    expect(document.querySelector('[data-upload-row="big.mp4"]')).toBeNull();
  });

  it("refuses a file that is too large at once, with the server's sentence", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles("A-roll", fileOf("huge.mp4", 51 * GB));
    const row = await waitFor(() => {
      const found = rowIn("huge.mp4");
      expect(found).toHaveAttribute("data-phase", "failed");
      return found;
    });
    expect(row).toHaveTextContent("A file can be at most 50 GB.");
    expect(within(row).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(app.backend.world.uploads.some((u) => u.name === "huge.mp4")).toBe(false);
    await user().click(within(row).getByRole("button", { name: "Remove huge.mp4 from the list" }));
    expect(document.querySelector('[data-upload-row="huge.mp4"]')).toBeNull();
  });

  it("shows a name that exists in the folder as the server says it, without retry", async () => {
    await openPage();
    await openAreaFromMenu("Hair Oil Review");
    await chooseFiles("A-roll", fileOf("hair-oil-main.mp4"));
    const row = await waitFor(() => {
      const found = rowIn("hair-oil-main.mp4");
      expect(found).toHaveAttribute("data-phase", "failed");
      return found;
    });
    expect(row).toHaveTextContent("A file with this name already exists in this folder.");
    expect(within(row).queryByRole("button", { name: "Try again" })).toBeNull();
    // The same name in the B-roll folder is free.
    await chooseFiles("B-roll", fileOf("hair-oil-main.mp4"));
    await waitFor(() => {
      expect(document.querySelectorAll('[data-upload-row="hair-oil-main.mp4"]')).toHaveLength(2);
    });
  });

  it("shows the server's sentence for a kind of file it does not take", async () => {
    await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles("A-roll", fileOf("tool.exe"));
    const row = await waitFor(() => rowIn("tool.exe"));
    await waitFor(() => {
      expect(row).toHaveTextContent("This kind of file cannot be uploaded.");
    });
  });

  it("fails with a sentence and Try again continues the same upload", async () => {
    let failures = 1;
    const { app } = await openPage(["default"], {
      wrap: (backend) =>
        Object.create(backend, {
          uploads: {
            value: {
              state: (id: string) => backend.uploads.state(id),
              send: (...args: Parameters<typeof backend.uploads.send>) => {
                if (failures > 0) {
                  failures -= 1;
                  return Promise.reject(
                    new ApiError("io", "The connection to the server was lost."),
                  );
                }
                return backend.uploads.send(...args);
              },
            },
          },
        }) as Api,
    });
    await openAreaFromMenu("Night Cream");
    await chooseFiles("A-roll", fileOf("clip.mp4", 1000));
    const row = await waitFor(() => {
      const found = rowIn("clip.mp4");
      expect(found).toHaveAttribute("data-phase", "failed");
      return found;
    });
    expect(row).toHaveTextContent("The connection to the server was lost.");
    expect(within(row).getByRole("alert")).toBeInTheDocument();
    await user().click(within(row).getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(rowIn("clip.mp4")).toHaveAttribute("data-phase", "sending");
    });
    await tick(app, 5);
    await waitFor(() => {
      expect(rowIn("clip.mp4")).toHaveAttribute("data-phase", "done");
    });
  });

  it("sends at most MAX_PARALLEL files at a time and starts the next when one is done", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    expect(MAX_PARALLEL).toBe(3);
    await chooseFiles(
      "A-roll",
      ...["a", "b", "c", "d", "e"].map((letter) => fileOf(`${letter}.mp4`, 1000)),
    );
    await waitFor(() => {
      expect(document.querySelectorAll('[data-phase="sending"]')).toHaveLength(3);
    });
    expect(document.querySelectorAll('[data-phase="waiting"]')).toHaveLength(2);
    expect(rowIn("d.mp4")).toHaveTextContent("Waiting for a free place");

    await tick(app, 5);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-phase="done"]')).toHaveLength(3);
    });
    await waitFor(() => {
      expect(document.querySelectorAll('[data-phase="sending"]')).toHaveLength(2);
    });
    await tick(app, 5);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-phase="done"]')).toHaveLength(5);
    });
  });

  it("pausing a waiting file frees nothing but resuming it queues it again", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles("A-roll", ...["a", "b", "c", "d"].map((n) => fileOf(`${n}.mp4`, 1000)));
    await waitFor(() => {
      expect(rowIn("d.mp4")).toHaveAttribute("data-phase", "waiting");
    });
    await user().click(within(rowIn("a.mp4")).getByRole("button", { name: "Pause a.mp4" }));
    // The place of a.mp4 goes to d.mp4.
    await waitFor(() => {
      expect(rowIn("d.mp4")).toHaveAttribute("data-phase", "sending");
    });
    await user().click(within(rowIn("a.mp4")).getByRole("button", { name: "Resume a.mp4" }));
    expect(rowIn("a.mp4")).toHaveAttribute("data-phase", "waiting");
    await tick(app, 5);
    await waitFor(() => {
      expect(rowIn("a.mp4")).toHaveAttribute("data-phase", "sending");
    });
  });
});

describe("uploads outlive the dialog and the page", () => {
  it("goes on after the dialog is closed, and the row says how far it is", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles("A-roll", fileOf("one.mp4", 1000), fileOf("two.mp4", 1000));
    await waitFor(() => {
      expect(document.querySelectorAll('[data-phase="sending"]')).toHaveLength(2);
    });
    await user().click(within(area()).getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await tick(app, 2);
    const slot = await waitFor(() => {
      const found = document.querySelector("[data-upload-summary]");
      if (!found) throw new Error("no summary in the row");
      return found;
    });
    expect(slot).toHaveTextContent("Uploading 2 files, 40%");

    // Reopen from the row's menu: the same rows, further along.
    await openAreaFromMenu("Night Cream");
    expect(rowIn("one.mp4")).toHaveTextContent("40%");
    await tick(app, 3);
    await waitFor(() => {
      expect(rowIn("one.mp4")).toHaveAttribute("data-phase", "done");
    });
    await waitFor(() => {
      expect(document.querySelector("[data-upload-summary]")).toBeNull();
    });
  });

  it("keeps uploading when the user goes to another channel", async () => {
    const { app, controller } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles("A-roll", fileOf("one.mp4", 1000));
    await waitFor(() => {
      expect(rowIn("one.mp4")).toHaveAttribute("data-phase", "sending");
    });
    await user().click(within(area()).getByRole("button", { name: "Done" }));
    act(() => {
      app.store.getState().selectChannel(ADMIN_CHANNEL_TECH);
    });
    await tick(app, 5);
    await waitFor(() => {
      expect(controller.state.getState().items[0]?.phase).toBe("done");
    });
  });

  it("asks before the page is left while bytes move, and not otherwise", async () => {
    const { app, controller } = await openPage();
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);
    await openAreaFromMenu("Night Cream");
    await chooseFiles("A-roll", fileOf("clip.mp4", 1000));
    await waitFor(() => {
      expect(rowIn("clip.mp4")).toHaveAttribute("data-phase", "sending");
    });
    expect(leave()).toBe(true);
    // A paused upload is not moving.
    await user().click(within(rowIn("clip.mp4")).getByRole("button", { name: "Pause clip.mp4" }));
    await waitFor(() => {
      expect(controller.hasRunning()).toBe(false);
    });
    expect(leave()).toBe(false);
    await user().click(within(rowIn("clip.mp4")).getByRole("button", { name: "Resume clip.mp4" }));
    expect(leave()).toBe(true);
    await tick(app, 5);
    await waitFor(() => {
      expect(leave()).toBe(false);
    });
  });

  it("lists an unfinished upload after a reload and continues it with the same file", async () => {
    // The first page load: an upload gets its ticket and is saved.
    const first = await openPage(["uploading"]);
    const pending = first.app.backend.world.uploads.find((u) => !u.done);
    if (!pending) throw new Error("no unfinished upload");
    window.localStorage.setItem(
      `vidai.uploads.${ADMIN_ID}`,
      JSON.stringify([
        {
          ticket: { id: pending.id, name: pending.name, size: pending.size, maxChunkBytes: 1 },
          videoId: pending.videoId,
          folder: pending.folder,
        },
        // A ticket the server forgot is not listed.
        {
          ticket: { id: "gone", name: "gone.mp4", size: 10, maxChunkBytes: 1 },
          videoId: pending.videoId,
          folder: "video",
        },
      ]),
    );
    first.view.unmount();

    // The reload: a new page on the same server.
    const second = await setupApp(["default"], { world: first.app.backend.world, user: null });
    await act(async () => {
      await second.store.getState().login("admin@example.com", "admin-password");
    });
    render(
      <TooltipProvider>
        <AppEnvContext value={{ api: second.backend, store: second.store }}>
          <Page />
        </AppEnvContext>
      </TooltipProvider>,
    );
    await waitFor(() => {
      expect(document.querySelector("[data-upload-summary]")).toHaveTextContent(
        "Upload paused, 1 file, 42%",
      );
    });
    await openAreaFromMenu("Night Cream");
    const row = rowIn("texture-shots.mp4");
    expect(row).toHaveAttribute("data-phase", "interrupted");
    expect(row).toHaveTextContent("choose the same file again to continue");
    expect(document.querySelector('[data-upload-row="gone.mp4"]')).toBeNull();

    // Another file is refused with a sentence; the right one continues.
    await user().upload(within(row).getByLabelText("Choose texture-shots.mp4 again"), [
      fileOf("texture-shots.mp4", 123),
    ]);
    expect(await within(row).findByText(/not the same file/)).toBeInTheDocument();
    expect(row).toHaveAttribute("data-phase", "interrupted");
    await user().upload(within(row).getByLabelText("Choose texture-shots.mp4 again"), [
      fileOf("texture-shots.mp4", pending.size),
    ]);
    await waitFor(() => {
      expect(row).toHaveAttribute("data-phase", "sending");
    });
    await tick(second, 5);
    await waitFor(() => {
      expect(row).toHaveAttribute("data-phase", "done");
    });
    expect(window.localStorage.getItem(`vidai.uploads.${ADMIN_ID}`)).toBeNull();
  });

  it("keeps the tickets of unfinished uploads in the browser, per user, and drops finished ones", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles("A-roll", fileOf("clip.mp4", 1000));
    await waitFor(() => {
      expect(rowIn("clip.mp4")).toHaveAttribute("data-phase", "sending");
    });
    const saved = JSON.parse(window.localStorage.getItem(`vidai.uploads.${ADMIN_ID}`) ?? "[]") as {
      ticket: { name: string };
    }[];
    expect(saved.map((s) => s.ticket.name)).toEqual(["clip.mp4"]);
    await tick(app, 5);
    await waitFor(() => {
      expect(window.localStorage.getItem(`vidai.uploads.${ADMIN_ID}`)).toBeNull();
    });
  });

  it("forgets everything when another user is signed in", async () => {
    const { app, controller } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles("A-roll", fileOf("clip.mp4", 1000));
    await waitFor(() => {
      expect(rowIn("clip.mp4")).toHaveAttribute("data-phase", "sending");
    });
    await act(async () => {
      await controller.setUser("someone-else");
    });
    expect(controller.state.getState().items).toEqual([]);
    expect(app.backend.world.uploads.find((u) => u.name === "clip.mp4")?.received).toBeLessThan(
      1000,
    );
  });
});

describe("the row", () => {
  it("says the upload is not finished when this tab does not know the files", async () => {
    await openPage(["uploading"]);
    const slot = await waitFor(() => {
      const found = document.querySelector("[data-upload-summary]");
      if (!found) throw new Error("no summary");
      return found;
    });
    expect(slot).toHaveTextContent("Upload not finished");
  });

  it("says nothing for a video that is not uploading", async () => {
    await openPage();
    await screen.findByText("Night Cream");
    expect(document.querySelector("[data-upload-summary]")).toBeNull();
  });

  it("opens Upload files from the row's Upload entry", async () => {
    await openPage();
    const dialog = await openAreaFromMenu("Night Cream");
    expect(dialog).toHaveTextContent("Night Cream");
    expect(dialog).not.toHaveTextContent("was created");
    await user().click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("the jobs controller's uploadFor opens the same dialog", async () => {
    const { app, api } = await openPage();
    const video = app.video("Night Cream");
    act(() => {
      jobsControllerFor(api, app.store).runJobAction(video, "upload");
    });
    expect(await screen.findByRole("dialog", { name: "Upload files" })).toBeInTheDocument();
  });
});

onTestCleanup(() => {
  window.localStorage.clear();
});

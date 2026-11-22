import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { jobsControllerFor } from "@/features/jobs";
import { LibrarySidebar, VideoList } from "@/features/library";
import type { Api } from "@/lib/api";
import { AppEnvContext } from "@/lib/appEnv";
import { ApiError } from "@/lib/errors";
import { formatBytes, formatLocalDateTime } from "@/lib/format";
import type { MockBackend } from "@/lib/mock";
import { ADMIN_ID } from "@/lib/mock/seed/session";
import { ADMIN_CHANNEL_TECH } from "@/lib/mock/seed/workspace";
import { onTestCleanup } from "@/test/cleanup";
import { setupApp, type SetupOptions, type TestApp } from "@/test/app";
import { uploadsFor } from "./env";
import { CANCEL_CONFIRM_BYTES, MAX_PARALLEL } from "./uploadStore";
import { UploadsHost } from "./UploadsHost";

const GB = 1024 ** 3;

function Page() {
  return (
    <>
      <LibrarySidebar />
      <VideoList />
      <UploadsHost />
    </>
  );
}

/** Any kind of file: the content does not matter, the size is the one given. */
function fileOf(name: string, size = 1000, type = "video/mp4"): File {
  const file = new File(["x"], name, { type });
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
const area = () => screen.getByRole("dialog", { name: "Upload Files" });
const rowIn = (name: string) => {
  const found = document.querySelector<HTMLElement>(`[data-upload-row="${name}"]`);
  if (!found) throw new Error(`no upload row for ${name}`);
  return found;
};
const hasRow = (name: string) => document.querySelector(`[data-upload-row="${name}"]`) !== null;
const fileRowIn = (name: string) => {
  const found = document.querySelector<HTMLElement>(`[data-uploaded-file="${name}"]`);
  if (!found) throw new Error(`no file named ${name} in the folder list`);
  return found;
};
/** The names in "Files in the folder", in order. */
const listed = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-uploaded-file]")).map(
    (item) => item.dataset.uploadedFile ?? "",
  );
/** The file is in the folder list and no longer in the uploads list. */
const arrived = async (name: string) => {
  await waitFor(() => {
    expect(listed()).toContain(name);
    expect(hasRow(name)).toBe(false);
  });
};

async function chooseFiles(...files: File[]) {
  await user().upload(within(area()).getByLabelText("Files to upload"), files);
}

async function openAreaFromMenu(name: string) {
  await user().click(await screen.findByRole("button", { name: `More for ${name}` }));
  await user().click(await screen.findByRole("menuitem", { name: "Upload Files" }));
  return screen.findByRole("dialog", { name: "Upload Files" });
}

async function openChannelDialog(name: string) {
  const nav = within(await screen.findByRole("navigation", { name: "Channels" }));
  await user().click(await nav.findByRole("button", { name: `More for ${name}` }));
  await user().click(await screen.findByRole("menuitem", { name: "Upload Files" }));
  return screen.findByRole("dialog", { name: "Upload Files" });
}

afterEach(() => {
  window.localStorage.clear();
});

describe("the Upload Files dialog", () => {
  it("names the video's upload folder, hints at the prompt, and lists the files in it", async () => {
    const { app } = await openPage();
    const dialog = await openAreaFromMenu("Hair Oil Review");
    const seeded = app.backend.world.uploads.find((u) => u.name === "logo.png");
    expect(within(dialog).getByRole("heading", { name: "Upload Files" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("The upload folder of Hair Oil Review");
    expect(dialog).toHaveTextContent(
      'A prompt can name these files, for example "upload/logo.png".',
    );
    expect(dialog).toHaveTextContent("Any kind of file, up to 50 GB each");
    // The three seeded files, with their sizes and dates.
    const names = await waitFor(() => {
      const found = listed();
      expect(found).toHaveLength(3);
      return found;
    });
    expect(names).toEqual(["background-music.mp3", "logo.png", "script.pdf"]);
    const logo = fileRowIn("logo.png");
    expect(logo).toHaveTextContent(formatBytes(84_000));
    expect(logo).toHaveTextContent(formatLocalDateTime(seeded?.modifiedAt ?? 0));
    // Another video's folder is not shown.
    expect(dialog).not.toHaveTextContent("product-shots.zip");
  });

  it("says when the folder is empty", async () => {
    await openPage();
    const dialog = await openAreaFromMenu("Foundation Test");
    expect(await within(dialog).findByText("No files in this folder yet.")).toBeInTheDocument();
  });

  it("opens from a channel's menu in the sidebar and names the channel's upload folder", async () => {
    await openPage();
    const dialog = await openChannelDialog("Beauty Channel");
    expect(dialog).toHaveTextContent("The upload folder of Beauty Channel");
    await waitFor(() => {
      expect(listed()).toEqual(["brand-kit.zip", "intro-jingle.wav"]);
    });
  });

  it("offers Upload Files on the channel row of a user, for the user's own channel only", async () => {
    await openPage(["two-users"], { user: "user" });
    const dialog = await openChannelDialog("Travel Diary");
    await waitFor(() => {
      expect(listed()).toEqual(["map.png"]);
    });
    expect(dialog).not.toHaveTextContent("brand-kit.zip");
  });

  it("closes with Done", async () => {
    await openPage();
    const dialog = await openAreaFromMenu("Night Cream");
    await user().click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("has no New Video or New Channel anywhere on the page", async () => {
    await openPage();
    await screen.findByText("Night Cream");
    expect(screen.queryByRole("button", { name: /New Video/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /New Channel/i })).toBeNull();
  });
});

describe("sending files", () => {
  it("sends a chosen file with progress, then lists it in the folder", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    await waitFor(() => {
      expect(listed()).toEqual(["product-shots.zip"]);
    });
    await chooseFiles(fileOf("clip.mp4", 1000));
    const row = await waitFor(() => {
      const found = rowIn("clip.mp4");
      expect(found).toHaveAttribute("data-phase", "sending");
      return found;
    });
    expect(within(row).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");

    await tick(app);
    expect(row).toHaveTextContent("20%");
    expect(row).toHaveTextContent("200 B of 1000 B");
    expect(within(row).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "20");
    await tick(app, 4);
    // The folder list is read again after the upload: the file moves from the uploads to the list.
    await arrived("clip.mp4");
    expect(listed()).toEqual(["clip.mp4", "product-shots.zip"]);
    expect(app.backend.world.uploads.find((u) => u.name === "clip.mp4")).toMatchObject({
      done: true,
      videoId: app.video("Night Cream").id,
    });
    // The library row stops saying Uploading.
    await waitFor(() => {
      expect(app.video("Night Cream").uploading).toBe(false);
    });
  });

  it("takes any kind of file, whatever its type", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles(
      fileOf("logo.png", 100, "image/png"),
      fileOf("tool.exe", 100, "application/x-msdownload"),
      fileOf("notes", 100, ""),
    );
    await tick(app, 5);
    for (const name of ["logo.png", "tool.exe", "notes"]) await arrived(name);
    expect(app.backend.world.uploads.filter((u) => u.done && u.name === "tool.exe")).toHaveLength(
      1,
    );
  });

  it("sends a file into the channel's upload folder, not into a video's", async () => {
    const { app } = await openPage();
    await openChannelDialog("Beauty Channel");
    await chooseFiles(fileOf("banner.png", 1000, "image/png"));
    await waitFor(() => {
      expect(rowIn("banner.png")).toHaveAttribute("data-phase", "sending");
    });
    await tick(app, 5);
    await arrived("banner.png");
    expect(listed()).toEqual(["banner.png", "brand-kit.zip", "intro-jingle.wav"]);
    expect(app.backend.world.uploads.find((u) => u.name === "banner.png")).toMatchObject({
      videoId: null,
      done: true,
    });
  });

  it("puts a file dropped on the box into the folder of the dialog", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    const zone = document.querySelector<HTMLElement>("[data-dropzone]");
    if (!zone) throw new Error("no drop zone");
    const file = fileOf("closeup.mp4");
    fireEvent.dragOver(zone, { dataTransfer: { files: [file], items: [] } });
    fireEvent.drop(zone, { dataTransfer: { files: [file], items: [] } });
    await screen.findByText("closeup.mp4");
    expect(app.backend.world.uploads.find((u) => u.name === "closeup.mp4")).toMatchObject({
      videoId: app.video("Night Cream").id,
    });
  });

  it("shows speed and time left once the server reports a speed", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles(fileOf("speedy.mp4", 1_000_000));
    await waitFor(() => {
      expect(rowIn("speedy.mp4")).toHaveAttribute("data-phase", "sending");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick(app);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await tick(app);
    expect(rowIn("speedy.mp4").textContent).toMatch(/\/s - .+ left/);
  });

  it("pauses, resumes from what the server has, and finishes", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles(fileOf("clip.mp4", 1000));
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
    await arrived("clip.mp4");
  });

  it("cancels a small upload at once and gives the name back", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles(fileOf("clip.mp4", 1000));
    await waitFor(() => {
      expect(rowIn("clip.mp4")).toHaveAttribute("data-phase", "sending");
    });
    await tick(app);
    await user().click(within(rowIn("clip.mp4")).getByRole("button", { name: "Cancel clip.mp4" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => {
      expect(hasRow("clip.mp4")).toBe(false);
    });
    await waitFor(() => {
      expect(app.backend.world.uploads.some((u) => u.name === "clip.mp4")).toBe(false);
    });
    expect(listed()).not.toContain("clip.mp4");
  });

  it("asks before cancelling an upload that has sent more than a little", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    const size = CANCEL_CONFIRM_BYTES * 10;
    await chooseFiles(fileOf("big.mp4", size));
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
    expect(hasRow("big.mp4")).toBe(false);
  });

  it("refuses a file that is too large at once, with the server's sentence", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles(fileOf("huge.mp4", 51 * GB));
    const row = await waitFor(() => {
      const found = rowIn("huge.mp4");
      expect(found).toHaveAttribute("data-phase", "failed");
      return found;
    });
    expect(row).toHaveTextContent("A file can be at most 50 GB.");
    expect(within(row).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(app.backend.world.uploads.some((u) => u.name === "huge.mp4")).toBe(false);
    await user().click(within(row).getByRole("button", { name: "Remove huge.mp4 from the list" }));
    expect(hasRow("huge.mp4")).toBe(false);
  });

  it("shows a name that exists in the folder as the server says it, without retry", async () => {
    await openPage();
    await openAreaFromMenu("Hair Oil Review");
    await chooseFiles(fileOf("logo.png", 1000, "image/png"));
    const row = await waitFor(() => {
      const found = rowIn("logo.png");
      expect(found).toHaveAttribute("data-phase", "failed");
      return found;
    });
    expect(row).toHaveTextContent("A file with this name already exists in this folder.");
    expect(within(row).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("allows the same name in the channel's folder as in a video's folder", async () => {
    const { app } = await openPage();
    const video = await openAreaFromMenu("Hair Oil Review");
    await waitFor(() => {
      expect(listed()).toContain("logo.png");
    });
    await user().click(within(video).getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await openChannelDialog("Beauty Channel");
    await chooseFiles(fileOf("logo.png", 1000, "image/png"));
    await tick(app, 5);
    await arrived("logo.png");
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
    await chooseFiles(fileOf("clip.mp4", 1000));
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
    await arrived("clip.mp4");
  });

  it("sends at most MAX_PARALLEL files at a time and starts the next when one is done", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    expect(MAX_PARALLEL).toBe(3);
    const names = ["a", "b", "c", "d", "e"].map((letter) => `${letter}.mp4`);
    await chooseFiles(...names.map((name) => fileOf(name, 1000)));
    await waitFor(() => {
      expect(document.querySelectorAll('[data-phase="sending"]')).toHaveLength(3);
    });
    expect(document.querySelectorAll('[data-phase="waiting"]')).toHaveLength(2);
    expect(rowIn("d.mp4")).toHaveTextContent("Waiting for a free place");

    await tick(app, 5);
    await waitFor(() => {
      expect(listed().filter((name) => names.includes(name))).toEqual(["a.mp4", "b.mp4", "c.mp4"]);
    });
    await waitFor(() => {
      expect(document.querySelectorAll('[data-phase="sending"]')).toHaveLength(2);
    });
    await tick(app, 5);
    for (const name of names) await arrived(name);
  });

  it("pausing a waiting file frees its place, and resuming it queues it again", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles(...["a", "b", "c", "d"].map((n) => fileOf(`${n}.mp4`, 1000)));
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
    await chooseFiles(fileOf("one.mp4", 1000), fileOf("two.mp4", 1000));
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
    await arrived("one.mp4");
    await arrived("two.mp4");
    await waitFor(() => {
      expect(document.querySelector("[data-upload-summary]")).toBeNull();
    });
  });

  it("keeps uploading when the user goes to another channel", async () => {
    const { app, controller } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles(fileOf("one.mp4", 1000));
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
    await chooseFiles(fileOf("clip.mp4", 1000));
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
    if (!pending?.videoId) throw new Error("no unfinished upload");
    const target = { kind: "video", videoId: pending.videoId };
    window.localStorage.setItem(
      `vidai.uploads.${ADMIN_ID}`,
      JSON.stringify([
        {
          ticket: { id: pending.id, name: pending.name, size: pending.size, maxChunkBytes: 1 },
          target,
        },
        // A ticket the server forgot is not listed.
        { ticket: { id: "gone", name: "gone.mp4", size: 10, maxChunkBytes: 1 }, target },
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
    expect(hasRow("gone.mp4")).toBe(false);

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
    await arrived("texture-shots.mp4");
    expect(window.localStorage.getItem(`vidai.uploads.${ADMIN_ID}`)).toBeNull();
  });

  it("keeps the tickets of unfinished uploads in the browser, per user, and drops finished ones", async () => {
    const { app } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles(fileOf("clip.mp4", 1000));
    await waitFor(() => {
      expect(rowIn("clip.mp4")).toHaveAttribute("data-phase", "sending");
    });
    const saved = JSON.parse(window.localStorage.getItem(`vidai.uploads.${ADMIN_ID}`) ?? "[]") as {
      ticket: { name: string };
      target: { kind: string };
    }[];
    expect(saved.map((s) => s.ticket.name)).toEqual(["clip.mp4"]);
    expect(saved[0]?.target.kind).toBe("video");
    await tick(app, 5);
    await waitFor(() => {
      expect(window.localStorage.getItem(`vidai.uploads.${ADMIN_ID}`)).toBeNull();
    });
  });

  it("forgets everything when another user is signed in", async () => {
    const { app, controller } = await openPage();
    await openAreaFromMenu("Night Cream");
    await chooseFiles(fileOf("clip.mp4", 1000));
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

  it("the jobs controller's uploadFor opens the same dialog", async () => {
    const { app, api } = await openPage();
    const video = app.video("Night Cream");
    act(() => {
      jobsControllerFor(api, app.store).runJobAction(video, "upload");
    });
    const dialog = await screen.findByRole("dialog", { name: "Upload Files" });
    expect(dialog).toHaveTextContent("The upload folder of Night Cream");
  });
});

onTestCleanup(() => {
  window.localStorage.clear();
});

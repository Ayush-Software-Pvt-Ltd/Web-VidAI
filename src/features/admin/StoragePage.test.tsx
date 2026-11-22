import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/errors";
import { MEDIA_ROOT } from "@/lib/mock/areas/workspace";
import { ADMIN_ID, USER_ID } from "@/lib/mock/seed/session";
import { FOOTAGE_ROOT, SHARE_ROOT, makeUnreachable } from "@/lib/mock/seed/storage";
import type { MockBackend } from "@/lib/mock";
import { renderApp } from "@/test/app";
import { StoragePage } from "./StoragePage";

async function open(options?: Parameters<typeof renderApp>[2]) {
  const app = await renderApp(<StoragePage />, ["default"], options);
  await screen.findByText("Storage folders");
  await screen.findAllByTestId("root-row");
  return app;
}

const rootRow = (path: string) => {
  const found = screen.getAllByTestId("root-row").find((r) => r.textContent.includes(path));
  if (!found) throw new Error(`No row for ${path}`);
  return found;
};

describe("StoragePage: folders", () => {
  it("lists the folders and says which one cannot be reached", async () => {
    await open({
      prepare: (backend) => {
        makeUnreachable(backend.world, SHARE_ROOT);
      },
    });
    expect(within(rootRow(FOOTAGE_ROOT)).getByText("Available")).toBeInTheDocument();
    expect(within(rootRow(SHARE_ROOT)).getByText("Cannot be reached")).toBeInTheDocument();
  });

  it("adds a folder by its typed path and shows it as available", async () => {
    const user = userEvent.setup();
    const app = await open({
      prepare: (backend) => {
        backend.world.fs.push({ path: "/srv/extra", name: "extra", videoCount: 0, children: [] });
      },
    });
    const add = screen.getByRole("button", { name: "Add Folder" });
    expect(add).toBeDisabled();
    await user.type(screen.getByLabelText("Full path of a folder to add"), "  /srv/extra/  ");
    await user.click(add);
    await waitFor(() => {
      expect(app.backend.world.adminSettings.storageRoots).toEqual([
        FOOTAGE_ROOT,
        SHARE_ROOT,
        "/srv/extra",
      ]);
    });
    await waitFor(() => {
      expect(within(rootRow("/srv/extra")).getByText("Available")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Full path of a folder to add")).toHaveValue("");
  });

  it("shows the server's refusal of a path that is not a full path and keeps the list", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.type(screen.getByLabelText("Full path of a folder to add"), "relative/folder");
    await user.click(screen.getByRole("button", { name: "Add Folder" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The folders were not changed");
    expect(alert).toHaveTextContent("is not a full folder path");
    expect(screen.getByLabelText("Full path of a folder to add")).toHaveValue("relative/folder");
    expect(app.backend.world.adminSettings.storageRoots).toEqual([FOOTAGE_ROOT, SHARE_ROOT]);
  });

  it("removes a folder and says nothing in it is deleted", async () => {
    const user = userEvent.setup();
    const app = await open();
    expect(screen.getByText(/does not move or delete anything in it/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `Remove ${FOOTAGE_ROOT}` }));
    await waitFor(() => {
      expect(app.backend.world.adminSettings.storageRoots).toEqual([SHARE_ROOT]);
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("root-row")).toHaveLength(1);
    });
  });

  it("explains the default folder when the list is empty", async () => {
    await renderApp(<StoragePage />, ["default"], {
      prepare: (backend) => {
        backend.world.adminSettings.storageRoots = [];
      },
    });
    expect(await screen.findByText(/No extra folder yet/)).toBeInTheDocument();
  });
});

/** Puts channel folders into `folder`, one per `userIds` entry (the mock keeps them as rows). */
function placeChannels(backend: MockBackend, folder: string, userIds: readonly string[]): void {
  const template = backend.world.channels[0];
  if (!template) throw new Error("The seed has no channel.");
  userIds.forEach((userId, index) => {
    backend.world.channels.push({
      ...structuredClone(template),
      id: `placed-${folder.length}-${String(index)}`.padEnd(32, "0"),
      userId,
      name: `Placed ${String(index)}`,
      dir: `${folder}/Placed ${String(index)}`,
    });
  });
}

describe("StoragePage: removing a folder that holds channels", () => {
  it("shows the server's sentence beside that folder's row and keeps the list", async () => {
    const user = userEvent.setup();
    const app = await open({
      prepare: (backend) => {
        placeChannels(backend, SHARE_ROOT, [ADMIN_ID, USER_ID, USER_ID]);
      },
    });
    const button = screen.getByRole("button", { name: `Remove ${SHARE_ROOT}` });
    await user.click(button);
    const sentence = `3 channels of 2 users are in ${SHARE_ROOT}. Move or remove them first.`;
    const note = await within(rootRow(SHARE_ROOT)).findByText(sentence);
    expect(note).toHaveAttribute("role", "alert");
    expect(button).toHaveAttribute("aria-describedby", note.id);
    // The other row says nothing, the list is as it was, and the group's own callout stays quiet.
    expect(within(rootRow(FOOTAGE_ROOT)).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("The folders were not changed")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("root-row")).toHaveLength(2);
    expect(app.backend.world.adminSettings.storageRoots).toEqual([FOOTAGE_ROOT, SHARE_ROOT]);
  });

  it("says it in the singular for one channel, and removes the folder once it is empty", async () => {
    const user = userEvent.setup();
    const app = await open({
      prepare: (backend) => {
        placeChannels(backend, SHARE_ROOT, [USER_ID]);
      },
    });
    await user.click(screen.getByRole("button", { name: `Remove ${SHARE_ROOT}` }));
    expect(
      await within(rootRow(SHARE_ROOT)).findByText(
        `1 channel of 1 user is in ${SHARE_ROOT}. Move or remove it first.`,
      ),
    ).toBeInTheDocument();

    app.backend.world.channels = app.backend.world.channels.filter(
      (channel) => !channel.dir.startsWith(`${SHARE_ROOT}/`),
    );
    await user.click(screen.getByRole("button", { name: `Remove ${SHARE_ROOT}` }));
    await waitFor(() => {
      expect(app.backend.world.adminSettings.storageRoots).toEqual([FOOTAGE_ROOT]);
    });
    expect(screen.queryByText(/Move or remove/)).not.toBeInTheDocument();
  });

  it("allows it while the channels are still inside another storage folder", async () => {
    const user = userEvent.setup();
    const app = await open({
      prepare: (backend) => {
        backend.world.adminSettings.storageRoots = [FOOTAGE_ROOT, `${FOOTAGE_ROOT}/Campaigns`];
        placeChannels(backend, `${FOOTAGE_ROOT}/Campaigns`, [USER_ID]);
      },
    });
    await user.click(screen.getByRole("button", { name: `Remove ${FOOTAGE_ROOT}/Campaigns` }));
    await waitFor(() => {
      expect(app.backend.world.adminSettings.storageRoots).toEqual([FOOTAGE_ROOT]);
    });
  });

  it("refuses through the api as a conflict without a field", async () => {
    const app = await open({
      prepare: (backend) => {
        placeChannels(backend, FOOTAGE_ROOT, [USER_ID]);
      },
    });
    const refusal = await app.backend
      .adminUpdateSettings({ storageRoots: [SHARE_ROOT] })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ApiError);
    expect(refusal).toMatchObject({ code: "conflict" });
    expect((refusal as ApiError).field).toBeUndefined();
  });

  it("has no remove control for the default storage folder, only for the listed ones", async () => {
    await open();
    expect(screen.queryByRole("button", { name: `Remove ${MEDIA_ROOT}` })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(2);
  });

  it("keeps a refusal of Add in the group's callout, not under a row", async () => {
    const user = userEvent.setup();
    await open();
    await user.type(screen.getByLabelText("Full path of a folder to add"), "relative/folder");
    await user.click(screen.getByRole("button", { name: "Add Folder" }));
    expect(await screen.findByText("The folders were not changed")).toBeInTheDocument();
    expect(within(rootRow(FOOTAGE_ROOT)).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("StoragePage: uploads and previews", () => {
  it("saves the largest upload and the preview cache together, in range", async () => {
    const user = userEvent.setup();
    const app = await open();
    const upload = screen.getByLabelText("Largest upload");
    await user.clear(upload);
    await user.type(upload, "50");
    const cache = screen.getByLabelText("Preview copies");
    await user.clear(cache);
    await user.type(cache, "3000");
    expect(await screen.findByText("Enter a whole number from 1 to 2000.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(cache);
    await user.type(cache, "120");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(app.backend.world.adminSettings).toMatchObject({ maxUploadGb: 50, proxyCacheGb: 120 });
    });
  });
});

/**
 * Admin, Channels, against the mock server's `admin-channels` scenario: the list (owner, folder,
 * videos, Unavailable and Busy), New Channel with the folder picker, Edit (owner, video type,
 * folder), a name that is taken, a busy channel that locks its owner and folder, and Remove.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Toaster } from "@/components/ui";
import {
  ANA_EMAIL,
  BEN_EMAIL,
  COOKING_DIR,
  COOKING_ID,
  GARDEN_DIR,
  GARDEN_ID,
  RETRO_DIR,
} from "@/lib/mock/seed/adminChannels";
import { addJob } from "@/lib/mock/seed/jobs";
import { HOME, SSD } from "@/lib/mock/seed/storage";
import { renderApp } from "@/test/app";
import { CHANNEL_BUSY_REASON } from "./ChannelDialog";
import { ChannelsPage } from "./ChannelsPage";

afterEach(() => {
  // A modal dialog that was still open when its test ended leaves this on <body>.
  document.body.style.pointerEvents = "";
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
});

async function open(options: Parameters<typeof renderApp>[2] = {}) {
  const app = await renderApp(
    <>
      <ChannelsPage />
      <Toaster />
    </>,
    ["default", "admin-channels"],
    options,
  );
  await screen.findByText("Cooking Basics");
  return app;
}

const row = (name: string) => {
  const found = screen
    .getAllByTestId("channel-row")
    .find((r) => within(r).queryByText(name, { selector: "span" }) !== null);
  if (!found) throw new Error(`No row for ${name}`);
  return found;
};

const channelOf = (app: Awaited<ReturnType<typeof open>>, id: string) => {
  const found = app.backend.world.channels.find((c) => c.id === id);
  if (!found) throw new Error(`No channel ${id}`);
  return found;
};

const userIdOf = (app: Awaited<ReturnType<typeof open>>, email: string) => {
  const found = app.backend.world.users.find((u) => u.email === email);
  if (!found) throw new Error(`No user ${email}`);
  return found.id;
};

/** Picks a folder in the open folder picker: opens `place`, then each name in `path`, and chooses. */
async function pickFolder(
  user: ReturnType<typeof userEvent.setup>,
  place: string,
  path: readonly string[],
) {
  const picker = await screen.findByRole("dialog", { name: "Choose the channel's folder" });
  await user.click(
    within(within(picker).getByRole("navigation", { name: "Places" })).getByRole("button", {
      name: new RegExp(`^${place}`),
    }),
  );
  for (const name of path) {
    const option = await within(picker).findByRole("option", { name: new RegExp(`^${name}`) });
    await user.dblClick(option);
    await waitFor(() => {
      expect(within(picker).getByRole("button", { name: /^Choose "/ })).toHaveTextContent(
        `Choose "${name}"`,
      );
    });
  }
  await user.click(within(picker).getByRole("button", { name: /^Choose "/ }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Choose the channel's folder" })).toBeNull();
  });
}

const editDialog = () => screen.findByRole("dialog", { name: "Edit Channel" });

describe("ChannelsPage: the list", () => {
  it("lists every user's channels with owner, folder, videos and state", async () => {
    await open();
    const cooking = row("Cooking Basics");
    expect(within(cooking).getByText(`${ANA_EMAIL} - 3 videos`)).toBeInTheDocument();
    expect(within(cooking).getByText(COOKING_DIR)).toBeInTheDocument();
    expect(within(cooking).getByText("Busy")).toBeInTheDocument();
    expect(within(cooking).queryByText("Unavailable")).not.toBeInTheDocument();

    const garden = row("Garden Weekly");
    expect(within(garden).getByText(`${ANA_EMAIL} - 1 video`)).toBeInTheDocument();
    expect(within(garden).queryByText("Busy")).not.toBeInTheDocument();

    // The admin's own channels are listed too.
    expect(row("Beauty Channel")).toBeInTheDocument();
    expect(screen.getAllByTestId("channel-row").length).toBeGreaterThanOrEqual(6);
  });

  it("marks a channel whose folder cannot be reached and does not count its videos", async () => {
    await open();
    const retro = row("Retro Games");
    expect(within(retro).getByText("Unavailable")).toBeInTheDocument();
    expect(within(retro).getByText(BEN_EMAIL)).toBeInTheDocument();
    expect(within(retro).queryByText(/video/)).not.toBeInTheDocument();
    expect(within(retro).getByText(RETRO_DIR)).toBeInTheDocument();
  });

  it("shows the whole folder path in a tooltip", async () => {
    const user = userEvent.setup();
    await open();
    const path = within(row("Cooking Basics")).getByText(COOKING_DIR).closest("[data-path]");
    if (!(path instanceof HTMLElement)) throw new Error("No folder in the row");
    await user.hover(path);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(COOKING_DIR);
  });

  it("says so when there is no channel", async () => {
    await renderApp(<ChannelsPage />, ["default"], {
      prepare: (backend) => {
        backend.world.channels = [];
        backend.world.videos = [];
      },
    });
    expect(await screen.findByText(/No channels yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Channel" })).toBeEnabled();
  });
});

describe("ChannelsPage: New Channel", () => {
  it("creates a channel for a user with a folder chosen in the picker", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: "New Channel" }));
    const dialog = await screen.findByRole("dialog", { name: "New Channel" });
    const create = within(dialog).getByRole("button", { name: "Create Channel" });
    // Nothing can be created before a name, an owner and a folder are there.
    expect(create).toBeDisabled();
    expect(within(dialog).getByText("No folder chosen yet.")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Name"), "  Chess Openings ");
    await user.click(within(dialog).getByRole("combobox", { name: "Owner" }));
    await user.click(await screen.findByRole("option", { name: ANA_EMAIL }));
    await user.click(within(dialog).getByRole("radio", { name: "Always Short" }));
    expect(create).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Choose…" }));
    await pickFolder(user, "Footage SSD", ["Spare"]);
    expect(within(dialog).getByTestId("channel-folder")).toHaveTextContent(`${SSD}/Spare`);
    expect(create).toBeEnabled();
    await user.click(create);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    const made = app.backend.world.channels.find((c) => c.name === "Chess Openings");
    expect(made).toMatchObject({
      userId: userIdOf(app, ANA_EMAIL),
      dir: `${SSD}/Spare`,
      videoType: "short",
    });
    const added = await screen.findByText("Chess Openings", { selector: "span" });
    expect(added.closest("[data-testid=channel-row]")).toHaveTextContent(ANA_EMAIL);
    expect(await screen.findByText("Channel created")).toBeInTheDocument();
  });

  it("makes a new folder in the picker and gives it to a user", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: "New Channel" }));
    const dialog = await screen.findByRole("dialog", { name: "New Channel" });
    await user.type(within(dialog).getByLabelText("Name"), "Gardening");
    await user.click(within(dialog).getByRole("combobox", { name: "Owner" }));
    await user.click(await screen.findByRole("option", { name: BEN_EMAIL }));
    await user.click(within(dialog).getByRole("button", { name: "Choose…" }));
    const picker = await screen.findByRole("dialog", { name: "Choose the channel's folder" });
    await user.click(
      within(within(picker).getByRole("navigation", { name: "Places" })).getByRole("button", {
        name: /^Footage SSD/,
      }),
    );
    await within(picker).findByRole("option", { name: /^Spare/ });
    await user.click(within(picker).getByRole("button", { name: "New Folder" }));
    const field = await within(picker).findByRole("textbox", { name: "Folder name" });
    await user.clear(field);
    await user.type(field, "Gardening{Enter}");
    await waitFor(() => {
      expect(within(picker).getByRole("button", { name: /^Choose "/ })).toHaveTextContent(
        'Choose "Gardening"',
      );
    });
    await user.click(within(picker).getByRole("button", { name: /^Choose "/ }));
    await user.click(within(dialog).getByRole("button", { name: "Create Channel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(app.backend.world.channels.find((c) => c.name === "Gardening")).toMatchObject({
      userId: userIdOf(app, BEN_EMAIL),
      dir: `${SSD}/Gardening`,
      videoType: "auto",
    });
  });

  it("shows a name the owner already has under the name and keeps the dialog", async () => {
    const user = userEvent.setup();
    const app = await open();
    const before = app.backend.world.channels.length;
    await user.click(screen.getByRole("button", { name: "New Channel" }));
    const dialog = await screen.findByRole("dialog", { name: "New Channel" });
    await user.type(within(dialog).getByLabelText("Name"), "cooking basics");
    await user.click(within(dialog).getByRole("combobox", { name: "Owner" }));
    await user.click(await screen.findByRole("option", { name: ANA_EMAIL }));
    await user.click(within(dialog).getByRole("button", { name: "Choose…" }));
    await pickFolder(user, "Footage SSD", ["Spare"]);
    await user.click(within(dialog).getByRole("button", { name: "Create Channel" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("This user already has a channel with that name.");
    expect(within(dialog).getByLabelText("Name")).toBeInvalid();
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    expect(app.backend.world.channels).toHaveLength(before);
  });

  it("shows a refused folder under the folder", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: "New Channel" }));
    const dialog = await screen.findByRole("dialog", { name: "New Channel" });
    await user.type(within(dialog).getByLabelText("Name"), "Everything");
    await user.click(within(dialog).getByRole("combobox", { name: "Owner" }));
    await user.click(await screen.findByRole("option", { name: ANA_EMAIL }));
    await user.click(within(dialog).getByRole("button", { name: "Choose…" }));
    // The home folder holds VidAI's data directory: the picker cannot know, the server refuses.
    const picker = await screen.findByRole("dialog", { name: "Choose the channel's folder" });
    await within(picker).findByRole("option", { name: /^Movies/ });
    await user.click(within(picker).getByRole("button", { name: /^Choose "vidai"/ }));
    expect(within(dialog).getByTestId("channel-folder")).toHaveTextContent(HOME);
    await user.click(within(dialog).getByRole("button", { name: "Create Channel" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("This folder belongs to VidAI's own data.");
    expect(within(dialog).getByRole("button", { name: "Choose…" })).toHaveFocus();
    expect(app.backend.world.channels.some((c) => c.name === "Everything")).toBe(false);
  });

  it("closes with Cancel and makes nothing", async () => {
    const user = userEvent.setup();
    const app = await open();
    const before = app.backend.world.channels.length;
    await user.click(screen.getByRole("button", { name: "New Channel" }));
    const dialog = await screen.findByRole("dialog", { name: "New Channel" });
    await user.type(within(dialog).getByLabelText("Name"), "Nothing");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(app.backend.world.channels).toHaveLength(before);
  });
});

describe("ChannelsPage: Edit", () => {
  it("opens with what the channel has", async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole("button", { name: "Edit Garden Weekly" }));
    const dialog = await editDialog();
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Garden Weekly");
    expect(within(dialog).getByRole("combobox", { name: "Owner" })).toHaveTextContent(ANA_EMAIL);
    expect(within(dialog).getByRole("radio", { name: "Auto-detect" })).toBeChecked();
    expect(within(dialog).getByTestId("channel-folder")).toHaveTextContent(GARDEN_DIR);
    expect(within(dialog).getByRole("combobox", { name: "Owner" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Choose…" })).toBeEnabled();
    expect(within(dialog).queryByText(CHANNEL_BUSY_REASON)).not.toBeInTheDocument();
  });

  it("gives the channel to another user and changes its video type", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: "Edit Garden Weekly" }));
    const dialog = await editDialog();
    await user.click(within(dialog).getByRole("combobox", { name: "Owner" }));
    await user.click(await screen.findByRole("option", { name: BEN_EMAIL }));
    await user.click(within(dialog).getByRole("radio", { name: "Always Long" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(channelOf(app, GARDEN_ID)).toMatchObject({
      name: "Garden Weekly",
      userId: userIdOf(app, BEN_EMAIL),
      dir: GARDEN_DIR,
      videoType: "long",
    });
    await waitFor(() => {
      expect(within(row("Garden Weekly")).getByText(/ben@example.com - 1 video/)).toBeVisible();
    });
    expect(await screen.findByText("Channel changed")).toBeInTheDocument();
  });

  it("renames a channel and moves it to another folder", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: "Edit Garden Weekly" }));
    const dialog = await editDialog();
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Garden Daily");
    await user.click(within(dialog).getByRole("button", { name: "Choose…" }));
    await pickFolder(user, "Footage SSD", ["Spare"]);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(channelOf(app, GARDEN_ID)).toMatchObject({
      name: "Garden Daily",
      userId: userIdOf(app, ANA_EMAIL),
      dir: `${SSD}/Spare`,
    });
    expect(await screen.findByText("Garden Daily", { selector: "span" })).toBeInTheDocument();
    expect(screen.queryByText("Garden Weekly", { selector: "span" })).not.toBeInTheDocument();
  });

  it("shows a name the owner already has under the name and keeps the dialog", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: "Edit Garden Weekly" }));
    const dialog = await editDialog();
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "COOKING BASICS");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("This user already has a channel with that name.");
    expect(name).toBeInvalid();
    expect(name).toHaveFocus();
    expect(name).toHaveAccessibleDescription("This user already has a channel with that name.");
    expect(channelOf(app, GARDEN_ID).name).toBe("Garden Weekly");
    // Another name is saved from the same dialog.
    await user.clear(name);
    await user.type(name, "Garden Notes");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(channelOf(app, GARDEN_ID).name).toBe("Garden Notes");
  });

  it("sends nothing when nothing changed", async () => {
    const user = userEvent.setup();
    const app = await open();
    const before = structuredClone(channelOf(app, GARDEN_ID));
    await user.click(screen.getByRole("button", { name: "Edit Garden Weekly" }));
    const dialog = await editDialog();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(channelOf(app, GARDEN_ID)).toEqual(before);
  });

  it("locks the owner and the folder of a busy channel and says why, but allows the rest", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: "Edit Cooking Basics" }));
    const dialog = await editDialog();
    expect(within(dialog).getByRole("combobox", { name: "Owner" })).toBeDisabled();
    const choose = within(dialog).getByRole("button", { name: "Choose…" });
    expect(choose).toBeDisabled();
    expect(within(dialog).getAllByText(CHANNEL_BUSY_REASON)).toHaveLength(2);
    expect(choose).toHaveAccessibleDescription(CHANNEL_BUSY_REASON);
    expect(within(dialog).getByTestId("channel-folder")).toHaveTextContent(COOKING_DIR);
    // The name and the video type are still free to change.
    const name = within(dialog).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Cooking 101");
    await user.click(within(dialog).getByRole("radio", { name: "Always Short" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(channelOf(app, COOKING_ID)).toMatchObject({
      name: "Cooking 101",
      videoType: "short",
      userId: userIdOf(app, ANA_EMAIL),
      dir: COOKING_DIR,
    });
  });

  it("shows the server's sentence when a channel turned busy while the dialog was open", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: "Edit Garden Weekly" }));
    const dialog = await editDialog();
    // An edit of the channel's videos starts now (the page still thinks it is idle).
    addJob(
      app.backend.world,
      {
        channelId: GARDEN_ID,
        folderName: "Spring Planting",
        userId: userIdOf(app, ANA_EMAIL),
        state: "running",
      },
      Date.now(),
    );
    await user.click(within(dialog).getByRole("combobox", { name: "Owner" }));
    await user.click(await screen.findByRole("option", { name: BEN_EMAIL }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(CHANNEL_BUSY_REASON);
    expect(screen.getByRole("dialog", { name: "Edit Channel" })).toBeInTheDocument();
    expect(channelOf(app, GARDEN_ID).userId).toBe(userIdOf(app, ANA_EMAIL));
  });
});

describe("ChannelsPage: Remove", () => {
  it("asks first, says the folder stays, and removes only the channel", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: "Remove Garden Weekly" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Garden Weekly?" });
    expect(
      within(dialog).getByText(
        "The folder and its files stay on the server; nothing in it is deleted.",
      ),
    ).toBeInTheDocument();
    // Cancel keeps it.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(channelOf(app, GARDEN_ID)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Remove Garden Weekly" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Remove Garden Weekly?" })).getByRole(
        "button",
        { name: "Remove Channel" },
      ),
    );
    await waitFor(() => {
      expect(screen.queryByText("Garden Weekly", { selector: "span" })).not.toBeInTheDocument();
    });
    expect(app.backend.world.channels.some((c) => c.id === GARDEN_ID)).toBe(false);
    expect(await screen.findByText("Channel removed")).toBeInTheDocument();
    // The folder is still on the server and can be given out again.
    const kept = await app.backend.fsList({ path: `${HOME}/Footage` });
    expect(kept.entries.map((e) => e.name)).toContain("Garden Weekly");
    expect(kept.entries.find((e) => e.name === "Garden Weekly")?.taken).toBe(false);
  });

  it("shows the server's refusal for a busy channel inside the dialog and keeps the channel", async () => {
    const user = userEvent.setup();
    const app = await open();
    await user.click(screen.getByRole("button", { name: "Remove Cooking Basics" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Cooking Basics?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove Channel" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(CHANNEL_BUSY_REASON);
    expect(screen.getByRole("dialog", { name: "Remove Cooking Basics?" })).toBeInTheDocument();
    expect(app.backend.world.channels.some((c) => c.id === COOKING_ID)).toBe(true);
    await act(async () => {
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    });
  });
});

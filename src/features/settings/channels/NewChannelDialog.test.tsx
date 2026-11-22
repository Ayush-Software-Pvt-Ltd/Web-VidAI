/**
 * The New Channel dialog: a name, a type and the three places for the videos (a new folder in the
 * personal folder, a new folder in a chosen place, an existing folder), the in-page folder picker,
 * folders that are taken, the server's refusals under the field they belong to, and what happens
 * after success.
 */
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { personalFolder } from "@/lib/mock/areas/workspace";
import { ADMIN_ID, USER_ID } from "@/lib/mock/seed/session";
import { ADMIN_CHANNEL_BEAUTY } from "@/lib/mock/seed/workspace";
import {
  BEAUTY,
  adminChannels,
  channelButton,
  channelNamed,
  renderChannels,
  shownPaths,
} from "./testing";

const MINE = personalFolder(ADMIN_ID);
const RAW = `${MINE}/Raw footage`;

type Rendered = Awaited<ReturnType<typeof renderChannels>>;

async function openDialog(options: Parameters<typeof renderChannels>[0] = {}) {
  const ctx = await renderChannels(options);
  await ctx.user.click(screen.getByRole("button", { name: "New Channel" }));
  const dialog = await screen.findByRole("dialog", { name: "New Channel" });
  return { ...ctx, dialog };
}

const nameField = (dialog: HTMLElement) => within(dialog).getByRole("textbox");
const placeChoice = (dialog: HTMLElement, name: string) =>
  within(dialog).getByRole("radio", { name });
const createButton = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: "Create Channel" });

async function chooseFolder(user: Rendered["user"], dialog: HTMLElement, row: string) {
  await user.click(within(dialog).getByRole("button", { name: "Choose Folder…" }));
  const picker = await screen.findByRole("dialog", { name: /^Choose / });
  const folders = await within(picker).findByRole("option", { name: new RegExp(row) });
  await user.click(folders);
  await user.click(within(picker).getByRole("button", { name: /^Choose "/ }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: /^Choose / })).not.toBeInTheDocument();
  });
}

describe("New Channel: my folder (the default)", () => {
  it("shows the folder that will be made and creates the channel there", async () => {
    const { user, dialog, backend, calls } = await openDialog();
    expect(placeChoice(dialog, "My folder")).toBeChecked();
    expect(placeChoice(dialog, "Another place")).not.toBeChecked();
    expect(createButton(dialog)).toBeDisabled();

    await user.type(nameField(dialog), "Glow Naturals");
    await waitFor(() => {
      expect(shownPaths(dialog)).toEqual([`${MINE}/Glow Naturals`]);
    });
    expect(createButton(dialog)).toBeEnabled();
    await user.click(createButton(dialog));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New Channel" })).not.toBeInTheDocument();
    });
    expect(calls("createChannel")).toEqual([
      {
        name: "Glow Naturals",
        videoType: "auto",
        location: { kind: "new", parent: null, folderName: null },
      },
    ]);
    const made = channelNamed(backend, "Glow Naturals");
    expect(made?.dir).toBe(`${MINE}/Glow Naturals`);
    expect(made?.long.prompts[0]?.text).toBe(backend.world.defaultPrompt);
    // The new channel is selected and its editor is open.
    expect(screen.getByRole("textbox", { name: "Channel name" })).toHaveValue("Glow Naturals");
    expect(channelButton("Glow Naturals")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "3 Channels" })).toBeInTheDocument();
  });

  it("makes the folder name from the channel name the way the server does", async () => {
    const { user, dialog } = await openDialog();
    await user.type(nameField(dialog), "Q/A: tips");
    await waitFor(() => {
      expect(shownPaths(dialog)).toEqual([`${MINE}/Q-A: tips`]);
    });
  });

  it("creates it with the chosen video type", async () => {
    const { user, dialog, backend } = await openDialog();
    await user.type(nameField(dialog), "Reels");
    await user.click(within(dialog).getByRole("radio", { name: "Always Short" }));
    await user.click(createButton(dialog));
    await waitFor(() => {
      expect(channelNamed(backend, "Reels")?.videoType).toBe("short");
    });
  });

  it("creates with Return in the name field", async () => {
    const { user, dialog, backend } = await openDialog();
    await user.type(nameField(dialog), "हिंदी चैनल{Enter}");
    await waitFor(() => {
      expect(channelNamed(backend, "हिंदी चैनल")).toBeDefined();
    });
    expect(screen.getByRole("textbox", { name: "Channel name" })).toHaveValue("हिंदी चैनल");
  });

  it("refuses a name that is too long before asking the server", async () => {
    const { user, dialog, calls } = await openDialog();
    await user.type(nameField(dialog), "x".repeat(61));
    expect(within(dialog).getByText("A channel name must have 1 to 60 characters.")).toBeVisible();
    expect(createButton(dialog)).toBeDisabled();
    expect(calls("createChannel")).toEqual([]);
  });

  it("shows the server's sentence under the name when the name is taken", async () => {
    const { user, dialog, backend } = await openDialog();
    await user.type(nameField(dialog), BEAUTY);
    await user.click(createButton(dialog));
    expect(
      await within(dialog).findByText("You already have a channel with this name."),
    ).toBeVisible();
    expect(nameField(dialog)).toHaveAttribute("aria-invalid", "true");
    // The folder field has no message of its own: the one alert is the name's.
    expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
    expect(adminChannels(backend)).toHaveLength(2);
    // Typing again clears it.
    await user.type(nameField(dialog), " 2");
    expect(
      within(dialog).queryByText("You already have a channel with this name."),
    ).not.toBeInTheDocument();
  });

  it("shows a refused folder (forbidden) under the folder, not under the name", async () => {
    const { user, dialog, refuse } = await openDialog();
    refuse(
      "createChannel",
      "forbidden",
      "This folder is outside the storage folders the admin allows.",
    );
    await user.type(nameField(dialog), "Glow");
    await user.click(createButton(dialog));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("This folder is outside the storage folders the admin allows.");
    expect(nameField(dialog)).not.toHaveAttribute("aria-invalid", "true");
    expect(createButton(dialog)).toBeEnabled();
  });

  it("shows a refusal that has no field (a server error) under the name", async () => {
    const { user, dialog, refuse } = await openDialog();
    refuse("createChannel", "internal", "The server could not make the channel.");
    await user.type(nameField(dialog), "Glow");
    await user.click(createButton(dialog));
    expect(await within(dialog).findByText("The server could not make the channel.")).toBeVisible();
  });

  it("cancels without creating and starts clean the next time", async () => {
    const { user, dialog, calls } = await openDialog();
    await user.type(nameField(dialog), "Glow");
    await user.click(within(dialog).getByRole("radio", { name: "Existing folder" }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "New Channel" })).not.toBeInTheDocument();
    });
    expect(calls("createChannel")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "New Channel" }));
    const again = await screen.findByRole("dialog", { name: "New Channel" });
    expect(nameField(again)).toHaveValue("");
    expect(placeChoice(again, "My folder")).toBeChecked();
  });
});

describe("New Channel: another place", () => {
  it("makes a new folder inside the chosen folder", async () => {
    const { user, dialog, backend, calls } = await openDialog();
    await user.type(nameField(dialog), "Studio");
    await user.click(placeChoice(dialog, "Another place"));
    expect(within(dialog).getByText("No place chosen yet.")).toBeVisible();
    // Choosing a place is needed first.
    expect(createButton(dialog)).toBeDisabled();

    await chooseFolder(user, dialog, "Raw footage");
    await waitFor(() => {
      expect(shownPaths(dialog)).toEqual([RAW, `${RAW}/Studio`]);
    });
    expect(within(dialog).getByRole("button", { name: "Change Folder…" })).toBeInTheDocument();
    await user.click(createButton(dialog));
    await waitFor(() => {
      expect(channelNamed(backend, "Studio")?.dir).toBe(`${RAW}/Studio`);
    });
    expect(calls("createChannel")).toEqual([
      {
        name: "Studio",
        videoType: "auto",
        location: { kind: "new", parent: RAW, folderName: null },
      },
    ]);
    expect(screen.getByRole("textbox", { name: "Channel name" })).toHaveValue("Studio");
  });

  it("says under the name when a folder of that name already exists in the chosen place", async () => {
    const { user, dialog, refuse } = await openDialog();
    await user.type(nameField(dialog), "Studio");
    await user.click(placeChoice(dialog, "Another place"));
    await chooseFolder(user, dialog, "Raw footage");
    refuse("createChannel", "conflict", "A folder with this name already exists there.");
    await user.click(createButton(dialog));
    expect(
      await within(dialog).findByText("A folder with this name already exists there."),
    ).toBeVisible();
    expect(nameField(dialog)).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps the chosen place while the name changes and back to My folder", async () => {
    const { user, dialog } = await openDialog();
    await user.type(nameField(dialog), "Studio");
    await user.click(placeChoice(dialog, "Another place"));
    await chooseFolder(user, dialog, "Raw footage");
    await user.click(placeChoice(dialog, "My folder"));
    await waitFor(() => {
      expect(shownPaths(dialog)).toEqual([`${MINE}/Studio`]);
    });
    await user.click(placeChoice(dialog, "Another place"));
    expect(shownPaths(dialog)).toEqual([RAW, `${RAW}/Studio`]);
  });
});

describe("New Channel: existing folder", () => {
  it("uses the folder as it is, with its name as the channel name", async () => {
    const { user, dialog, backend, calls } = await openDialog();
    await user.click(placeChoice(dialog, "Existing folder"));
    expect(within(dialog).getByText("No folder chosen yet.")).toBeVisible();
    expect(createButton(dialog)).toBeDisabled();
    await chooseFolder(user, dialog, "Raw footage");
    expect(shownPaths(dialog)).toEqual([RAW]);
    expect(nameField(dialog)).toHaveValue("Raw footage");
    await user.click(createButton(dialog));
    await waitFor(() => {
      expect(channelNamed(backend, "Raw footage")?.dir).toBe(RAW);
    });
    expect(calls("createChannel")).toEqual([
      { name: "Raw footage", videoType: "auto", location: { kind: "link", dir: RAW } },
    ]);
    expect(screen.getByRole("textbox", { name: "Channel name" })).toHaveValue("Raw footage");
  });

  it("keeps a name the person already typed", async () => {
    const { user, dialog } = await openDialog();
    await user.type(nameField(dialog), "My rushes");
    await user.click(placeChoice(dialog, "Existing folder"));
    await chooseFolder(user, dialog, "Raw footage");
    expect(nameField(dialog)).toHaveValue("My rushes");
  });

  it("cannot choose a folder that belongs to a channel", async () => {
    const { user, dialog, calls } = await openDialog();
    await user.click(placeChoice(dialog, "Existing folder"));
    await user.click(within(dialog).getByRole("button", { name: "Choose Folder…" }));
    const picker = await screen.findByRole("dialog", { name: "Choose the channel's folder" });
    const row = await within(picker).findByRole("option", { name: new RegExp(BEAUTY) });
    expect(row).toHaveTextContent("Used by a channel");
    await user.click(row);
    const choose = within(picker).getByRole("button", { name: /^Choose/ });
    expect(choose).toBeDisabled();
    expect(choose).toHaveAttribute("title", "This folder already belongs to a channel.");
    await user.click(choose);
    expect(within(dialog).getByText("No folder chosen yet.")).toBeVisible();
    expect(calls("createChannel")).toEqual([]);
  });

  it("shows the server's refusal of the folder under the folder field", async () => {
    const { user, dialog, refuse } = await openDialog();
    await user.click(placeChoice(dialog, "Existing folder"));
    await chooseFolder(user, dialog, "Raw footage");
    refuse("createChannel", "conflict", "This folder already belongs to a channel.");
    await user.click(createButton(dialog));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This folder already belongs to a channel.",
    );
    expect(nameField(dialog)).not.toHaveAttribute("aria-invalid", "true");
    // Another choice clears it.
    await user.click(within(dialog).getByRole("button", { name: "Change Folder…" }));
    const picker = await screen.findByRole("dialog", { name: "Choose the channel's folder" });
    await user.click(within(picker).getByRole("button", { name: "Cancel" }));
    await user.click(placeChoice(dialog, "My folder"));
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("New Channel: a second user", () => {
  it("makes the channel in their own folder and the first user's list is unchanged", async () => {
    const { user, dialog, backend } = await openDialog({ user: "user" });
    await user.type(nameField(dialog), "Trips");
    await waitFor(() => {
      expect(shownPaths(dialog)).toEqual([`${personalFolder(USER_ID)}/Trips`]);
    });
    await user.click(createButton(dialog));
    await waitFor(() => {
      expect(backend.world.channels.find((c) => c.name === "Trips")?.userId).toBe(USER_ID);
    });
    expect(screen.getByRole("textbox", { name: "Channel name" })).toHaveValue("Trips");
    expect(adminChannels(backend).map((c) => c.id)).toContain(ADMIN_CHANNEL_BEAUTY);
    expect(adminChannels(backend)).toHaveLength(2);
    expect(screen.queryByText(BEAUTY)).not.toBeInTheDocument();
  });

  it("may use the same name as the first user's channel", async () => {
    const { user, dialog, backend } = await openDialog({ user: "user" });
    await user.type(nameField(dialog), BEAUTY);
    await user.click(createButton(dialog));
    await waitFor(() => {
      expect(
        backend.world.channels
          .filter((c) => c.name === BEAUTY)
          .map((c) => c.userId)
          .sort(),
      ).toEqual([ADMIN_ID, USER_ID].sort());
    });
  });
});

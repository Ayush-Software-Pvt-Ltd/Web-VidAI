/**
 * Settings, Channels: the list (order, unreachable folder), the editor (type, slots, prompt tools),
 * Save and the unsaved-changes guard, what a second user sees, and that a user cannot make, rename
 * or remove a channel (an admin does, and the page follows `workspace-changed`).
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChannelUpdate } from "@/lib/types";
import { MockBackend } from "@/lib/mock";
import { USER_ID } from "@/lib/mock/seed/session";
import { HOME } from "@/lib/mock/seed/storage";
import {
  ADMIN_CHANNEL_BEAUTY,
  ADMIN_CHANNEL_TECH,
  USER_CHANNEL_TRAVEL,
  profile,
} from "@/lib/mock/seed/workspace";
import {
  BEAUTY,
  TECH,
  addAdminChannel,
  adminChannels,
  adminDir,
  channelButton,
  channelNamed,
  openChannel,
  renderChannels,
  shownPaths,
} from "./testing";

const SEEDED_PROMPT = "The long prompt of this channel.";
const SEEDED_STYLE_COUNT = 5;

describe("Channels: list", () => {
  it("lists the user's channels in order with type, folder and nothing of other users", async () => {
    await renderChannels();
    const list = screen.getByRole("list", { name: "Channels" });
    const rows = within(list).getAllByRole("button", { name: /^(?!Reorder)/ });
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining(BEAUTY),
      expect.stringContaining(TECH),
    ]);
    expect(screen.getByRole("heading", { name: "2 Channels" })).toBeInTheDocument();
    expect(within(channelButton(BEAUTY)).getByText("Auto-detect")).toBeInTheDocument();
    expect(shownPaths(list)).toEqual([adminDir(BEAUTY), adminDir(TECH)]);
    expect(screen.queryByText("Travel Diary")).not.toBeInTheDocument();
    // The first channel is open.
    expect(openChannel(BEAUTY)).toBeInTheDocument();
  });

  it("shows only the channels of the signed-in user, never the first user's", async () => {
    await renderChannels({ user: "user" });
    expect(openChannel("Travel Diary")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "1 Channel" })).toBeInTheDocument();
    expect(screen.queryByText(BEAUTY)).not.toBeInTheDocument();
    expect(screen.queryByText(TECH)).not.toBeInTheDocument();
    expect(shownPaths()).not.toContain(adminDir(BEAUTY));
  });

  it("opens the channel asked for", async () => {
    await renderChannels({}, { initialChannelId: ADMIN_CHANNEL_TECH });
    expect(openChannel(TECH)).toBeInTheDocument();
  });

  it("opens on the Short tab when asked", async () => {
    await renderChannels({}, { initialVideoType: "short" });
    expect(screen.getByRole("textbox", { name: "Short 9:16 prompt" })).toBeInTheDocument();
  });

  it("says when a channel's folder cannot be reached, in the list and in the editor", async () => {
    await renderChannels({
      prepare: (backend) => {
        const tech = channelNamed(backend, TECH);
        if (tech) tech.available = false;
      },
    });
    expect(
      within(channelButton(TECH)).getByRole("img", { name: "Folder cannot be reached" }),
    ).toBeInTheDocument();
    expect(
      within(channelButton(BEAUTY)).queryByRole("img", { name: "Folder cannot be reached" }),
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(channelButton(TECH));
    expect(screen.getByText("Folder cannot be reached")).toBeInTheDocument();
    expect(screen.getByText(/This channel's folder cannot be reached right now\./)).toBeVisible();
    // The channel can still be edited.
    expect(screen.getByRole("textbox", { name: "Long 16:9 prompt" })).toBeEnabled();
  });

  it("tells a person without channels that an admin adds them, with no New Channel", async () => {
    await renderChannels({ scenarios: ["no-channels"] });
    expect(screen.getByText("No channels yet")).toBeInTheDocument();
    expect(screen.getByText("An admin adds channels for you.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New Channel/ })).not.toBeInTheDocument();
  });

  it("shows a channel an admin adds for the user, and drops one an admin removes, at once", async () => {
    const { backend } = await renderChannels({ user: "user" });
    expect(openChannel("Travel Diary")).toBeInTheDocument();
    const admin = new MockBackend({
      world: backend.world,
      as: "admin",
      latencyMs: 0,
      autoTick: false,
    });
    try {
      await admin.adminCreateChannel({
        name: "Cooking",
        userId: USER_ID,
        dir: `${HOME}/Movies`,
        videoType: "auto",
      });
      expect(await screen.findByRole("button", { name: /^Cooking/ })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "2 Channels" })).toBeInTheDocument();
      await admin.adminRemoveChannel({ id: USER_CHANNEL_TRAVEL });
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: /^Travel Diary/ })).not.toBeInTheDocument();
      });
      expect(openChannel("Cooking")).toBeInTheDocument();
    } finally {
      admin.dispose();
    }
  });

  it("reorders with the keyboard and sends the new order", async () => {
    const { user, backend, calls } = await renderChannels({
      prepare: (b) => {
        addAdminChannel(b, "Cooking");
      },
    });
    screen.getByRole("button", { name: "Reorder Cooking" }).focus();
    await user.keyboard("{ArrowUp}");
    await waitFor(() => {
      expect(adminChannels(backend).map((c) => c.name)).toEqual([BEAUTY, "Cooking", TECH]);
    });
    expect(calls("reorderChannels")).toEqual([
      { ids: [ADMIN_CHANNEL_BEAUTY, expect.any(String), ADMIN_CHANNEL_TECH] },
    ]);
    expect(screen.getByRole("button", { name: "Reorder Cooking" })).toHaveFocus();
    expect(screen.getByText("Cooking moved to position 2 of 3.")).toBeInTheDocument();
    await user.click(channelButton(BEAUTY));
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() => {
      expect(adminChannels(backend)[1]?.name).toBe(BEAUTY);
    });
  });

  it("reorders by dragging the handle", async () => {
    const { backend } = await renderChannels();
    const handle = screen.getByRole("button", { name: `Reorder ${BEAUTY}` });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 32,
    } as DOMRect);
    // jsdom has no pointer capture.
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    fireEvent.pointerDown(handle, { button: 0, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 76, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 76, pointerId: 1 });
    await waitFor(() => {
      expect(adminChannels(backend)[1]?.name).toBe(BEAUTY);
    });
  });

  it("shows the server's sentence when the new order is refused, and keeps the old order", async () => {
    const { user, refuse, backend } = await renderChannels();
    refuse(
      "reorderChannels",
      "invalidInput",
      "The new order must list each of your channels once.",
    );
    screen.getByRole("button", { name: `Reorder ${TECH}` }).focus();
    await user.keyboard("{ArrowUp}");
    expect(
      await screen.findByText("The new order must list each of your channels once."),
    ).toBeInTheDocument();
    expect(adminChannels(backend).map((c) => c.name)).toEqual([BEAUTY, TECH]);
    await waitFor(() => {
      const names = within(screen.getByRole("list", { name: "Channels" }))
        .getAllByRole("button", { name: /^(?!Reorder)/ })
        .map((row) => row.textContent);
      expect(names[0]).toContain(BEAUTY);
    });
  });
});

describe("Channels: editor", () => {
  it("shows the first channel with its long prompt, count and style", async () => {
    await renderChannels();
    expect(screen.getByRole("textbox", { name: "Long 16:9 prompt" })).toHaveValue(SEEDED_PROMPT);
    expect(
      screen.getAllByText(`${SEEDED_PROMPT.length.toLocaleString("en-US")} characters`).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", { name: "Long 16:9 style" })).toHaveValue(
      "The long style of this channel.",
    );
    expect(screen.getByText("All changes saved")).toBeInTheDocument();
    expect(shownPaths(openChannel(BEAUTY).parentElement ?? document.body)).toContain(
      adminDir(BEAUTY),
    );
  });

  it("marks unsaved changes per tab and channel, then saves only what changed", async () => {
    const { user, backend, calls } = await renderChannels();
    const style = screen.getByRole("textbox", { name: "Long 16:9 style" });
    await user.clear(style);
    await user.type(style, "Bold captions");
    expect(screen.getByRole("tab", { name: /Long 16:9, unsaved changes/ })).toBeInTheDocument();
    expect(within(channelButton(BEAUTY)).getByLabelText("Unsaved changes")).toBeVisible();
    expect(screen.getByText(/Unsaved changes to the Long 16:9 style/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(channelNamed(backend, BEAUTY)?.long.styles[0]?.text).toBe("Bold captions");
    });
    // Only the long profile went to the server.
    expect(calls("updateChannel")).toHaveLength(1);
    const sent = calls("updateChannel")[0] as { id: string; update: ChannelUpdate };
    expect(sent.id).toBe(ADMIN_CHANNEL_BEAUTY);
    expect(sent.update).toMatchObject({ videoType: null, short: null });
    expect(sent.update.long?.styles[0]?.text).toBe("Bold captions");
    expect(channelNamed(backend, BEAUTY)?.short.styles[0]?.text).not.toBe("Bold captions");
    expect(channelNamed(backend, BEAUTY)?.long.styles).toHaveLength(SEEDED_STYLE_COUNT);
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.queryByLabelText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("saves with Cmd+S and edits the Short tab separately", async () => {
    const { user, backend } = await renderChannels();
    await user.click(screen.getByRole("tab", { name: "Short 9:16" }));
    const prompt = screen.getByRole("textbox", { name: "Short 9:16 prompt" });
    await user.clear(prompt);
    await user.type(prompt, "Short prompt");
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() => {
      expect(channelNamed(backend, BEAUTY)?.short.prompts[0]?.text).toBe("Short prompt");
    });
    expect(channelNamed(backend, BEAUTY)?.long.prompts[0]?.text).toBe(SEEDED_PROMPT);
  });

  it("reverts to the saved text", async () => {
    const { user } = await renderChannels();
    const style = screen.getByRole("textbox", { name: "Long 16:9 style" });
    await user.type(style, " more");
    await user.click(screen.getByRole("button", { name: "Revert" }));
    expect(style).toHaveValue("The long style of this channel.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows the name and the folder as text: a user cannot rename or move a channel", async () => {
    const { user } = await renderChannels();
    expect(openChannel(BEAUTY)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Channel name" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New Channel" })).not.toBeInTheDocument();
    await user.click(channelButton(TECH));
    expect(openChannel(TECH)).toBeInTheDocument();
    expect(shownPaths()).toContain(adminDir(TECH));
  });

  it("sends no name, folder or owner when the user saves a change", async () => {
    const { user, calls } = await renderChannels();
    await user.type(screen.getByRole("textbox", { name: "Long 16:9 style" }), " more");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    const [sent] = calls("updateChannel") as { update: Record<string, unknown> }[];
    expect(Object.keys(sent?.update ?? {}).sort()).toEqual(["long", "short", "videoType"]);
  });

  it("sets the channel video type with Save, Revert and the unsaved-changes state", async () => {
    const { user, store, backend, calls } = await renderChannels();
    const control = screen.getByRole("radiogroup", { name: "Channel video type" });
    const choice = (name: string) => within(control).getByRole("radio", { name });
    expect(choice("Auto-detect")).toBeChecked();

    await user.click(choice("Always Short"));
    expect(choice("Always Short")).toBeChecked();
    expect(screen.getByText("Edited")).toBeInTheDocument();
    expect(within(channelButton(BEAUTY)).getByLabelText("Unsaved changes")).toBeVisible();
    expect(screen.getByText(/Unsaved changes to the video type/)).toBeInTheDocument();
    // Prompts are untouched, so the tabs stay clean.
    expect(screen.getByRole("tab", { name: "Long 16:9" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Revert" }));
    expect(choice("Auto-detect")).toBeChecked();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    // Picking a choice and then the saved one again is clean.
    await user.click(choice("Always Long"));
    await user.click(choice("Auto-detect"));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.click(choice("Always Short"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(channelNamed(backend, BEAUTY)?.videoType).toBe("short");
    });
    expect(calls("updateChannel")).toEqual([
      {
        id: ADMIN_CHANNEL_BEAUTY,
        update: { videoType: "short", long: null, short: null },
      },
    ]);
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.queryByText("Edited")).not.toBeInTheDocument();
    expect(choice("Always Short")).toBeChecked();
    // The store follows.
    await waitFor(() => {
      expect(store.getState().workspace.data?.channels[0]?.videoType).toBe("short");
    });
  });

  it("warns when a prompt is empty", async () => {
    const { user } = await renderChannels({
      prepare: (backend) => {
        const tech = channelNamed(backend, TECH);
        if (tech) tech.short = profile("short");
        if (tech) tech.short.prompts[0] = { name: "Default", text: "" };
      },
    });
    await user.click(channelButton(TECH));
    await user.click(screen.getByRole("tab", { name: "Short 9:16" }));
    expect(
      screen.getByText("Empty: Short 9:16 videos of this channel cannot use the Default prompt"),
    ).toBeInTheDocument();
  });

  it("shows a failed save with the server's sentence and keeps the draft", async () => {
    const { user, refuse } = await renderChannels();
    refuse("updateChannel", "internal", "The server could not save the channel.");
    const style = screen.getByRole("textbox", { name: "Long 16:9 style" });
    await user.type(style, " more");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The server could not save the channel.",
    );
    expect(style).toHaveValue("The long style of this channel. more");
  });
});

describe("Channels: prompt and style slots", () => {
  const pick = async (user: ReturnType<typeof userEvent.setup>, label: string, option: string) => {
    await user.click(screen.getByRole("combobox", { name: label }));
    await user.click(await screen.findByRole("option", { name: new RegExp(`^${option}`) }));
  };

  it("lists five slots, shows Default read-only and edits another slot's name and text", async () => {
    const { user, backend } = await renderChannels();
    const slotPicker = screen.getByRole("combobox", { name: "Long 16:9 prompt slot" });
    expect(slotPicker).toHaveTextContent("Default");
    expect(screen.getByRole("textbox", { name: "Prompt name, Long 16:9" })).toBeDisabled();
    await user.click(slotPicker);
    expect(await screen.findAllByRole("option")).toHaveLength(5);
    await user.keyboard("{Escape}");

    await pick(user, "Long 16:9 prompt slot", "Prompt 2");
    const name = screen.getByRole("textbox", { name: "Prompt name, Long 16:9" });
    expect(name).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Long 16:9 prompt" })).toHaveValue("");
    await user.clear(name);
    expect(screen.getByRole("alert")).toHaveTextContent("Give it a name.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(name, "Reviews");
    await user.type(screen.getByRole("textbox", { name: "Long 16:9 prompt" }), "Review it.");
    expect(screen.getByRole("tab", { name: /Long 16:9, unsaved changes/ })).toBeInTheDocument();
    expect(screen.getByText(/Unsaved changes to the Long 16:9 prompt$/)).toBeInTheDocument();

    // Another slot keeps its own text; the edit in this one stays unsaved meanwhile.
    await pick(user, "Long 16:9 prompt slot", "Default");
    expect(screen.getByRole("textbox", { name: "Long 16:9 prompt" })).toHaveValue(SEEDED_PROMPT);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(channelNamed(backend, BEAUTY)?.long.prompts[1]).toEqual({
        name: "Reviews",
        text: "Review it.",
      });
    });
    expect(channelNamed(backend, BEAUTY)?.long.prompts[0]?.name).toBe("Default");
    expect(channelNamed(backend, BEAUTY)?.short.prompts[1]?.name).toBe("Prompt 2");
  });

  it("refuses a name longer than 40 characters and edits styles separately", async () => {
    const { user, backend } = await renderChannels();
    await pick(user, "Long 16:9 style slot", "Style 3");
    const name = screen.getByRole("textbox", { name: "Style name, Long 16:9" });
    await user.clear(name);
    await user.type(name, "x".repeat(41));
    expect(screen.getByRole("alert")).toHaveTextContent("Use at most 40 characters.");
    await user.type(name, "{Backspace}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Long 16:9 style" }), "Neon");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(channelNamed(backend, BEAUTY)?.long.styles[2]).toEqual({
        name: "x".repeat(40),
        text: "Neon",
      });
    });
  });
});

describe("Channels: prompt tools", () => {
  async function openTools(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Prompt Tools" }));
    return screen.findByRole("menu");
  }

  it("resets the shown slot to the default prompt after a confirmation, then saves it", async () => {
    const { user, backend } = await renderChannels();
    const prompt = screen.getByRole("textbox", { name: "Long 16:9 prompt" });
    await user.clear(prompt);
    await user.type(prompt, "Mine");
    const menu = await openTools(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Reset to Default" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(prompt).toHaveValue("Mine");
    await user.click(within(dialog).getByRole("button", { name: "Replace Prompt" }));
    await waitFor(() => {
      expect(prompt).toHaveValue(backend.world.defaultPrompt);
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(channelNamed(backend, BEAUTY)?.long.prompts[0]?.text).toBe(
        backend.world.defaultPrompt,
      );
    });
  });

  it("copies from the other type without asking when the prompt is empty", async () => {
    const { user, backend } = await renderChannels({
      prepare: (b) => {
        const tech = channelNamed(b, TECH);
        if (tech) tech.short.prompts[0] = { name: "Default", text: "" };
      },
    });
    await user.click(channelButton(TECH));
    await user.click(screen.getByRole("tab", { name: "Short 9:16" }));
    const menu = await openTools(user);
    await user.click(within(menu).getByRole("menuitem", { name: "Copy from Long 16:9" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Short 9:16 prompt" })).toHaveValue(SEEDED_PROMPT);
    });
    expect(channelNamed(backend, TECH)?.short.prompts[0]?.text).toBe("");
  });

  it("copies the same type from another channel after a confirmation", async () => {
    const { user } = await renderChannels({
      prepare: (backend) => {
        const tech = channelNamed(backend, TECH);
        if (tech) tech.long = profile("TECH PROMPT");
      },
    });
    const menu = await openTools(user);
    within(menu).getByRole("menuitem", { name: "Copy from Another Channel" }).focus();
    await user.keyboard("{ArrowRight}");
    await user.click(await screen.findByRole("menuitem", { name: TECH }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(`the Long 16:9 prompt of “${TECH}”`);
    await user.click(within(dialog).getByRole("button", { name: "Replace Prompt" }));
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Long 16:9 prompt" })).toHaveValue(
        "The TECH PROMPT prompt of this channel.",
      );
    });
  });

  it("never offers another user's channels to copy from", async () => {
    const { user } = await renderChannels();
    const menu = await openTools(user);
    within(menu).getByRole("menuitem", { name: "Copy from Another Channel" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("menuitem", { name: TECH })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Travel Diary" })).not.toBeInTheDocument();
  });
});

describe("Channels: unsaved-changes guard", () => {
  async function dirtyBeauty() {
    const ctx = await renderChannels();
    await ctx.user.type(screen.getByRole("textbox", { name: "Long 16:9 style" }), " edited");
    await ctx.user.click(channelButton(TECH));
    await screen.findByRole("dialog", { name: `Save changes to “${BEAUTY}”?` });
    return ctx;
  }

  it("Stay keeps the draft and the channel", async () => {
    const { user } = await dirtyBeauty();
    await user.click(screen.getByRole("button", { name: "Stay" }));
    expect(openChannel(BEAUTY)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Long 16:9 style" })).toHaveValue(
      "The long style of this channel. edited",
    );
  });

  it("Discard drops the draft and switches", async () => {
    const { user, backend } = await dirtyBeauty();
    await user.click(screen.getByRole("button", { name: "Discard Changes" }));
    expect(openChannel(TECH)).toBeInTheDocument();
    expect(channelNamed(backend, BEAUTY)?.long.styles[0]?.text).not.toMatch(/edited$/);
    await user.click(channelButton(BEAUTY));
    expect(screen.getByRole("textbox", { name: "Long 16:9 style" })).toHaveValue(
      "The long style of this channel.",
    );
  });

  it("Save saves, then switches", async () => {
    const { user, backend } = await dirtyBeauty();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(openChannel(TECH)).toBeInTheDocument();
    });
    expect(channelNamed(backend, BEAUTY)?.long.styles[0]?.text).toMatch(/ edited$/);
  });
});

describe("Channels: users cannot make, change or remove channels", () => {
  it("has no call for it on the user's side and sees only own channels", async () => {
    const { backend } = await renderChannels({ user: "user" });
    expect(screen.queryByText(BEAUTY)).not.toBeInTheDocument();
    expect("createChannel" in backend).toBe(false);
    expect("removeChannel" in backend).toBe(false);
    // The admin's functions answer forbidden to a user, whatever the page does.
    await expect(backend.adminRemoveChannel({ id: ADMIN_CHANNEL_BEAUTY })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      backend.adminUpdateChannel({
        id: USER_CHANNEL_TRAVEL,
        update: { name: "Mine", userId: null, dir: null, videoType: null },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(channelNamed(backend, BEAUTY)).toBeDefined();
    expect(backend.world.channels.filter((c) => c.userId === USER_ID)).toHaveLength(1);
    expect(backend.world.channels.find((c) => c.id === USER_CHANNEL_TRAVEL)?.name).toBe(
      "Travel Diary",
    );
  });
});

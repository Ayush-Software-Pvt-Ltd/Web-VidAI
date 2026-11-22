/**
 * The in-page folder picker, against the mock server's storage area: places (one of them not
 * reachable), browsing, folders that belong to a channel, New Folder, the keyboard, choosing and
 * cancelling, a listing that fails and recovers, a vanished start folder and a very long folder.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { AppEnvContext } from "@/lib/appEnv";
import type { Api } from "@/lib/api";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";
import { MEDIA_ROOT, personalFolder } from "@/lib/mock/areas/workspace";
import { ADMIN_ID, USER_ID } from "@/lib/mock/seed/session";
import { FOOTAGE_ROOT, SHARE_ROOT, makeUnreachable } from "@/lib/mock/seed/storage";
import { setupApp, type SetupOptions } from "@/test/app";
import { FolderPickerDialog, type FolderPickerDialogProps } from "./index";

const MINE = personalFolder(ADMIN_ID);
const RAW = `${MINE}/Raw footage`;

function Host({
  onPick,
  startOpen = true,
  ...props
}: Omit<FolderPickerDialogProps, "open" | "onOpenChange"> & { startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open picker
      </button>
      <FolderPickerDialog {...props} open={open} onOpenChange={setOpen} onPick={onPick} />
    </>
  );
}

async function setup(
  props: Partial<Omit<FolderPickerDialogProps, "open" | "onOpenChange">> & {
    startOpen?: boolean;
  } = {},
  options: SetupOptions = {},
) {
  const app = await setupApp(["default"], { load: false, ...options });
  const onPick = vi.fn<(path: string) => void>();
  // The mock's functions cannot be spied on, so a test replaces `fsList` through `hooks`.
  const hooks: { fsList?: Api["fsList"] } = {};
  const api = Object.create(app.backend, {
    fsList: {
      value: (input: Parameters<Api["fsList"]>[0]) => (hooks.fsList ?? app.backend.fsList)(input),
    },
  }) as Api;
  app.render(
    <AppEnvContext value={{ api, store: app.store }}>
      <Host onPick={onPick} {...props} />
    </AppEnvContext>,
  );
  const user = userEvent.setup();
  const ready = async () => {
    await screen.findByRole("navigation", { name: "Path" });
    await waitFor(() => {
      expect(screen.getByRole("listbox")).not.toHaveAttribute("aria-busy");
    });
  };
  if (props.startOpen !== false) {
    await screen.findByRole("dialog");
    await ready();
  }
  return { ...app, user, onPick, ready, hooks };
}

const list = () => screen.getByRole("listbox", { name: "Folders" });
const rowNames = () =>
  within(list())
    .queryAllByRole("option")
    .map((option) => option.getAttribute("title")?.split(" - ")[0]);
const row = (name: string) =>
  within(list()).getByRole("option", { name: new RegExp(`^${name}(Used by a channel)?$`) });
const crumbs = () =>
  within(screen.getByRole("navigation", { name: "Path" }))
    .getAllByRole("button")
    .map((button) => button.textContent);
const choose = () => screen.getByRole("button", { name: /^Choose/ });
const place = (name: string) =>
  within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", {
    name: new RegExp(`^${name}`),
  });

describe("places", () => {
  it("lists the personal folder first and then the storage folders", async () => {
    await setup();
    const places = within(screen.getByRole("navigation", { name: "Places" })).getAllByRole(
      "button",
    );
    expect(places.map((button) => button.textContent)).toEqual([
      "My folder",
      "Server storage",
      "footage",
      "shoots",
    ]);
    // It opens in the personal folder, the place that holds it is marked.
    expect(place("My folder")).toHaveAttribute("aria-current", "true");
    expect(crumbs().slice(0, 1)).toEqual(["My folder"]);
    expect(rowNames()).toEqual(["Beauty Channel", "Raw footage", "Tech Reviews"]);
  });

  it("opens a storage folder from its place", async () => {
    const { user, ready } = await setup();
    await user.click(place("footage"));
    await ready();
    await waitFor(() => {
      expect(rowNames()).toEqual(["Campaigns", "Interviews"]);
    });
    expect(place("footage")).toHaveAttribute("aria-current", "true");
    expect(crumbs().slice(0, 1)).toEqual(["footage"]);
    expect(screen.getByRole("button", { name: "Up one level" })).toBeDisabled();
  });

  it("shows a storage folder that cannot be reached greyed, and says so when it is clicked", async () => {
    const { user } = await setup({}, { prepare: (b) => makeUnreachable(b.world, SHARE_ROOT) });
    const shoots = place("shoots");
    expect(shoots).toHaveAttribute("aria-disabled", "true");
    await user.click(shoots);
    expect(await screen.findByRole("status")).toHaveTextContent(
      '"shoots" cannot be reached right now. Ask the admin to check it.',
    );
    // Nothing changed.
    expect(rowNames()).toEqual(["Beauty Channel", "Raw footage", "Tech Reviews"]);
    expect(place("footage")).not.toHaveAttribute("aria-disabled");
  });
});

describe("browsing", () => {
  it("opens a folder with a double click and goes up through the path and the Up button", async () => {
    const { user, ready } = await setup();
    await user.dblClick(row("Raw footage"));
    await waitFor(() => {
      expect(rowNames()).toEqual(["Day 1", "Day 2", "Day 10"]);
    });
    expect(crumbs().slice(0, 2)).toEqual(["My folder", "Raw footage"]);
    expect(screen.getByText("2 video files in this folder")).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("navigation", { name: "Path" })).getByRole("button", {
        name: "My folder",
      }),
    );
    await ready();
    await waitFor(() => {
      expect(rowNames()).toContain("Raw footage");
    });
    await user.dblClick(row("Raw footage"));
    await waitFor(() => {
      expect(rowNames()).toContain("Day 2");
    });
    await user.click(screen.getByRole("button", { name: "Up one level" }));
    await waitFor(() => {
      expect(rowNames()).toContain("Raw footage");
    });
  });

  it("greys a folder that belongs to a channel, cannot choose it, but can open it", async () => {
    const { user, onPick } = await setup();
    await user.click(row("Beauty Channel"));
    expect(row("Beauty Channel")).toHaveTextContent("Used by a channel");
    expect(choose()).toBeDisabled();
    expect(choose()).toHaveAttribute("title", "This folder already belongs to a channel.");
    await user.click(choose());
    expect(onPick).not.toHaveBeenCalled();
    // The folder of a channel of this very user may be looked into.
    await user.dblClick(row("Beauty Channel"));
    await waitFor(() => {
      expect(crumbs().slice(0, 2)).toEqual(["My folder", "Beauty Channel"]);
    });
    expect(choose()).toBeEnabled();
  });

  it("keeps the listing and shows the server's reason when a folder is refused", async () => {
    const { user, backend } = await setup();
    // A channel of another user lies in the footage folder.
    const strangers = backend.world.channels.find((c) => c.userId === USER_ID);
    if (!strangers) throw new Error("seed channel missing");
    strangers.dir = `${FOOTAGE_ROOT}/Interviews`;
    await user.click(place("footage"));
    await waitFor(() => {
      expect(rowNames()).toEqual(["Campaigns", "Interviews"]);
    });
    await user.dblClick(row("Interviews"));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "This folder already belongs to a channel.",
    );
    expect(rowNames()).toEqual(["Campaigns", "Interviews"]);
    expect(screen.queryByText("This folder cannot be opened")).not.toBeInTheDocument();
  });

  it("shows only the folders of the signed-in user inside the server storage", async () => {
    const { user } = await setup({}, { user: "user" });
    await user.click(place("Server storage"));
    await waitFor(() => {
      expect(rowNames()).toEqual([USER_ID]);
    });
  });

  it("types a full path, and says what is wrong with one that is not", async () => {
    const { user } = await setup();
    await user.keyboard("{Control>}l{/Control}");
    const field = await screen.findByRole("textbox", { name: "Path" });
    await user.clear(field);
    await user.type(field, `"${FOOTAGE_ROOT}/Campaigns/"{Enter}`);
    await waitFor(() => {
      expect(rowNames()).toEqual(["Spring launch", "Summer sale"]);
    });
    await user.keyboard("{Control>}l{/Control}");
    const again = await screen.findByRole("textbox", { name: "Path" });
    await user.clear(again);
    await user.type(again, "Movies{Enter}");
    expect(await screen.findByRole("status")).toHaveTextContent(
      `Type a full path, for example ${MEDIA_ROOT}.`,
    );
  });

  it("stays where it is when a typed path is outside the storage folders", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Type a path" }));
    const field = await screen.findByRole("textbox", { name: "Path" });
    await user.clear(field);
    await user.type(field, "/etc{Enter}");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "This folder is outside the storage folders the admin allows.",
    );
    expect(rowNames()).toEqual(["Beauty Channel", "Raw footage", "Tech Reviews"]);
  });
});

describe("choosing", () => {
  it("chooses the folder shown, as the server wrote its path, and closes", async () => {
    const { user, onPick } = await setup();
    await user.dblClick(row("Raw footage"));
    await waitFor(() => {
      expect(choose()).toHaveTextContent('Choose "Raw footage"');
    });
    await user.click(choose());
    expect(onPick).toHaveBeenCalledExactlyOnceWith(RAW);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("chooses a selected folder without opening it", async () => {
    const { user, onPick } = await setup({ startPath: RAW });
    await waitFor(() => {
      expect(rowNames()).toEqual(["Day 1", "Day 2", "Day 10"]);
    });
    await user.click(row("Day 2"));
    expect(choose()).toHaveTextContent('Choose "Day 2"');
    await user.click(choose());
    expect(onPick).toHaveBeenCalledExactlyOnceWith(`${RAW}/Day 2`);
  });

  it("uses the title and the button text it is given", async () => {
    const { user, onPick } = await setup({
      title: "Where are the videos?",
      confirmLabel: "Use this folder",
    });
    expect(screen.getByRole("dialog", { name: "Where are the videos?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(onPick).toHaveBeenCalledExactlyOnceWith(MINE);
  });

  it("cancels with the button, the cross and Escape, and gives the focus back", async () => {
    const { user, onPick } = await setup({ startOpen: false });
    const opener = screen.getByRole("button", { name: "Open picker" });
    for (const close of [
      () => user.click(screen.getByRole("button", { name: "Cancel" })),
      () => user.click(screen.getByRole("button", { name: "Close" })),
      () => user.keyboard("{Escape}"),
    ]) {
      await user.click(opener);
      await screen.findByRole("dialog");
      await waitFor(() => {
        expect(list()).toHaveFocus();
      });
      await close();
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
      expect(opener).toHaveFocus();
    }
    expect(onPick).not.toHaveBeenCalled();
  });

  it("starts again in the personal folder each time it opens", async () => {
    const { user } = await setup();
    await user.dblClick(row("Raw footage"));
    await waitFor(() => {
      expect(rowNames()).toContain("Day 1");
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Open picker" }));
    await waitFor(() => {
      expect(rowNames()).toEqual(["Beauty Channel", "Raw footage", "Tech Reviews"]);
    });
  });
});

describe("New folder", () => {
  it("makes a folder, opens it and chooses it", async () => {
    const { user, onPick } = await setup({ startPath: FOOTAGE_ROOT });
    await user.click(screen.getByRole("button", { name: "New folder" }));
    const field = await screen.findByRole("textbox", { name: "Folder name" });
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, "Fresh shoot{Enter}");
    await waitFor(() => {
      expect(choose()).toHaveTextContent('Choose "Fresh shoot"');
    });
    expect(screen.queryByRole("textbox", { name: "Folder name" })).not.toBeInTheDocument();
    expect(screen.getByText("There are no folders in here.")).toBeInTheDocument();
    await user.click(choose());
    expect(onPick).toHaveBeenCalledExactlyOnceWith(`${FOOTAGE_ROOT}/Fresh shoot`);
  });

  it("keeps a refused name in the field with the server's reason", async () => {
    const { user } = await setup({ startPath: FOOTAGE_ROOT });
    await user.click(screen.getByRole("button", { name: "New folder" }));
    const field = await screen.findByRole("textbox", { name: "Folder name" });
    for (const [name, reason] of [
      [".hidden", "A name cannot start with a dot."],
      ["a/b", "A name cannot contain a slash."],
      ["Interviews", "A folder with this name already exists here."],
      ["", "A name cannot be empty."],
    ] as const) {
      await user.clear(field);
      if (name !== "") await user.type(field, name);
      await user.click(screen.getByRole("button", { name: "Create" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(reason);
      expect(field).toHaveValue(name);
      expect(field).toBeInvalid();
    }
    // The listing did not change; Escape closes the field, not the dialog.
    expect(rowNames()).toEqual(["Campaigns", "Interviews"]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Folder name" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("refuses a folder inside a channel directory", async () => {
    const { user } = await setup();
    await user.dblClick(row("Beauty Channel"));
    await waitFor(() => {
      expect(crumbs()).toContain("Beauty Channel");
    });
    await user.click(screen.getByRole("button", { name: "New folder" }));
    await user.click(await screen.findByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This folder already belongs to a channel.",
    );
  });
});

describe("keyboard", () => {
  it("moves with the arrows, opens with Enter, goes up with Backspace and chooses with Enter", async () => {
    const { user, onPick } = await setup();
    await waitFor(() => {
      expect(list()).toHaveFocus();
    });
    await user.keyboard("{ArrowDown}");
    expect(row("Beauty Channel")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}");
    expect(row("Raw footage")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(rowNames()).toEqual(["Day 1", "Day 2", "Day 10"]);
    });
    await user.keyboard("{End}");
    expect(row("Day 10")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(row("Day 1")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Backspace}");
    await waitFor(() => {
      expect(rowNames()).toContain("Raw footage");
    });
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() => {
      expect(rowNames()).toContain("Day 2");
    });
    // Nothing selected: Enter chooses the folder shown.
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledExactlyOnceWith(RAW);
  });

  it("selects by typing the first letters of a name", async () => {
    const { user } = await setup({ startPath: FOOTAGE_ROOT });
    await waitFor(() => {
      expect(rowNames()).toEqual(["Campaigns", "Interviews"]);
    });
    await user.keyboard("in");
    expect(row("Interviews")).toHaveAttribute("aria-selected", "true");
    expect(choose()).toHaveTextContent('Choose "Interviews"');
  });

  it("cannot choose a folder of a channel with Enter, it opens it", async () => {
    const { user, onPick } = await setup();
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => {
      expect(crumbs()).toContain("Beauty Channel");
    });
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("a listing that fails", () => {
  it("shows the server's reason and recovers with Try again", async () => {
    const { user, hooks } = await setup();
    hooks.fsList = () => Promise.reject(new ApiError("io", "The server cannot read this folder."));
    await user.dblClick(row("Raw footage"));
    expect(await screen.findByText("This folder cannot be opened")).toBeInTheDocument();
    expect(screen.getByText("The server cannot read this folder.")).toBeInTheDocument();
    expect(choose()).toBeDisabled();
    delete hooks.fsList;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(rowNames()).toEqual(["Day 1", "Day 2", "Day 10"]);
    });
    expect(screen.queryByText("This folder cannot be opened")).not.toBeInTheDocument();
    expect(choose()).toBeEnabled();
  });

  it("can leave a failed folder through the places", async () => {
    const { user, hooks } = await setup();
    hooks.fsList = () => Promise.reject(new ApiError("io", "Broken."));
    await user.dblClick(row("Raw footage"));
    expect(await screen.findByText("Broken.")).toBeInTheDocument();
    delete hooks.fsList;
    await user.click(place("footage"));
    await waitFor(() => {
      expect(rowNames()).toEqual(["Campaigns", "Interviews"]);
    });
  });

  it("shows the nearest folder that still exists, and says so, when the start folder vanished", async () => {
    await setup({ startPath: `${FOOTAGE_ROOT}/Campaigns/Gone/Deeper` });
    await waitFor(() => {
      expect(rowNames()).toEqual(["Spring launch", "Summer sale"]);
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      '"Gone" does not exist any more. Showing "Campaigns" instead.',
    );
  });

  it("falls back to the personal folder when the start folder is not allowed", async () => {
    await setup({ startPath: "/etc/secret" });
    await waitFor(() => {
      expect(rowNames()).toEqual(["Beauty Channel", "Raw footage", "Tech Reviews"]);
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      'This folder is outside the storage folders the admin allows. Showing "My folder" instead.',
    );
  });

  it("drops an answer that arrives after a newer navigation", async () => {
    const { user, backend, hooks } = await setup({ startPath: RAW });
    await waitFor(() => {
      expect(rowNames()).toEqual(["Day 1", "Day 2", "Day 10"]);
    });
    const real = backend.fsList;
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    hooks.fsList = async (input) => {
      if (input?.path?.endsWith("Day 1")) await slow;
      return real(input);
    };
    await user.dblClick(row("Day 1"));
    await user.dblClick(row("Day 2"));
    await waitFor(() => {
      expect(choose()).toHaveTextContent('Choose "Day 2"');
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(choose()).toHaveTextContent('Choose "Day 2"');
  });
});

describe("a long folder", () => {
  it("renders only the rows in view and still reaches the last one by keyboard", async () => {
    const { user, backend } = await setup({ startPath: FOOTAGE_ROOT });
    const parent = `${FOOTAGE_ROOT}/Interviews`;
    for (let i = 1; i <= 3000; i++) {
      const name = `Take ${String(i)}`;
      backend.world.fs.push({ path: `${parent}/${name}`, name, videoCount: 0, children: [] });
    }
    await waitFor(() => {
      expect(rowNames()).toEqual(["Campaigns", "Interviews"]);
    });
    await user.dblClick(row("Interviews"));
    await waitFor(() => {
      expect(within(list()).getAllByRole("option").length).toBeGreaterThan(10);
    });
    expect(within(list()).getAllByRole("option").length).toBeLessThan(200);
    await user.keyboard("{End}");
    const selected = within(list()).getByRole("option", { selected: true });
    expect(selected).toHaveAttribute("aria-posinset", "3000");
    expect(selected).toHaveAttribute("aria-setsize", "3000");
    expect(within(list()).getAllByRole("option").length).toBeLessThan(200);
  });
});

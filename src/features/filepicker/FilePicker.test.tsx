/**
 * The admin's in-page folder picker, against the mock server's whole file system: places (home, a
 * drive, volumes, one of them not reachable), browsing above the home folder, folders that cannot
 * become a channel (greyed, with the reason), New Folder, the keyboard, choosing and cancelling, a
 * listing that fails and recovers, a vanished start folder and a very long folder.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { AppEnvContext } from "@/lib/appEnv";
import type { Api } from "@/lib/api";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";
import { DATA_DIR, HOME, SSD, makeVolumeUnavailable } from "@/lib/mock/seed/storage";
import { setupApp, type SetupOptions } from "@/test/app";
import { FolderPickerDialog, type FolderPickerDialogProps } from "./index";

const MOVIES = `${HOME}/Movies`;
const HOME_FOLDERS = ["Desktop", "Documents", "Downloads", "Footage", "Movies", "VidAI Data"];
const TAKEN_HINT = "Belongs to a channel or to VidAI's own data.";

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
  within(list()).getByRole("option", { name: new RegExp(`^${name}(In use)?$`) });
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
  it("lists home first, then the drive and the volumes, and opens in the home folder", async () => {
    await setup();
    const places = within(screen.getByRole("navigation", { name: "Places" })).getAllByRole(
      "button",
    );
    expect(places.map((button) => button.textContent)).toEqual([
      "Home",
      "Macintosh HD",
      "Footage SSD",
      "Backup NASNot reachable",
    ]);
    expect(place("Home")).toHaveAttribute("aria-current", "true");
    expect(place("Macintosh HD")).not.toHaveAttribute("aria-current");
    // The path starts at the top of the drive: nothing above the home folder is hidden.
    expect(crumbs().slice(0, 3)).toEqual(["Macintosh HD", "Users", "vidai"]);
    expect(rowNames()).toEqual(HOME_FOLDERS);
  });

  it("opens a volume from its place, whose top has no folder above", async () => {
    const { user, ready } = await setup();
    await user.click(place("Footage SSD"));
    await ready();
    await waitFor(() => {
      expect(rowNames()).toContain("Client Shoots");
    });
    expect(place("Footage SSD")).toHaveAttribute("aria-current", "true");
    expect(place("Home")).not.toHaveAttribute("aria-current");
    expect(crumbs().slice(0, 1)).toEqual(["Footage SSD"]);
    expect(screen.getByRole("button", { name: "Up one level" })).toBeDisabled();
    // A hidden folder is not listed.
    expect(rowNames()).not.toContain(".Trashes");
  });

  it("opens the drive's top, which holds the system folders", async () => {
    const { user, ready } = await setup();
    await user.click(place("Macintosh HD"));
    await ready();
    await waitFor(() => {
      expect(rowNames()).toContain("Applications");
    });
    expect(rowNames()).toContain("Volumes");
    expect(screen.getByRole("button", { name: "Up one level" })).toBeDisabled();
  });

  it("shows a volume that cannot be reached greyed, and says so when it is clicked", async () => {
    const { user } = await setup();
    const nas = place("Backup NAS");
    expect(nas).toHaveAttribute("aria-disabled", "true");
    expect(nas).toHaveAttribute("title", "Backup NAS cannot be reached right now.");
    await user.click(nas);
    expect(await screen.findByRole("status")).toHaveTextContent(
      '"Backup NAS" cannot be reached right now. Check that the drive is connected.',
    );
    // Nothing changed.
    expect(rowNames()).toEqual(HOME_FOLDERS);
    expect(place("Footage SSD")).not.toHaveAttribute("aria-disabled");
  });

  it("greys a volume that is unplugged after the picker was built", async () => {
    await setup({}, { prepare: (b) => makeVolumeUnavailable(b.world, SSD) });
    expect(place("Footage SSD")).toHaveAttribute("aria-disabled", "true");
  });
});

describe("browsing", () => {
  it("opens a folder with a double click and goes up through the path and the Up button", async () => {
    const { user, ready } = await setup();
    await user.dblClick(row("Movies"));
    await waitFor(() => {
      expect(rowNames()).toEqual(["Holiday clips"]);
    });
    expect(crumbs().slice(0, 4)).toEqual(["Macintosh HD", "Users", "vidai", "Movies"]);
    await user.dblClick(row("Holiday clips"));
    await waitFor(() => {
      expect(screen.getByText("6 video files in this folder")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Up one level" }));
    await waitFor(() => {
      expect(rowNames()).toEqual(["Holiday clips"]);
    });
    await user.click(
      within(screen.getByRole("navigation", { name: "Path" })).getByRole("button", {
        name: "vidai",
      }),
    );
    await ready();
    await waitFor(() => {
      expect(rowNames()).toEqual(HOME_FOLDERS);
    });
  });

  it("goes above the home folder", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Up one level" }));
    await waitFor(() => {
      expect(rowNames()).toContain("vidai");
    });
    expect(place("Macintosh HD")).toHaveAttribute("aria-current", "true");
  });

  it("greys the folders that cannot become a channel and says why, but opens them", async () => {
    const { user, onPick } = await setup();
    // A folder that holds channel directories, and VidAI's own data.
    for (const name of ["Footage", "VidAI Data"]) {
      expect(row(name)).toHaveTextContent("In use");
      expect(row(name)).toHaveAttribute("title", `${name} - ${TAKEN_HINT}`);
    }
    expect(row("Movies")).not.toHaveTextContent("In use");
    await user.click(row("Footage"));
    expect(choose()).toBeDisabled();
    expect(choose()).toHaveAttribute("title", TAKEN_HINT);
    expect(screen.getByRole("status")).toHaveTextContent(TAKEN_HINT);
    await user.click(choose());
    expect(onPick).not.toHaveBeenCalled();
    // Footage holds the folders of two channels (taken) and folders that are free.
    await user.dblClick(row("Footage"));
    await waitFor(() => {
      expect(rowNames()).toContain("Interviews");
    });
    expect(rowNames()).toEqual(
      expect.arrayContaining(["Tech Reviews", "Travel Diary", "Interviews"]),
    );
    expect(row("Tech Reviews")).toHaveTextContent("In use");
    expect(row("Interviews")).not.toHaveTextContent("In use");
    // The folder shown is taken too, so it is not offered; a free one inside is.
    expect(choose()).toBeDisabled();
    await user.click(row("Interviews"));
    expect(choose()).toBeEnabled();
    expect(choose()).toHaveTextContent('Choose "Interviews"');
  });

  it("does not let a data folder be chosen", async () => {
    const { user, onPick } = await setup({ startPath: DATA_DIR });
    await waitFor(() => {
      expect(crumbs()).toContain("VidAI Data");
    });
    expect(rowNames()).toEqual(["projects"]);
    expect(row("projects")).toHaveTextContent("In use");
    await user.click(row("projects"));
    expect(choose()).toBeDisabled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("keeps the listing and shows the server's reason when a folder is refused", async () => {
    const { user, hooks } = await setup();
    hooks.fsList = () => Promise.reject(new ApiError("forbidden", "Only an admin can do this."));
    await user.dblClick(row("Movies"));
    expect(await screen.findByRole("status")).toHaveTextContent("Only an admin can do this.");
    expect(rowNames()).toEqual(HOME_FOLDERS);
    expect(screen.queryByText("This folder cannot be opened")).not.toBeInTheDocument();
  });

  it("types a full path, and says what is wrong with one that is not", async () => {
    const { user } = await setup();
    await user.keyboard("{Control>}l{/Control}");
    const field = await screen.findByRole("textbox", { name: "Path" });
    await user.clear(field);
    await user.type(field, `"${SSD}/Client Shoots/"{Enter}`);
    await waitFor(() => {
      expect(rowNames()).toEqual(["Spring launch", "Summer sale"]);
    });
    await user.keyboard("{Control>}l{/Control}");
    const again = await screen.findByRole("textbox", { name: "Path" });
    await user.clear(again);
    await user.type(again, "Movies{Enter}");
    expect(await screen.findByRole("status")).toHaveTextContent(
      `Type a full path, for example ${HOME}.`,
    );
  });

  it("goes anywhere on the file system by a typed path", async () => {
    const { user } = await setup();
    await user.click(screen.getByRole("button", { name: "Type a path" }));
    const field = await screen.findByRole("textbox", { name: "Path" });
    await user.clear(field);
    await user.type(field, "/Applications{Enter}");
    await waitFor(() => {
      expect(crumbs()).toContain("Applications");
    });
    expect(place("Macintosh HD")).toHaveAttribute("aria-current", "true");
  });
});

describe("choosing", () => {
  it("chooses the folder shown, as the server wrote its path, and closes", async () => {
    const { user, onPick } = await setup();
    await user.dblClick(row("Movies"));
    await waitFor(() => {
      expect(choose()).toHaveTextContent('Choose "Movies"');
    });
    await user.click(choose());
    expect(onPick).toHaveBeenCalledExactlyOnceWith(MOVIES);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("chooses a selected folder without opening it", async () => {
    const { user, onPick } = await setup({ startPath: MOVIES });
    await waitFor(() => {
      expect(rowNames()).toEqual(["Holiday clips"]);
    });
    await user.click(row("Holiday clips"));
    expect(choose()).toHaveTextContent('Choose "Holiday clips"');
    await user.click(choose());
    expect(onPick).toHaveBeenCalledExactlyOnceWith(`${MOVIES}/Holiday clips`);
  });

  it("uses the title and the button text it is given", async () => {
    const { user, onPick } = await setup({
      title: "Where are the videos?",
      confirmLabel: "Use this folder",
      startPath: MOVIES,
    });
    expect(screen.getByRole("dialog", { name: "Where are the videos?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(onPick).toHaveBeenCalledExactlyOnceWith(MOVIES);
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

  it("starts again in the home folder each time it opens", async () => {
    const { user } = await setup();
    await user.dblClick(row("Movies"));
    await waitFor(() => {
      expect(rowNames()).toEqual(["Holiday clips"]);
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "Open picker" }));
    await waitFor(() => {
      expect(rowNames()).toEqual(HOME_FOLDERS);
    });
  });
});

describe("New Folder", () => {
  it("makes a folder, opens it and chooses it", async () => {
    const { user, onPick } = await setup({ startPath: MOVIES });
    await user.click(screen.getByRole("button", { name: "New Folder" }));
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
    expect(onPick).toHaveBeenCalledExactlyOnceWith(`${MOVIES}/Fresh shoot`);
  });

  it("makes a folder on an external volume", async () => {
    const { user, onPick } = await setup({ startPath: `${SSD}/Spare` });
    await user.click(screen.getByRole("button", { name: "New Folder" }));
    const field = await screen.findByRole("textbox", { name: "Folder name" });
    await user.clear(field);
    await user.type(field, "Cooking{Enter}");
    await waitFor(() => {
      expect(choose()).toHaveTextContent('Choose "Cooking"');
    });
    await user.click(choose());
    expect(onPick).toHaveBeenCalledExactlyOnceWith(`${SSD}/Spare/Cooking`);
  });

  it("keeps a refused name in the field with the server's reason", async () => {
    const { user } = await setup({ startPath: MOVIES });
    await user.click(screen.getByRole("button", { name: "New Folder" }));
    const field = await screen.findByRole("textbox", { name: "Folder name" });
    for (const [name, reason] of [
      [".hidden", "A name cannot start with a dot."],
      ["a/b", "A name cannot contain a slash."],
      ["Holiday clips", "A folder with this name already exists here."],
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
    expect(rowNames()).toEqual(["Holiday clips"]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Folder name" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("keyboard", () => {
  it("moves with the arrows, opens with Enter, goes up with Backspace and chooses with Enter", async () => {
    const { user, onPick } = await setup({ startPath: `${HOME}/Footage` });
    await waitFor(() => {
      expect(list()).toHaveFocus();
    });
    await waitFor(() => {
      expect(rowNames()).toContain("Archive 2024");
    });
    await user.keyboard("{ArrowDown}");
    expect(row("Archive 2024")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}");
    expect(row("Archive 2025")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(row("Travel Diary")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}{ArrowDown}{ArrowDown}");
    expect(row("Interviews")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(crumbs()).toContain("Interviews");
    });
    await user.keyboard("{Backspace}");
    await waitFor(() => {
      expect(rowNames()).toContain("Archive 2024");
    });
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() => {
      expect(crumbs()).toContain("Interviews");
    });
    // Nothing selected: Enter chooses the folder shown.
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledExactlyOnceWith(`${HOME}/Footage/Interviews`);
  });

  it("selects by typing the first letters of a name", async () => {
    const { user } = await setup();
    await user.keyboard("mo");
    expect(row("Movies")).toHaveAttribute("aria-selected", "true");
    expect(choose()).toHaveTextContent('Choose "Movies"');
  });

  it("cannot choose a taken folder with Enter, it opens it", async () => {
    const { user, onPick } = await setup();
    await user.keyboard("fo{Enter}");
    await waitFor(() => {
      expect(crumbs()).toContain("Footage");
    });
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe("a listing that fails", () => {
  it("shows the server's reason and recovers with Try Again", async () => {
    const { user, hooks } = await setup();
    hooks.fsList = () => Promise.reject(new ApiError("io", "The server cannot read this folder."));
    await user.dblClick(row("Movies"));
    expect(await screen.findByText("This folder cannot be opened")).toBeInTheDocument();
    expect(screen.getByText("The server cannot read this folder.")).toBeInTheDocument();
    expect(choose()).toBeDisabled();
    delete hooks.fsList;
    await user.click(screen.getByRole("button", { name: "Try Again" }));
    await waitFor(() => {
      expect(rowNames()).toEqual(["Holiday clips"]);
    });
    expect(screen.queryByText("This folder cannot be opened")).not.toBeInTheDocument();
    expect(choose()).toBeEnabled();
  });

  it("can leave a failed folder through the places", async () => {
    const { user, hooks } = await setup();
    hooks.fsList = () => Promise.reject(new ApiError("io", "Broken."));
    await user.dblClick(row("Movies"));
    expect(await screen.findByText("Broken.")).toBeInTheDocument();
    delete hooks.fsList;
    await user.click(place("Footage SSD"));
    await waitFor(() => {
      expect(rowNames()).toContain("Client Shoots");
    });
  });

  it("shows the nearest folder that still exists, and says so, when the start folder vanished", async () => {
    await setup({ startPath: `${SSD}/Client Shoots/Gone/Deeper` });
    await waitFor(() => {
      expect(rowNames()).toEqual(["Spring launch", "Summer sale"]);
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      '"Gone" does not exist any more. Showing "Client Shoots" instead.',
    );
  });

  it("shows the nearest folder above when the start folder lies on an unplugged volume", async () => {
    await setup({ startPath: "/Volumes/Backup NAS/Retro Games" });
    await waitFor(() => {
      expect(rowNames()).toContain("Footage SSD");
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      '"Backup NAS" does not exist any more. Showing "Volumes" instead.',
    );
  });

  it("falls back to the home folder when the start folder is not an absolute path", async () => {
    await setup({ startPath: "relative/path" });
    await waitFor(() => {
      expect(rowNames()).toEqual(HOME_FOLDERS);
    });
    expect(await screen.findByRole("status")).toHaveTextContent('Showing "Home" instead.');
  });

  it("drops an answer that arrives after a newer navigation", async () => {
    const { user, backend, hooks } = await setup({ startPath: `${HOME}/Footage` });
    await waitFor(() => {
      expect(rowNames()).toContain("Archive 2024");
    });
    const real = backend.fsList;
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    hooks.fsList = async (input) => {
      if (input?.path?.endsWith("Archive 2024")) await slow;
      return real(input);
    };
    await user.dblClick(row("Archive 2024"));
    await user.dblClick(row("Archive 2025"));
    await waitFor(() => {
      expect(choose()).toHaveTextContent('Choose "Archive 2025"');
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(choose()).toHaveTextContent('Choose "Archive 2025"');
  });
});

describe("a long folder", () => {
  it("renders only the rows in view and still reaches the last one by keyboard", async () => {
    const { user, backend } = await setup({ startPath: `${HOME}/Footage` });
    const parent = `${HOME}/Footage/Interviews`;
    for (let i = 1; i <= 3000; i++) {
      const name = `Take ${String(i)}`;
      backend.world.fs.push({ path: `${parent}/${name}`, name, videoCount: 0 });
    }
    await waitFor(() => {
      expect(rowNames()).toContain("Interviews");
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

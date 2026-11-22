// What only the web picker has to cope with (SPEC section 12, `POST /api/fs/list`): a folder the
// server cannot read shows the server's message and the dialog still navigates, a symlinked
// folder opens (and a broken link is not listed), and typing the path of a file selects that file
// (a name that is not there says so). The vehicle is Settings, Import / Export, Import (file mode)
// and Settings, General, Change (folder mode).
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { listed, openSettings, picker, settingsOnDisk, typePath } from "../setups.mjs";
import { row } from "../ui.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "picker-web",
  title: "Picker: unreadable folder, symlinked folder, a typed file path",
  timeout: 120_000,
  async run(t) {
    await t.seedLibrary([[VIDEO, "landscape"]]);
    const places = path.join(t.dir, "places");
    const real = path.join(places, "real");
    const locked = path.join(places, "locked");
    await mkdir(path.join(real, "Deep"), { recursive: true });
    await mkdir(locked, { recursive: true });
    await writeFile(
      path.join(real, "Team.json"),
      JSON.stringify({ format: "vidai-settings", version: 2 }),
    );
    await writeFile(path.join(real, "readme.txt"), "x");
    await symlink(real, path.join(places, "link-to-real"));
    await symlink(path.join(places, "nothing-here"), path.join(places, "broken-link"));
    await chmod(locked, 0o000);
    // Listing the locked folder is a 400 of the server, expected here (the dialog shows it in words).
    t.allowFailure(/api\/fs\/list/);
    try {
      const server = await t.startServer();
      const page = await t.open(server);
      await row(page, VIDEO).waitFor({ timeout: 30_000 });

      // --- An unreadable folder (folder mode, Settings, General) ----------------------------
      await openSettings(page, "General");
      await page.getByRole("button", { name: "Change…" }).click();
      let dialog = await picker(page, "Choose the Editing Folder");
      await typePath(page, dialog, places);
      await t.waitFor(async () => (await listed(dialog)).includes("locked"), "the places folder");
      const names = await listed(dialog);
      t.equal(
        [...names].sort(),
        ["link-to-real", "locked", "real"],
        "the folders listed (the broken link is not one of them)",
      );
      // Open the locked folder like a user does: double click.
      await dialog.getByRole("option", { name: "locked", exact: true }).dblclick();
      await dialog.getByText("This folder cannot be opened").waitFor();
      const message = dialog.locator("p", { hasText: "locked" }).last();
      t.assert(
        (await message.innerText()).includes("locked"),
        "the server's message names the folder",
      );
      t.assert(
        await dialog.getByRole("button", { name: 'Choose "locked"' }).isDisabled(),
        "an unreadable folder cannot be chosen",
      );
      await t.shot(page, "picker-unreadable");
      // Navigation still works: the breadcrumb of the folder above, then a folder below it.
      await dialog
        .getByRole("navigation", { name: "Path" })
        .getByRole("button", { name: "places", exact: true })
        .click();
      await dialog.getByText("This folder cannot be opened").waitFor({ state: "detached" });
      await dialog.getByRole("button", { name: 'Choose "places"' }).waitFor();
      t.assert(
        await dialog.getByRole("button", { name: 'Choose "places"' }).isEnabled(),
        "the folder above can be chosen again",
      );
      // Up works from an unreadable folder too.
      await dialog.getByRole("option", { name: "locked", exact: true }).dblclick();
      await dialog.getByText("This folder cannot be opened").waitFor();
      await dialog.getByRole("button", { name: "Enclosing Folder" }).click();
      await dialog.getByText("This folder cannot be opened").waitFor({ state: "detached" });

      // --- A symlinked folder opens ---------------------------------------------------------
      await dialog.getByRole("option", { name: "link-to-real", exact: true }).dblclick();
      await t.waitFor(async () => (await listed(dialog)).includes("Deep"), "the linked folder");
      t.equal(
        [...(await listed(dialog))].sort(),
        ["Deep", "Team.json", "readme.txt"],
        "the linked folder lists what the real folder holds",
      );
      t.equal(
        await dialog
          .getByRole("option", { name: "Team.json", exact: true })
          .getAttribute("aria-disabled"),
        "true",
        "a file is dimmed in folder mode",
      );
      await dialog.getByRole("button", { name: 'Choose "link-to-real"' }).waitFor();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "detached" });
      t.equal((await settingsOnDisk(t)).editingFolder, t.editing, "nothing was chosen");
      await page.getByRole("button", { name: "Done", exact: true }).click();

      // --- A typed file path selects the file (file mode, Import) ---------------------------
      await openSettings(page, "Import / Export");
      await page.getByRole("button", { name: "Import…" }).click();
      dialog = await picker(page, "Import VidAI Settings");
      await typePath(page, dialog, path.join(real, "Team.json"));
      await t.waitFor(
        async () => (await listed(dialog)).includes("Team.json"),
        "the file's folder",
      );
      const file = dialog.getByRole("option", { name: "Team.json", exact: true });
      t.equal(await file.getAttribute("aria-selected"), "true", "the typed file is selected");
      t.assert(
        await dialog.getByRole("button", { name: "Choose", exact: true }).isEnabled(),
        "Choose is enabled for the typed file",
      );
      await t.shot(page, "picker-typed-file");
      // A name that is not in the folder: its nearest existing folder is shown, and it says so.
      await typePath(page, dialog, path.join(real, "missing.json"));
      await dialog.getByText('Nothing named "missing.json" in this folder.').waitFor();
      t.assert(
        (await dialog
          .getByRole("option", { name: "Team.json", exact: true })
          .getAttribute("aria-selected")) !== "true",
        "nothing is selected for a missing name",
      );
      // A path through a symlink to a file in the linked folder is a file as well.
      await typePath(page, dialog, path.join(places, "link-to-real", "Team.json"));
      await t.waitFor(
        async () =>
          (await dialog
            .getByRole("option", { name: "Team.json", exact: true })
            .getAttribute("aria-selected")) === "true",
        "the file typed through the link to be selected",
      );
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "detached" });
    } finally {
      await chmod(locked, 0o755);
    }
  },
};

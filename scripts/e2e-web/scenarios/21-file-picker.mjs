// The in-page file picker in its three uses (SPEC section 12, What runs where), the way the app
// uses it: Settings, General changes the Editing Folder (folder mode: Cancel leaves it, a choice
// takes it); Export saves the settings file (save mode: a typed name gets its extension, an
// existing file asks "Replace it?" and Don't Replace leaves the file as it was); Import chooses a
// file (file mode: the filter dims other files, a file that is not a settings file is refused in
// the page's own words). Every result is checked on disk.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CHANNEL } from "../../e2e/library.mjs";
import { listed, openSettings, picker, settingsOnDisk, typePath } from "../setups.mjs";
import { row } from "../ui.mjs";

const VIDEO = "001 Landscape Clip";
const OTHER = "050 Other Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "file-picker",
  title:
    "Folder, save (Replace it?) and file mode of the in-page picker: Editing Folder, export, import",
  timeout: 150_000,
  async run(t) {
    await t.seedLibrary([[VIDEO, "landscape"]]);
    // A second Editing Folder next to the first, with its own video.
    const second = path.join(t.dir, "Editing2");
    await mkdir(path.join(second, CHANNEL, OTHER), { recursive: true });
    await copyFile(
      path.join(t.dir, "..", "media", "landscape.mp4"),
      path.join(second, CHANNEL, OTHER, "A-roll.mp4"),
    );
    // The folder the settings file goes to: an old file to be replaced, other files.
    const exports = path.join(t.dir, "exports");
    await mkdir(exports, { recursive: true });
    await writeFile(path.join(exports, "VidAI Settings.json"), "OLD");
    await writeFile(path.join(exports, "notes.txt"), "not a settings file");
    await writeFile(path.join(exports, "bad.json"), "{}");
    const incoming = {
      format: "vidai-settings",
      version: 2,
      exportedAt: "2026-11-20T10:00:00.000Z",
      channels: [
        {
          folderName: CHANNEL,
          videoType: "auto",
          long: { prompts: [{ name: "Default", text: "IMPORTED LONG PROMPT" }], styles: [] },
          short: { prompts: [], styles: [] },
        },
        { folderName: "Imported Channel", videoType: "short", long: {}, short: {} },
      ],
    };
    await writeFile(path.join(exports, "Incoming.json"), JSON.stringify(incoming, null, 2));

    const server = await t.startServer();
    const page = await t.open(server);
    await row(page, VIDEO).waitFor({ timeout: 30_000 });

    // --- Folder mode: the Editing Folder -----------------------------------------------------
    await openSettings(page, "General");
    await page.getByRole("button", { name: "Change…" }).click();
    let dialog = await picker(page, "Choose the Editing Folder");
    // It opens in the current Editing Folder, whose own name is the button of the folder.
    await dialog.getByRole("button", { name: 'Choose "Editing"' }).waitFor();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "detached" });
    t.equal((await settingsOnDisk(t)).editingFolder, t.editing, "Cancel leaves the Editing Folder");

    await page.getByRole("button", { name: "Change…" }).click();
    dialog = await picker(page, "Choose the Editing Folder");
    await dialog.getByRole("button", { name: "Enclosing Folder" }).click();
    const names = await t.waitFor(async () => {
      const found = await listed(dialog);
      return found.includes("Editing2") ? found : null;
    }, "the folder next to the Editing Folder");
    t.assert(names.includes("Editing") && names.includes("exports"), `listed: ${names.join(", ")}`);
    // Folders only: the files of this folder are not offered (the files are dimmed or absent).
    await dialog.getByRole("option", { name: "Editing2", exact: true }).click();
    await t.shot(page, "folder-mode-selected");
    await dialog.getByRole("button", { name: 'Choose "Editing2"' }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByText("Editing Folder changed").first().waitFor();
    t.equal((await settingsOnDisk(t)).editingFolder, second, "the Editing Folder on disk");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await row(page, OTHER).waitFor({ timeout: 30_000 });
    t.equal(await row(page, VIDEO).count(), 0, "the old Editing Folder's video is gone");

    // --- Save mode: Export ---------------------------------------------------------------------
    await openSettings(page, "Import / Export");
    await page.getByRole("button", { name: "Export…" }).click();
    dialog = await picker(page, "Export VidAI Settings");
    const nameField = dialog.getByRole("textbox", { name: /^File [Nn]ame$/ });
    t.equal(await nameField.inputValue(), "VidAI Settings.json", "the suggested file name");
    await typePath(page, dialog, exports);
    await t.waitFor(
      async () => (await listed(dialog)).includes("VidAI Settings.json"),
      "the folder for the file",
    );
    // The filter dims the files that are not settings files; choosing one does nothing.
    t.equal(
      await dialog
        .getByRole("option", { name: "notes.txt", exact: true })
        .getAttribute("aria-disabled"),
      "true",
      "notes.txt is dimmed by the .json filter",
    );
    // The file already exists: Save asks, Don't Replace keeps it and the dialog.
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    const question = dialog.getByRole("alert").filter({ hasText: "Replace it?" });
    await question.waitFor();
    t.assert(
      (await question.innerText()).includes('"VidAI Settings.json" already exists'),
      "the question names the file",
    );
    await t.shot(page, "save-replace-question");
    await dialog.getByRole("button", { name: "Don't Replace" }).click();
    await question.waitFor({ state: "detached" });
    t.equal(await readFile(path.join(exports, "VidAI Settings.json"), "utf8"), "OLD", "kept");
    // Save again and Replace: the file is the settings file now.
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.getByRole("button", { name: "Replace", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByText("Settings exported").first().waitFor();
    const exported = JSON.parse(await readFile(path.join(exports, "VidAI Settings.json"), "utf8"));
    t.equal(exported.format, "vidai-settings", "the exported file's format");
    t.equal(
      exported.channels.map((/** @type {{ folderName: string }} */ c) => c.folderName),
      [CHANNEL],
      "the exported channels",
    );
    // A name typed without an extension gets the filter's; a new name does not ask anything.
    await page.getByRole("button", { name: "Export…" }).click();
    dialog = await picker(page, "Export VidAI Settings");
    await typePath(page, dialog, exports);
    await t.waitFor(async () => (await listed(dialog)).includes("notes.txt"), "the folder");
    const field = dialog.getByRole("textbox", { name: /^File [Nn]ame$/ });
    await field.fill("team");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached" });
    await t.waitFor(async () => {
      try {
        return JSON.parse(await readFile(path.join(exports, "team.json"), "utf8")).format;
      } catch {
        return null;
      }
    }, "team.json to be written");

    // --- File mode: Import -------------------------------------------------------------------
    // The refused import is a 400 of the server, expected here (the page shows it in words).
    t.allowFailure(/api\/invoke\/import_settings/);
    const before = (await settingsOnDisk(t)).channels.length;
    await page.getByRole("button", { name: "Import…" }).click();
    dialog = await picker(page, "Import VidAI Settings");
    await typePath(page, dialog, exports);
    await t.waitFor(async () => (await listed(dialog)).includes("Incoming.json"), "the folder");
    await dialog.getByText("VidAI settings: .json").waitFor();
    const choose = dialog.getByRole("button", { name: "Choose", exact: true });
    t.assert(await choose.isDisabled(), "Choose is disabled with nothing selected");
    // A click on a dimmed file does nothing (Playwright needs force to click what is aria-disabled).
    await dialog.getByRole("option", { name: "notes.txt", exact: true }).click({ force: true });
    t.assert(await choose.isDisabled(), "a dimmed file cannot be chosen");
    await dialog.getByRole("option", { name: "bad.json", exact: true }).click();
    await t.shot(page, "file-mode-selected");
    await choose.click();
    await dialog.waitFor({ state: "detached" });
    // A file that is not a settings file is refused in words, nothing changes.
    await page.getByText("The settings were not imported").first().waitFor();
    await page.getByText("This file is not a VidAI settings file.").first().waitFor();
    t.equal((await settingsOnDisk(t)).channels.length, before, "a refused import changes nothing");

    await page.getByRole("button", { name: "Import…" }).click();
    dialog = await picker(page, "Import VidAI Settings");
    await typePath(page, dialog, exports);
    await t.waitFor(async () => (await listed(dialog)).includes("Incoming.json"), "the folder");
    // Double click chooses a file at once.
    await dialog.getByRole("option", { name: "Incoming.json", exact: true }).dblclick();
    await dialog.waitFor({ state: "detached" });
    await page.getByText("Settings imported").first().waitFor();
    await page.getByText("1 channel added").first().waitFor();
    const settings = await settingsOnDisk(t);
    const channels = settings.channels.map(
      (/** @type {{ folderName: string }} */ c) => c.folderName,
    );
    t.equal(channels, [CHANNEL, "Imported Channel"], "the channels after the import");
    t.equal(
      settings.channels[0].long.prompts[0].text,
      "IMPORTED LONG PROMPT",
      "the imported prompt",
    );
    t.equal(settings.editingFolder, second, "the Editing Folder does not travel");
    await t.shot(page, "after-import");
  },
};

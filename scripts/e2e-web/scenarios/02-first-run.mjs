// First run in the browser: a fresh data directory, the onboarding walked like a user, the Editing
// Folder chosen in the page's own file picker (SPEC section 12, What runs where; no native dialog
// exists for a background server), the channels added, the library with its Long / Short badges.
import { existsSync } from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "first-run",
  title: "Onboarding with the in-page folder picker, toolkit, channels, library",
  async run(t) {
    await t.video("Tech Reviews", "001 Landscape Clip", "landscape");
    await t.video("Tech Reviews", "002 Portrait Clip", "portrait");
    await t.video("Tech Reviews", "003 Rotated Clip", "rotated");
    await t.video("Glow Naturals", "018 Hair Oil Review", "landscape");
    const server = await t.startServer();
    const page = await t.open(server);

    // Step 1 asks how VidAI should run edits (when the stored setup is not ready; with the fake
    // Claude Code it already is and the step is done). This takes Claude Code with the Claude
    // subscription, whichever step comes first.
    const choice = page.getByRole("radiogroup", { name: "How should VidAI run edits?" });
    const folderStep = page.getByText("Choose your Editing Folder");
    await choice.or(folderStep).first().waitFor({ timeout: 30_000 });
    if (await choice.isVisible()) {
      await t.shot(page, "onboarding-choice");
      await page.getByRole("radio", { name: "Claude Code with Claude Subscription" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
    }
    await folderStep.waitFor({ timeout: 30_000 });
    await t.shot(page, "onboarding-editing-folder");

    // The folder picker is a dialog of the page.
    await page.getByRole("button", { name: "Choose Folder" }).click();
    const picker = page.getByRole("dialog", { name: "Choose the Editing Folder" });
    await picker.waitFor();
    await picker.getByRole("navigation", { name: "Places" }).getByText("Home").waitFor();
    await t.shot(page, "folder-picker-home");

    // Go to the folder that holds the Editing Folder by typing its path, as a user may.
    await picker.getByRole("button", { name: "Go to Folder" }).click();
    await picker.getByRole("textbox", { name: "Path" }).fill(t.dir);
    await page.keyboard.press("Enter");
    const list = picker.getByRole("listbox");
    await list.getByRole("option", { name: "Editing" }).waitFor();
    for (const hidden of ["data", "fake", "shots"]) {
      // The scenario's other folders are there too; only the Editing Folder is the one to take.
      await list.getByRole("option", { name: hidden, exact: true }).waitFor();
    }

    // New Folder makes a real folder on disk (the one route of the server that writes anything).
    await picker.getByRole("button", { name: "New Folder" }).click();
    await picker.getByRole("textbox", { name: "Folder name" }).fill("Scratch");
    await page.keyboard.press("Enter");
    // The new folder is opened (it is empty), as in the Mac's own panel.
    await picker.getByRole("button", { name: 'Choose "Scratch"' }).waitFor();
    await picker.getByText("This folder is empty.").waitFor();
    t.assert(existsSync(path.join(t.dir, "Scratch")), "New Folder made the folder on disk");
    await t.shot(page, "folder-picker-new-folder");
    await picker.getByRole("button", { name: "Enclosing Folder" }).click();
    await list.getByRole("option", { name: "Scratch" }).waitFor();

    // Select the Editing Folder and choose it.
    await list.getByRole("option", { name: "Editing" }).click();
    await picker.getByRole("button", { name: 'Choose "Editing"' }).click();
    await picker.waitFor({ state: "detached" });

    // The toolkit was seeded and the channels step lists the channel folders.
    await page.getByText("Add your channels").waitFor({ timeout: 30_000 });
    await page.getByText("Toolkit ready.").waitFor();
    await page.getByRole("checkbox", { name: "Tech Reviews" }).waitFor();
    await page.getByRole("checkbox", { name: "Glow Naturals" }).waitFor();
    for (const name of ["CLAUDE_VE_ALL", "MEMORY.md", "CLAUDE.md"]) {
      t.assert(existsSync(path.join(t.editing, name)), `${name} was seeded in the Editing Folder`);
    }
    await t.shot(page, "onboarding-channels");
    await page.getByRole("button", { name: "Add 2 Channels" }).click();

    // The library, with the type detected from each A-roll.
    const row = (/** @type {string} */ folder) =>
      page.locator(`[role="listitem"][data-video-id$="/${folder}"]`);
    await row("001 Landscape Clip").waitFor({ timeout: 30_000 });
    await row("001 Landscape Clip")
      .getByRole("button", { name: /^Video type: Long 16:9\./ })
      .waitFor();
    await row("001 Landscape Clip").getByRole("button", { name: "Start Editing" }).waitFor();
    await row("002 Portrait Clip")
      .getByRole("button", { name: /^Video type: Short 9:16\./ })
      .waitFor();
    await row("003 Rotated Clip")
      .getByRole("button", { name: /^Video type: Short 9:16\./ })
      .waitFor();
    await row("018 Hair Oil Review").waitFor();
    await page
      .getByRole("button", { name: /Tech Reviews/ })
      .first()
      .waitFor();
    await t.shot(page, "library");

    // The choices are on disk, in this scenario's own data directory.
    const settings = JSON.parse(await readFile(path.join(t.data, "settings.json"), "utf8"));
    t.equal(settings.editingFolder, t.editing, "the Editing Folder in settings.json");
    t.equal(
      settings.channels.map((/** @type {{ folderName: string }} */ c) => c.folderName).sort(),
      ["Glow Naturals", "Tech Reviews"],
      "the channels in settings.json",
    );
  },
};

// Settings reach the next edit (desktop 08-settings): add a channel, edit and save a prompt,
// create "My own toolkit" and switch to it, pick the model and effort in the top bar; the edit and
// the re-edit then carry them. The file picker has its own scenario (21-file-picker).
import { existsSync } from "node:fs";
import path from "node:path";
import { CHANNEL, reviewFile } from "../../e2e/library.mjs";
import {
  claudeSessions,
  expectParts,
  openSettings,
  settingsOnDisk,
  waitSaved,
} from "../setups.mjs";
import { row, status } from "../ui.mjs";

const VIDEO = "001 Landscape Clip";
const NEW_CHANNEL = "Beauty Corner";
const NEW_PROMPT = "EDITED LONG PROMPT: open with the product shot.";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "settings",
  title: "Channel, prompt, own toolkit, model and effort reach the next edit",
  timeout: 150_000,
  async run(t) {
    await t.seedLibrary([[VIDEO, "landscape"]]);
    await t.video(NEW_CHANNEL, "007 Serum Review", "portrait");
    const server = await t.startServer();
    const page = await t.open(server);
    await row(page, VIDEO).waitFor({ timeout: 30_000 });

    // Channels: add the found folder, edit and save the Long prompt.
    const nav = await openSettings(page, "Channels");
    await page.getByRole("button", { name: `Add ${NEW_CHANNEL}` }).click();
    await page
      .getByRole("button", { name: new RegExp(`^${NEW_CHANNEL}`) })
      .first()
      .waitFor({ timeout: 10_000 });
    await page
      .getByRole("button", { name: /^Tech Reviews/ })
      .first()
      .click();
    await page.getByRole("textbox", { name: "Long 16:9 prompt" }).fill(NEW_PROMPT);
    await page.getByText("Edited", { exact: true }).first().waitFor();
    await t.shot(page, "settings-prompt-edited");
    await page.getByRole("button", { name: "Save", exact: true }).first().click();
    await waitSaved(page, t, "the prompt to be saved");

    // Toolkit: create the own toolkit and choose it.
    await nav.getByRole("button", { name: /^Toolkit/ }).click();
    await page.getByRole("button", { name: "Create My Own Toolkit" }).click();
    const own = page.getByRole("radio", { name: /My own toolkit/ });
    await t.waitFor(
      async () => (await own.first().isEnabled()) || null,
      "My own toolkit available",
    );
    await own.first().click();
    await t.waitFor(async () => (await own.first().isChecked()) || null, "My own toolkit chosen");
    await t.shot(page, "settings-toolkit");

    // What is on disk now.
    const settings = await settingsOnDisk(t);
    const names = settings.channels.map((/** @type {{ folderName: string }} */ c) => c.folderName);
    t.assert(names.includes(NEW_CHANNEL), `the channels on disk: ${names.join(", ")}`);
    const tech = settings.channels.find(
      (/** @type {{ folderName: string }} */ c) => c.folderName === CHANNEL,
    );
    t.equal(tech?.long.prompts[0].text, NEW_PROMPT, "the Long prompt on disk");
    t.equal(settings.activeToolkit, "own", "activeToolkit on disk");
    t.assert(
      existsSync(path.join(t.editing, "CLAUDE_VE_ALL_OWN", "README.md")),
      "CLAUDE_VE_ALL_OWN/README.md was created",
    );

    // System: the line about this computer under the helper tools.
    await nav.getByRole("button", { name: /^System/ }).click();
    await page.getByText("This computer:").first().waitFor({ timeout: 20_000 });
    await t.shot(page, "settings-system");
    await page.getByRole("button", { name: "Done", exact: true }).click();

    // Model and effort for new edits, in the top bar.
    await page.getByRole("button", { name: /^Model: / }).click();
    await page.getByRole("menuitemradio", { name: /^Opus 5\.5/ }).click();
    await page.getByRole("button", { name: /^Model: Opus 5\.5/ }).waitFor();
    await page.getByRole("button", { name: /^Effort: / }).click();
    await page.getByRole("menuitemradio", { name: /^Max/ }).click();
    await page.getByRole("button", { name: /^Effort: Max/ }).waitFor();
    await t.shot(page, "model-and-effort");

    const video = row(page, VIDEO);
    await video.getByRole("button", { name: "Start Editing" }).click();
    await page
      .getByRole("dialog", { name: "Start Editing" })
      .getByRole("button", { name: "Start Editing" })
      .click();
    await status(video, "Edited", 30_000);
    const [edit] = await claudeSessions(t);
    t.assert(edit, "the fake Claude Code ran the edit");
    expectParts(edit?.args ?? "", ["--model opus", "--effort max"], "The arguments");
    expectParts(
      edit?.messages[0] ?? "",
      ["TOOLKIT_FOLDER = CLAUDE_VE_ALL_OWN", NEW_PROMPT],
      "The edit message",
    );

    // Re-Edit: the new request, the model and effort of the current selection.
    await video.getByRole("button", { name: "Re-Edit" }).click();
    const sheet = page.getByRole("dialog", { name: "Re-Edit" });
    await sheet.getByRole("textbox", { name: "What should change" }).fill("Brighter colours.");
    await sheet.getByRole("button", { name: "Re-Edit" }).click();
    await t.waitFor(
      () => existsSync(path.join(t.editing, CHANNEL, VIDEO, "output", reviewFile(VIDEO, 2))),
      "the second review project",
      30_000,
    );
    await status(video, "Edited", 30_000);
    const reEdit = (await claudeSessions(t))[1];
    t.assert(reEdit, "the fake Claude Code ran the re-edit");
    expectParts(
      reEdit?.messages[0] ?? "",
      ["RE-EDIT REQUEST.", "Brighter colours."],
      "The re-edit message",
    );
    expectParts(reEdit?.args ?? "", ["--model opus", "--effort max"], "The re-edit arguments");
  },
};

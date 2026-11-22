// Settings reach the next edit: add a channel, edit and save a prompt, create "My own toolkit"
// and switch to it, and pick the model and effort in
// the top bar.
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { root } from "../../mac-targets.mjs";
import path from "node:path";
import { CHANNEL, expectParts, seedLibrary, sessions } from "../library.mjs";

const VIDEO = "001 Landscape Clip";
const NEW_CHANNEL = "Beauty Corner";
const NEW_PROMPT = "EDITED LONG PROMPT: open with the product shot.";

/** @param {import("../types.mjs").Context} ctx */
async function settingsFile(ctx) {
  return JSON.parse(await readFile(path.join(ctx.data, "settings.json"), "utf8"));
}

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "settings",
  title: "Channel, prompt, own toolkit, model and effort reach the next edit",
  timeout: 150_000,
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    await ctx.video(NEW_CHANNEL, "007 Serum Review", "portrait");
    Object.assign(ctx.params, {
      video: VIDEO,
      newChannel: NEW_CHANNEL,
      prompt: NEW_PROMPT,
      version: JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"))
        .version,
    });
  },
  ops: {
    async checkSavedSettings(ctx) {
      const settings = await settingsFile(ctx);
      const names = settings.channels.map(
        (/** @type {{ folderName: string }} */ c) => c.folderName,
      );
      if (!names.includes(NEW_CHANNEL)) throw new Error(`channels on disk: ${names.join(", ")}`);
      const tech = settings.channels.find(
        (/** @type {{ folderName: string }} */ c) => c.folderName === CHANNEL,
      );
      if (tech?.long.prompts[0].text !== NEW_PROMPT) {
        throw new Error(`the Long prompt on disk is ${JSON.stringify(tech?.long.prompts[0].text)}`);
      }
      if (settings.activeToolkit !== "own")
        throw new Error(`activeToolkit is ${settings.activeToolkit}`);
      if (!existsSync(path.join(ctx.editing, "CLAUDE_VE_ALL_OWN", "README.md"))) {
        throw new Error("CLAUDE_VE_ALL_OWN/README.md was not created");
      }
      return true;
    },
    async checkEdit(ctx) {
      const [edit] = await sessions(ctx);
      if (!edit) throw new Error("no edit");
      expectParts(edit.args, ["--model opus", "--effort max"], "The arguments");
      expectParts(
        edit.messages[0] ?? "",
        ["TOOLKIT_FOLDER = CLAUDE_VE_ALL_OWN", NEW_PROMPT],
        "The edit message",
      );
      return true;
    },
    async checkReEdit(ctx) {
      const reEdit = (await sessions(ctx))[1];
      if (!reEdit) throw new Error("no re-edit");
      expectParts(
        reEdit.messages[0] ?? "",
        ["RE-EDIT REQUEST.", "Brighter colours."],
        "The re-edit message",
      );
      // The job keeps the model it started with, the re-edit uses the current selection.
      expectParts(reEdit.args, ["--model opus", "--effort max"], "The re-edit arguments");
      return true;
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        await ui.row(p.video, 30_000);
        await ui.click("button", /^Settings/);
        const nav = ui.within(await ui.find("navigation", "Settings"));

        // Channels: add the found folder, edit and save the Long prompt.
        await nav.click("button", /^Channels/);
        await ui.click("button", `Add ${p.newChannel}`);
        await ui.find("button", new RegExp(`^${p.newChannel}`), 10_000);
        await ui.click("button", /^Tech Reviews/);
        await ui.fill("Long 16:9 prompt", p.prompt);
        await ui.text("Edited");
        await host.shot("settings-prompt-edited");
        await ui.press("Save");
        await ui.find("button", "Save");
        await ui.waitFor(
          // Save is disabled while it saves too: the change is saved once it is no longer unsaved.
          () =>
            ui.all("button", "Save").every((b) => ui.state(b).disabled) &&
            !ui.content().includes("Unsaved changes"),
          "the prompt to be saved",
        );

        // Toolkit: create the own toolkit and choose it.
        await nav.click("button", /^Toolkit/);
        await ui.press("Create My Own Toolkit");
        // The choice is enabled once the folder exists.
        const own = await ui.waitFor(
          () => ui.all("radio", /My own toolkit/).find((r) => !ui.state(r).disabled),
          "My own toolkit to be available",
        );
        await ui.click(own);
        await ui.waitFor(
          () => ui.all("radio", /My own toolkit/).some((r) => ui.state(r).checked),
          "My own toolkit to be chosen",
        );
        await host.shot("settings-toolkit");

        await host.call("checkSavedSettings");

        // System: the line about this computer under the helper tools; on Windows also Git for
        // Windows (found on the runner) and the VidAI version.
        await nav.click("button", /^System/);
        await ui.text("This computer:", 20_000);
        if (ui.platform.gitForWindows) {
          await ui.text("Git for Windows");
          await ui.text(p.version);
        }
        await host.shot("settings-system");
        /** @type {any} */
        const page = globalThis;
        const last = [...page.document.querySelectorAll("section")].at(-1);
        last?.scrollIntoView({ block: "end" });
        await ui.sleep(200);
        await host.shot("settings-system-bottom");
        await ui.press("Done");

        // Model and effort for new edits.
        await ui.click("button", /^Model: /);
        await ui.click("menuitemradio", /^Opus 5\.5/);
        await ui.find("button", /^Model: Opus 5\.5/);
        await ui.click("button", /^Effort: /);
        await ui.click("menuitemradio", /^Max/);
        await ui.find("button", /^Effort: Max/);
        await host.shot("model-and-effort");

        const row = await ui.row(p.video);
        await row.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await row.status("Edited", 20_000);
        await host.call("checkEdit");

        const again = await ui.row(p.video);
        await again.press("Re-Edit");
        const sheet = await ui.dialog("Re-Edit");
        await sheet.fill("What should change", "Brighter colours.");
        await sheet.press("Re-Edit");
        await host.call("waitFile", {
          path: `Editing/Tech Reviews/${p.video}/output/${p.video}_v2.${ui.platform.reviewExtension}`,
        });
        await again.status("Edited", 20_000);
        await host.call("checkReEdit");
      },
    },
  ],
};

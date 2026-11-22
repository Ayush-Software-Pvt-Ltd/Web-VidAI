// Re-Edit with change text: the session is resumed with the re-edit message and a new review
// project version appears.
import { expectParts, outputFiles, reviewFile, seedLibrary, sessions } from "../library.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "re-edit",
  title: "Re-Edit resumes the session with the changes and adds a new review version",
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    ctx.params.video = VIDEO;
  },
  ops: {
    async checkReEdit(ctx) {
      const files = await outputFiles(ctx, VIDEO);
      for (const name of [reviewFile(VIDEO, 1), reviewFile(VIDEO, 2)]) {
        if (!files.includes(name))
          throw new Error(`${name} missing in output/: ${files.join(", ")}`);
      }
      const [edit, reEdit] = await sessions(ctx);
      if (!edit || !reEdit || reEdit.mode !== "resume" || reEdit.sid !== edit.sid) {
        throw new Error("the re-edit did not resume the edit's session");
      }
      expectParts(
        reEdit.messages[0] ?? "",
        [
          "RE-EDIT REQUEST. I reviewed the edit and want these changes:",
          "Make the intro ten seconds shorter.",
          "Save a new review project version",
        ],
        "The re-edit message",
      );
      return true;
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        const row = await ui.row(p.video, 30_000);
        await row.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await row.status("Edited", 20_000);

        await row.press("Re-Edit");
        const sheet = await ui.dialog("Re-Edit");
        await sheet.fill("What should change", "Make the intro ten seconds shorter.");
        await host.shot("re-edit-sheet");
        await sheet.press("Re-Edit");
        await ui.gone("dialog", "Re-Edit");
        await row.status("Edited", 20_000);
        await row.click("button", p.video);
        const panel = ui.within(await ui.find("complementary", "Activity"));
        await panel.text(`${p.video}_v2.${ui.platform.reviewExtension}`);
        await host.call("checkReEdit");
        await host.shot("re-edited");
      },
    },
  ],
};

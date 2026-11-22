// Render Final 4K: the final file appears in output/ and the row says Final rendered.
import { expectParts, outputFiles, seedLibrary, sessions } from "../library.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "render-final",
  title: "Render Final 4K creates the final file, status Final rendered",
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    ctx.params.video = VIDEO;
  },
  ops: {
    async renderNext(ctx) {
      await ctx.fakeSet("scenario", "render");
      return true;
    },
    async checkRender(ctx) {
      const files = await outputFiles(ctx, VIDEO);
      if (!files.includes(`${VIDEO}_final.mp4`)) {
        throw new Error(`no final render in output/: ${files.join(", ")}`);
      }
      const render = (await sessions(ctx))[1];
      expectParts(
        render?.messages[0] ?? "",
        [
          "I reviewed and approved the review project. Create the final output render now",
          "Use the 4K master.",
          "Write [OUTPUT COMPLETED] when the final render is done.",
        ],
        "The render message",
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
        await host.call("renderNext");

        await row.press("Render Final 4K");
        const sheet = await ui.dialog("Render Final 4K");
        await sheet.fill("Notes", "Use the 4K master.");
        await host.shot("render-sheet");
        await sheet.press("Render Final 4K");
        await ui.gone("dialog", "Render Final 4K");
        await row.status("Final rendered", 20_000);
        await row.click("button", p.video);
        const panel = ui.within(await ui.find("complementary", "Activity"));
        await panel.click("tab", "Outputs");
        await panel.text(`${p.video}_final.mp4`);
        await host.call("checkRender");
        await host.shot("final-rendered");
      },
    },
  ],
};

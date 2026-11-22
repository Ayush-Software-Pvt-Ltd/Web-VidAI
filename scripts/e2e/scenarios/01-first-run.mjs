// First run: onboarding with the Editing Folder step (the folder dialog is answered by the
// hook), toolkit seeding, the channels step, and the library with Long / Short detection.
import { existsSync } from "node:fs";
import path from "node:path";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "first-run",
  title: "Onboarding, toolkit seeding, channels, Long / Short badges",
  async prepare(ctx) {
    await ctx.video("Tech Reviews", "001 Landscape Clip", "landscape");
    await ctx.video("Tech Reviews", "002 Portrait Clip", "portrait");
    await ctx.video("Tech Reviews", "003 Rotated Clip", "rotated");
    await ctx.video("Glow Naturals", "018 Hair Oil Review", "landscape");
  },
  ops: {
    async toolkitSeeded(ctx) {
      for (const name of ["CLAUDE_VE_ALL", "MEMORY.md", "CLAUDE.md"]) {
        if (!existsSync(path.join(ctx.editing, name))) {
          throw new Error(`${name} was not created in the Editing Folder`);
        }
      }
      return true;
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        // Step 1 asks how VidAI should run edits (SPEC section 9, Onboarding); this scenario
        // takes Claude Code with the Claude subscription, whichever step comes first.
        await ui.waitFor(
          () =>
            ui.has("radiogroup", "How should VidAI run edits?") ||
            ui.content().includes("Choose your Editing Folder"),
          "the first onboarding step",
          30_000,
        );
        if (ui.has("radiogroup", "How should VidAI run edits?")) {
          await host.shot("onboarding-choice");
          await ui.click("radio", "Claude Code with Claude Subscription");
          await ui.press("Continue");
        }
        await ui.text("Choose your Editing Folder", 30_000);
        await host.shot("onboarding-editing-folder");
        await ui.answerNextDialog(p.editing);
        await ui.press("Choose Folder");

        await ui.text("Add your channels");
        await ui.text("Toolkit ready.");
        await ui.find("checkbox", "Tech Reviews");
        await ui.find("checkbox", "Glow Naturals");
        await host.call("toolkitSeeded");
        await host.shot("onboarding-channels");
        await ui.press("Add 2 Channels");

        const landscape = await ui.row("001 Landscape Clip", 15_000);
        await landscape.find("button", /^Video type: Long 16:9\./);
        await landscape.find("button", "Start Editing");
        const portrait = await ui.row("002 Portrait Clip");
        await portrait.find("button", /^Video type: Short 9:16\./);
        const rotated = await ui.row("003 Rotated Clip");
        await rotated.find("button", /^Video type: Short 9:16\./);
        await ui.row("018 Hair Oil Review");
        await ui.find("button", /Tech Reviews/);
        await host.shot("library");
      },
    },
  ],
};

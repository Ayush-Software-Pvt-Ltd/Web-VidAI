// Start Editing through the sheet: the row goes to Editing, the activity panel shows live log
// lines, the review project appears in output/, the row becomes Edited with Re-Edit and Render
// Final 4K, and the fake Claude received the full composed prompt.
import { currentInterface } from "../interface.mjs";
import {
  CHANNEL,
  LONG_PROMPT,
  LONG_STYLE,
  expectParts,
  outputFiles,
  reviewFile,
  samePath,
  seedLibrary,
  sessions,
} from "../library.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "start-editing",
  title: "Start Editing with product links and notes, live log, review project, prompt",
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    ctx.params.video = VIDEO;
    await ctx.fakeSet("scenario", "live");
  },
  ops: {
    async checkEdit(ctx) {
      const files = await outputFiles(ctx, VIDEO);
      if (!files.includes(reviewFile(VIDEO, 1))) {
        throw new Error(`no review project in output/: ${JSON.stringify(files)}`);
      }
      const calls = await sessions(ctx);
      if (calls.length !== 1) throw new Error(`expected one Claude process, got ${calls.length}`);
      const call = calls[0];
      if (!call) throw new Error("no Claude process");
      expectParts(
        call.args,
        [
          "-p --input-format stream-json --output-format stream-json --verbose",
          "--permission-mode bypassPermissions",
          `--session-id ${call.sid}`,
        ],
        "The Claude arguments",
      );
      if (call.args.includes("--model") || call.args.includes("--effort")) {
        throw new Error(`no model or effort was chosen, but got: ${call.args}`);
      }
      if (!samePath(call.cwd, ctx.editing)) throw new Error(`Claude ran in ${call.cwd}`);
      const message = call.messages[0] ?? "";
      expectParts(
        message,
        [
          `MAIN_FOLDER = ${VIDEO}\nCHANNEL_FOLDER = ${CHANNEL}\nChannel Name: ${CHANNEL}\nVIDEO_TYPE = Long\nBROLL_FOLDER = Broll\nTOOLKIT_FOLDER = CLAUDE_VE_ALL\nREVIEW_OUTPUT_SOFTWARE = ${currentInterface().reviewSoftware}`,
          "PRODUCT_LINKS =\nhttps://shop.example/serum\nhttps://shop.example/cream\n\nPRODUCT_LINKS STEP (required):",
          "NOTES FOR THIS VIDEO:\nMention the launch discount.",
          LONG_PROMPT,
          `CHANNEL_STYLE (Long 16:9):\n${LONG_STYLE}`,
          "VidAI:\nThis edit was started from the VidAI app.",
          "Never create a Style folder",
          '"[OUTPUT COMPLETED]"',
        ],
        "The edit message",
      );
      // Off an Apple Silicon Mac the message describes the machine (SPEC section 6).
      if (currentInterface().os === "windows") {
        expectParts(
          message,
          ["\nMACHINE = Windows PC (x64), ", "\nMACHINE_CPU = ", "\nTHIS MACHINE:\n"],
          "The edit message",
        );
        const facts = message.split("\n").filter((l) => l.startsWith("MACHINE"));
        console.log(`      the machine facts of the runner: ${facts.join(" | ")}`);
      }
      return true;
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        const row = await ui.row(p.video, 30_000);
        await row.press("Start Editing");
        const sheet = await ui.dialog("Start Editing");
        await sheet.text(p.video);
        await sheet.text(ui.platform.reviewSoftware);
        await sheet.fill("Product links", "https://shop.example/serum\nhttps://shop.example/cream");
        await sheet.fill("Notes", "Mention the launch discount.");
        await host.shot("start-sheet");
        await sheet.press("Start Editing");
        await ui.gone("dialog", "Start Editing");

        await row.status("Editing");
        await row.find("button", "Pause Editing");
        await row.find("button", "Stop Editing");
        await host.call("waitFile", { path: `fake/started.${p.video}` });
        await row.click("button", p.video);
        const panel = ui.within(await ui.find("complementary", "Activity"));
        await panel.text("Transcribe the A-roll");
        await panel.text(`Looking at the A-roll of ${p.video}.`);
        // Claude's Markdown is formatted, not shown as raw markers.
        await panel.text(/Plan ?1\. ?Read the timeline\.py notes ?2\. ?Transcribe the A-roll/);
        ui.assert(!panel.content().includes("**Plan**"), "no raw Markdown in the log");
        // A path inside the video folder is shown relative to it; the detail keeps it whole.
        await panel.text("CLAUDE_VE/timeline.py");
        ui.assert(
          !panel.content().includes(`${p.video}/CLAUDE_VE/timeline.py`),
          `the Read line shows a relative path, got ${JSON.stringify(panel.content())}`,
        );
        await row.text("Transcribe the A-roll");
        await host.shot("editing-live-log");

        await host.call("fake", { name: `release.${p.video}` });
        await row.status("Edited", 20_000);
        await row.find("button", "Re-Edit");
        await row.find("button", "Render Final 4K");
        await panel.text(`${p.video}_v1.${ui.platform.reviewExtension}`);
        await host.call("checkEdit");
        const notes = await host.call("notifications");
        ui.assert(
          notes.some((/** @type {string} */ n) => n.startsWith("Edit finished:")),
          `an "Edit finished" notification, got ${JSON.stringify(notes)}`,
        );
        await host.shot("edited");
      },
    },
  ],
};

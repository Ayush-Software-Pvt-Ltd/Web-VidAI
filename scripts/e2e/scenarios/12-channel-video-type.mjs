// A channel set to Always Short: its landscape video shows Short 9:16 set by the channel, and
// its edit is started as a Short with the channel's Short prompt.
import { SHORT_PROMPT, expectParts, seedLibrary, sessions } from "../library.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "channel-video-type",
  title: "Always Short on the channel makes a landscape video a Short",
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    ctx.params.video = VIDEO;
  },
  ops: {
    async checkShortEdit(ctx) {
      const [edit] = await sessions(ctx);
      expectParts(
        edit?.messages[0] ?? "",
        ["VIDEO_TYPE = Short", SHORT_PROMPT, "CHANNEL_STYLE (Short 9:16):\n(empty)"],
        "The edit message",
      );
      return true;
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        const row = await ui.row(p.video, 30_000);
        await row.find("button", /^Video type: Long 16:9\./);
        await ui.click("button", /^Settings/);
        await ui.within(await ui.find("navigation", "Settings")).click("button", /^Channels/);
        await ui.click("button", /^Tech Reviews/);
        await ui.click("radio", "Always Short");
        await ui.press("Save");
        await ui.waitFor(
          // Save is disabled while it saves too: the change is saved once it is no longer unsaved.
          () =>
            ui.all("button", "Save").every((b) => ui.state(b).disabled) &&
            !ui.content().includes("Unsaved changes"),
          "the channel to be saved",
        );
        await host.shot("channel-always-short");
        await ui.press("Done");

        const short = await ui.row(p.video);
        const badge = await short.find("button", /^Video type: Short 9:16\./);
        ui.assert(
          /set by the channel/i.test(badge.getAttribute("aria-label") ?? ""),
          `the badge says the channel set the type: ${badge.getAttribute("aria-label")}`,
        );
        await host.shot("short-by-channel");
        await short.press("Start Editing");
        const sheet = await ui.dialog("Start Editing");
        await sheet.text("Short 9:16");
        await sheet.press("Start Editing");
        await short.status("Edited", 20_000);
        await host.call("checkShortEdit");
      },
    },
  ],
};

// A channel set to Always Short (desktop 12-channel-video-type): its landscape video shows Short
// 9:16 set by the channel, and its edit is started as a Short with the channel's Short prompt.
import { SHORT_PROMPT } from "../../e2e/library.mjs";
import { claudeSessions, expectParts, openSettings, waitSaved } from "../setups.mjs";
import { row, status } from "../ui.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "channel-video-type",
  title: "Always Short on the channel makes a landscape video a Short",
  async run(t) {
    await t.seedLibrary([[VIDEO, "landscape"]]);
    const server = await t.startServer();
    const page = await t.open(server);
    const video = row(page, VIDEO);
    await video
      .getByRole("button", { name: /^Video type: Long 16:9\./ })
      .waitFor({ timeout: 30_000 });

    await openSettings(page, "Channels");
    await page
      .getByRole("button", { name: /^Tech Reviews/ })
      .first()
      .click();
    await page.getByRole("radio", { name: "Always Short" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).first().click();
    await waitSaved(page, t, "the channel to be saved");
    await t.shot(page, "channel-always-short");
    await page.getByRole("button", { name: "Done", exact: true }).click();

    const badge = video.getByRole("button", { name: /^Video type: Short 9:16\./ });
    await badge.waitFor();
    t.assert(
      /set by the channel/i.test((await badge.getAttribute("aria-label")) ?? ""),
      `the badge says the channel set the type: ${await badge.getAttribute("aria-label")}`,
    );
    await t.shot(page, "short-by-channel");

    await video.getByRole("button", { name: "Start Editing" }).click();
    const sheet = page.getByRole("dialog", { name: "Start Editing" });
    await sheet.getByText("Short 9:16").first().waitFor();
    await sheet.getByRole("button", { name: "Start Editing" }).click();
    await status(video, "Edited", 30_000);
    const [edit] = await claudeSessions(t);
    expectParts(
      edit?.messages[0] ?? "",
      ["VIDEO_TYPE = Short", SHORT_PROMPT, "CHANNEL_STYLE (Short 9:16):\n(empty)"],
      "The edit message",
    );
  },
};

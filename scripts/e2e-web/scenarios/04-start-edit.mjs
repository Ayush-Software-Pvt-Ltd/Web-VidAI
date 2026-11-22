// Start an edit with the fake Claude Code: the status changes and the log lines arrive live through
// the event stream (the page is never reloaded), the edit finishes and its outputs show.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { CHANNEL, LONG_PROMPT, expectParts, reviewFile } from "../../e2e/library.mjs";
import { activity, eventsSeen, row, status } from "../ui.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "start-edit",
  title: "Start an edit: live status and log through the event stream, outputs when it ends",
  async run(t) {
    await t.seedLibrary([[VIDEO, "landscape"]]);
    await t.fakeSet("scenario", "live");
    const server = await t.startServer();
    const page = await t.open(server);
    // A mark on the page: it is gone when the page reloads.
    await page.evaluate(() => {
      /** @type {any} */
      const w = globalThis;
      w.__notReloaded = true;
    });
    const video = row(page, VIDEO);
    await video.waitFor();

    // Start Editing through the sheet.
    await video.getByRole("button", { name: "Start Editing" }).click();
    const sheet = page.getByRole("dialog", { name: "Start Editing" });
    await sheet.getByText(VIDEO).first().waitFor();
    await sheet.getByLabel("Product links").fill("https://shop.example/serum");
    await sheet.getByLabel("Notes").fill("Mention the launch discount.");
    await t.shot(page, "start-sheet");
    await sheet.getByRole("button", { name: "Start Editing" }).click();
    await sheet.waitFor({ state: "detached" });

    // The status changes, and the fake Claude Code works on it.
    await status(video, "Editing");
    await video.getByRole("button", { name: "Pause Editing" }).waitFor();
    await video.getByRole("button", { name: "Stop Editing" }).waitFor();
    await t.waitFake(`started.${VIDEO}`);

    // The log lines arrive while the edit is still running, with no reload.
    await video.getByRole("button", { name: VIDEO, exact: true }).click();
    const panel = activity(page);
    await panel.getByText("Transcribe the A-roll").first().waitFor();
    await panel.getByText(`Looking at the A-roll of ${VIDEO}.`).waitFor();
    await panel.getByText("CLAUDE_VE/timeline.py").waitFor();
    t.assert(
      !(await panel.innerText()).includes("**Plan**"),
      "Claude's Markdown is formatted, not shown raw",
    );
    await video.getByText("Transcribe the A-roll").first().waitFor();
    await status(video, "Editing");
    const events = await eventsSeen(page);
    t.assert(events.includes("job-log"), `job-log events came in: ${JSON.stringify(events)}`);
    t.assert(events.includes("job-updated"), "job-updated events came in");
    await t.shot(page, "editing-live-log");

    // It finishes: the row is Edited and the outputs show.
    await t.release(VIDEO);
    await status(video, "Edited", 30_000);
    await video.getByRole("button", { name: "Re-Edit" }).waitFor();
    await video.getByRole("button", { name: "Render Final 4K" }).waitFor();
    const review = reviewFile(VIDEO, 1);
    await panel.getByText(review).first().waitFor();
    await panel.getByRole("tab", { name: "Outputs" }).click();
    await panel.getByText(review).first().waitFor();
    t.assert(
      (await readdir(path.join(t.editing, CHANNEL, VIDEO, "output"))).includes(review),
      "the review project is in output/ on disk",
    );
    t.equal(
      await page.evaluate(() => {
        /** @type {any} */
        const w = globalThis;
        return w.__notReloaded === true;
      }),
      true,
      "the page was never reloaded",
    );

    // The core ran one Claude Code process with the composed prompt.
    const calls = (await t.fakeCalls()).filter((c) => c.sid !== "");
    t.equal(calls.length, 1, "Claude Code processes");
    const message = calls[0]?.messages[0] ?? "";
    expectParts(
      message,
      [
        `MAIN_FOLDER = ${VIDEO}\nCHANNEL_FOLDER = ${CHANNEL}`,
        "PRODUCT_LINKS =\nhttps://shop.example/serum",
        "NOTES FOR THIS VIDEO:\nMention the launch discount.",
        LONG_PROMPT,
      ],
      "The edit message",
    );
    await panel.getByRole("tab", { name: "Log" }).click();
    await t.shot(page, "edited-outputs");
  },
};

// Keeping a job going (SPEC section 6), on a Mac and on Windows: the fake Claude Code ends its
// turns early the way some models on OpenCode do (a sentence about the next step, no tool call,
// no marker), at the start, twice in the middle and after the last step. VidAI asks it to go on
// in the same live process each time; the row never shows Needs attention or Continue Editing
// until the edit is finished, the bar never goes back, and the activity log shows one numbered
// status line per continuation.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expectParts, keepsJobsGoing, seedLibrary, sessions } from "../library.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "keep-going",
  title: "Turns that end early are continued by VidAI until the edit is finished",
  skip: keepsJobsGoing() ? null : "Jobs keep themselves going only on Macs and on Windows",
  timeout: 180_000,
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    ctx.params.video = VIDEO;
    await ctx.fakeSet("scenario", "premature");
    await ctx.fakeSet("stops", "0 3 6 9");
  },
  ops: {
    async checkOneProcess(ctx) {
      const calls = await sessions(ctx);
      if (calls.length !== 1) throw new Error(`expected one Claude process, got ${calls.length}`);
      const messages = calls[0]?.messages ?? [];
      if (messages.length !== 5) {
        throw new Error(`expected the instructions and 4 continuations, got ${messages.length}`);
      }
      for (const message of messages.slice(1, 4)) {
        expectParts(
          message,
          [
            "The edit is not finished yet: there is no review project in the output folder.",
            "Never end your turn after only announcing a step",
          ],
          "A continuation",
        );
      }
      expectParts(
        messages[4] ?? "",
        ["is saved, but [OUTPUT COMPLETED] is not written yet."],
        "The request to finish the last steps",
      );
      return true;
    },
    /** The job's log as saved: one numbered status line per continuation, nothing failed. */
    async checkLog(ctx) {
      const dir = path.join(ctx.data, "logs");
      const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
      if (files.length !== 1) throw new Error(`expected one job log, got ${files.length}`);
      const entries = (await readFile(path.join(dir, files[0] ?? ""), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const asked = entries.filter((e) => e.text.startsWith("Asked to")).map((e) => e.text);
      const expected = [
        "Asked to keep going (1): the turn ended before the edit was finished",
        "Asked to keep going (2): the turn ended before the edit was finished",
        "Asked to keep going (3): the turn ended before the edit was finished",
        "Asked to finish the last steps (4): the review project is saved, [OUTPUT COMPLETED] is not written yet",
      ];
      if (JSON.stringify(asked) !== JSON.stringify(expected)) {
        throw new Error(`the continuation lines are ${JSON.stringify(asked)}`);
      }
      if (entries.some((e) => e.kind === "error")) throw new Error("the log has an error line");
      if (entries.some((e) => e.text.includes("Claude is finished"))) {
        throw new Error("the log says Claude is finished before the edit was");
      }
      return true;
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        const row = await ui.row(p.video, 30_000);
        await row.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await row.status("Editing");
        await row.click("button", p.video);
        const panel = ui.within(await ui.find("complementary", "Activity"));

        // Watch the row the whole time: never a failure, never Continue, the bar never back.
        const barValue = () =>
          Number(row.all("progressbar")[0]?.getAttribute("aria-valuenow") ?? NaN);
        let highest = 0;
        let shot = false;
        // The fake of Windows (Git Bash) waits in one-second steps, so every wait is longer there.
        const deadline = Date.now() + 150_000 * (p.timeScale ?? 1);
        for (;;) {
          const status = row.currentStatus();
          ui.assert(status !== "Needs attention", "the row showed Needs attention");
          ui.assert(!row.has("button", "Continue Editing"), "the row offered Continue Editing");
          if (status === "Edited") break;
          const value = barValue();
          if (!Number.isNaN(value)) {
            ui.assert(value >= highest, `the bar went back from ${highest}% to ${value}%`);
            highest = value;
          }
          if (!shot && panel.content().includes("Asked to keep going (2)")) {
            shot = true;
            await host.shot("continued");
          }
          ui.assert(Date.now() < deadline, `the edit did not finish (row: ${status})`);
          await ui.sleep(100);
        }
        ui.assert(shot, "the second continuation was never shown");

        await panel.click("tab", "Log");
        await panel.text(
          "Asked to finish the last steps (4): the review project is saved, [OUTPUT COMPLETED] is not written yet",
        );
        await panel.noText("Claude is finished");
        await panel.noText("Error:");
        await host.call("checkOneProcess");
        await host.call("checkLog");
        await host.shot("finished-log");
      },
    },
  ],
};

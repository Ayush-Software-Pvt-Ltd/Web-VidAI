// Keeping a job going (SPEC section 6), seen in the browser: the fake Claude Code ends its turns
// early the way some models on OpenCode do (a sentence about the next step, no tool call, no
// marker), at the start, twice in the middle and after the last step. VidAI asks it to go on in
// the same live process each time; the row never shows Needs attention or Continue Editing until
// the edit is finished, the bar never goes back, and the activity log shows one numbered status
// line per continuation.
import { expectParts } from "../../e2e/library.mjs";
import { barValue, currentStatus, openPanel, savedLogs, sessions } from "../jobs.mjs";
import { row, startEditing } from "../ui.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "keep-going",
  title: "Turns that end early are continued by VidAI until the edit is finished",
  timeout: 180_000,
  async run(t) {
    await t.seedLibrary([[VIDEO, "landscape"]]);
    await t.fakeSet("scenario", "premature");
    await t.fakeSet("stops", "0 3 6 9");
    const server = await t.startServer();
    const page = await t.open(server);
    const video = row(page, VIDEO);
    await video.waitFor();

    await startEditing(page, VIDEO);
    await t.waitFor(
      async () => (await currentStatus(video)) === "Editing",
      "the row to say Editing",
    );
    const panel = await openPanel(page, video, VIDEO);

    // Watch the row the whole time: never a failure, never Continue, the bar never back.
    let highest = 0;
    let shot = false;
    const deadline = Date.now() + 150_000;
    for (;;) {
      const state = await currentStatus(video);
      t.assert(state !== "Needs attention", "the row showed Needs attention");
      t.assert(
        (await video.getByRole("button", { name: "Continue Editing" }).count()) === 0,
        "the row offered Continue Editing",
      );
      if (state === "Edited") break;
      const value = await barValue(video);
      if (!Number.isNaN(value)) {
        t.assert(value >= highest, `the bar went back from ${highest}% to ${value}%`);
        highest = value;
      }
      if (!shot && (await panel.innerText()).includes("Asked to keep going (2)")) {
        shot = true;
        await t.shot(page, "continued");
      }
      t.assert(Date.now() < deadline, `the edit did not finish (row: ${state})`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    t.assert(shot, "the second continuation was never shown");

    await panel.getByRole("tab", { name: "Log" }).click();
    await panel
      .getByText(
        "Asked to finish the last steps (4): the review project is saved, [OUTPUT COMPLETED] is not written yet",
      )
      .waitFor();
    const text = await panel.innerText();
    t.assert(!text.includes("Claude is finished"), "the panel says Claude is finished");
    t.assert(!text.includes("Error:"), "the panel shows an error");

    // One Claude process took the instructions and the four continuations.
    const calls = await sessions(t);
    t.equal(calls.length, 1, "Claude Code processes");
    const messages = calls[0]?.messages ?? [];
    t.equal(messages.length, 5, "the instructions and 4 continuations");
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

    // The job's saved log: one numbered status line per continuation, nothing failed.
    const entries = await savedLogs(t);
    t.equal(
      entries.filter((e) => e.text.startsWith("Asked to")).map((e) => e.text),
      [
        "Asked to keep going (1): the turn ended before the edit was finished",
        "Asked to keep going (2): the turn ended before the edit was finished",
        "Asked to keep going (3): the turn ended before the edit was finished",
        "Asked to finish the last steps (4): the review project is saved, [OUTPUT COMPLETED] is not written yet",
      ],
      "the continuation lines of the log",
    );
    t.assert(!entries.some((e) => e.kind === "error"), "the log has an error line");
    t.assert(
      !entries.some((e) => e.text.includes("Claude is finished")),
      "the log says Claude is finished before the edit was",
    );
    await t.shot(page, "finished-log");
  },
};

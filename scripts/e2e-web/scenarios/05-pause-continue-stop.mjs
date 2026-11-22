// Pause Editing and Continue Editing a running edit (the same Claude Code session is resumed and the
// edit completes), then Stop another one (the confirmation, the row offers Start Editing again).
import { expectParts } from "../../e2e/library.mjs";
import { activity, row, startEditing, status } from "../ui.mjs";

const FIRST = "001 Landscape Clip";
const SECOND = "002 Second Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "pause-continue-stop",
  title: "Pause and Continue (same session, completes), then Stop another edit",
  async run(t) {
    await t.seedLibrary([
      [FIRST, "landscape"],
      [SECOND, "landscape"],
    ]);
    await t.fakeSet("scenario", "live");
    const server = await t.startServer();
    const page = await t.open(server);
    const first = row(page, FIRST);
    const second = row(page, SECOND);
    await first.waitFor();

    // Pause, then Continue.
    await startEditing(page, FIRST);
    await status(first, "Editing");
    await t.waitFake(`started.${FIRST}`);
    await t.fakeRemove(`started.${FIRST}`);
    await first.getByRole("button", { name: "Pause Editing" }).click();
    await status(first, "Paused", 30_000);
    await first.getByRole("button", { name: "Continue Editing" }).waitFor();
    await first.getByRole("button", { name: "Stop Editing" }).waitFor();
    await first.getByRole("button", { name: FIRST, exact: true }).click();
    const panel = activity(page);
    await panel.getByText("Paused. Press Continue Editing to resume.").waitFor();
    await t.shot(page, "paused");

    await first.getByRole("button", { name: "Continue Editing" }).click();
    await status(first, "Editing", 30_000);
    await t.waitFake(`started.${FIRST}`);
    await panel.getByText("Asked Claude to continue").waitFor();
    await t.release(FIRST);
    await status(first, "Edited", 30_000);
    await first.getByRole("button", { name: "Re-Edit" }).waitFor();

    // The core resumed the very session it paused.
    const calls = (await t.fakeCalls()).filter((c) => c.sid !== "");
    const [one, two] = calls;
    t.assert(calls.length === 2 && one && two, `two Claude processes, got ${calls.length}`);
    if (one && two) {
      t.assert(
        one.mode === "new" && two.mode === "resume" && one.sid === two.sid,
        `the session was resumed: ${one.mode} ${one.sid}, then ${two.mode} ${two.sid}`,
      );
      expectParts(two.args, [`--resume ${one.sid}`], "The arguments of the continue");
      t.assert(
        one.stdin.some((line) => line.includes('"subtype":"interrupt"')),
        "the pause interrupted Claude",
      );
      expectParts(
        two.messages[0] ?? "",
        ["Continue the video edit from where it was paused."],
        "The continue message",
      );
    }

    // Stop another edit: the confirmation, then the row offers Start Editing again.
    await startEditing(page, SECOND);
    await status(second, "Editing");
    await t.waitFake(`started.${SECOND}`);
    await second.getByRole("button", { name: "Stop Editing" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Stop editing?" });
    await confirm.getByText("working files").waitFor();
    await t.shot(page, "stop-confirmation");
    await confirm.getByRole("button", { name: "Stop Editing" }).click();
    await status(second, "Stopped", 30_000);
    await second.getByRole("button", { name: "Start Editing" }).waitFor();
    await second.getByRole("button", { name: SECOND, exact: true }).click();
    await t.shot(page, "stopped");
    // The first edit is untouched.
    await status(first, "Edited");
  },
};

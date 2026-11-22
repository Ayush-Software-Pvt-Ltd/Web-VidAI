// Two tabs of one browser both get every event (SPEC section 12): an edit started in one shows up
// as running, with its log, in the other; a pause in the second shows in the first. Closing a tab
// changes nothing: a third tab opened later shows the running edit.
import { activity, eventsSeen, row, startEditing, status } from "../ui.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "two-tabs",
  title: "Two tabs show the same live progress; a closed tab changes nothing",
  async run(t) {
    await t.seedLibrary([[VIDEO, "landscape"]]);
    await t.fakeSet("scenario", "live");
    const server = await t.startServer();
    const context = await t.newContext();
    const one = await t.open(server, context);
    const two = await t.open(server, context);
    const a = row(one, VIDEO);
    const b = row(two, VIDEO);
    await a.waitFor();
    await b.waitFor();

    // Started in the first tab, running with its log in the second.
    await startEditing(one, VIDEO);
    await status(a, "Editing");
    await status(b, "Editing");
    await t.waitFake(`started.${VIDEO}`);
    await b.getByRole("button", { name: VIDEO, exact: true }).click();
    await activity(two).getByText("Transcribe the A-roll").first().waitFor();
    await a.getByRole("button", { name: VIDEO, exact: true }).click();
    await activity(one).getByText("Transcribe the A-roll").first().waitFor();
    for (const page of [one, two]) {
      const events = await eventsSeen(page);
      t.assert(events.includes("job-log"), `a tab got job-log events: ${JSON.stringify(events)}`);
    }
    await t.shot(two, "second-tab-live");

    // Paused in the second tab, paused in the first; continued in the first, running in the second.
    await t.fakeRemove(`started.${VIDEO}`);
    await b.getByRole("button", { name: "Pause Editing" }).click();
    await status(b, "Paused", 30_000);
    await status(a, "Paused");
    await activity(one).getByText("Paused. Press Continue Editing to resume.").waitFor();
    await a.getByRole("button", { name: "Continue Editing" }).click();
    await status(a, "Editing", 30_000);
    await status(b, "Editing");

    // Closing a tab changes nothing: the edit goes on, and a tab opened later shows it.
    await t.waitFake(`started.${VIDEO}`);
    await one.close();
    const three = await t.open(server, context);
    const c = row(three, VIDEO);
    await status(c, "Editing");
    await c.getByRole("button", { name: VIDEO, exact: true }).click();
    await activity(three).getByText("Transcribe the A-roll").first().waitFor();

    // It ends in every tab that is still open.
    await t.release(VIDEO);
    await status(c, "Edited", 30_000);
    await status(b, "Edited");
    await t.shot(three, "third-tab-edited");
  },
};

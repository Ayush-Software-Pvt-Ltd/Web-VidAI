// The progress bar through the life of a job in the browser (SPEC sections 6 and 9, Progress): the
// bar freezes on pause and goes on from the same value on Continue, freezes on Stop and on a
// failure (with the spoken text saying so), and a re-edit and a render each start from 0 with
// their own milestones.
import { barText, barValue, waitBar } from "../jobs.mjs";
import { row, startEditing, status } from "../ui.mjs";

const PAUSED = "001 Paused";
const FAILED = "002 Failed";
const REWORKED = "003 Reworked";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "progress-lifecycle",
  title: "The bar freezes on pause, stop and failure; a re-edit and a render start from 0",
  timeout: 240_000,
  async run(t) {
    await t.seedLibrary([
      [PAUSED, "landscape"],
      [FAILED, "landscape"],
      [REWORKED, "portrait"],
    ]);
    await t.fakeSet(`scenario.${PAUSED}`, "progress");
    await t.fakeSet(`scenario.${FAILED}`, "no_output");
    await t.fakeSet(`scenario.${REWORKED}`, "complete");
    const server = await t.startServer();
    const page = await t.open(server);
    const paused = row(page, PAUSED);
    await paused.waitFor();

    /** Waits for the fake to reach a step, then lets it go on unless `hold`.
     * @param {string} video @param {boolean} [hold] */
    const reach = async (video, hold = false) => {
      await t.waitFake(`reached.${video}`);
      await t.fakeRemove(`reached.${video}`);
      if (!hold) await t.fakeSet(`next.${video}`);
    };

    // Pause freezes the bar, Continue goes on from the same value.
    await startEditing(page, PAUSED);
    await reach(PAUSED);
    await reach(PAUSED, true);
    await waitBar(t, paused, 15, "bar at the transcript");
    await paused.getByRole("button", { name: "Pause Editing" }).click();
    await status(paused, "Paused", 20_000);
    const pausedAt = await barValue(paused);
    t.equal(await barText(paused), `${pausedAt}%, paused`, "the paused bar's value text");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    t.equal(await barValue(paused), pausedAt, "the paused bar after 2.5 s");
    await t.shot(page, "lifecycle-paused");
    await paused.getByRole("button", { name: "Continue Editing" }).click();
    await status(paused, "Editing");
    t.assert(
      (await barValue(paused)) >= pausedAt,
      `the bar went back from ${pausedAt}% on Continue`,
    );
    await reach(PAUSED, true);
    await waitBar(t, paused, 30, "bar at the plan after Continue");
    t.note(`paused at ${pausedAt}%, continued to ${await barValue(paused)}%`);

    // Stop freezes it too, and the stopped bar stays while the pill says Stopped.
    await paused.getByRole("button", { name: "Stop Editing" }).click();
    await page
      .getByRole("alertdialog", { name: "Stop editing?" })
      .getByRole("button", { name: "Stop Editing" })
      .click();
    await status(paused, "Stopped", 20_000);
    const stoppedAt = await barValue(paused);
    t.equal(await barText(paused), `${stoppedAt}%, stopped`, "the stopped bar's value text");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    t.equal(await barValue(paused), stoppedAt, "the stopped bar after 1.5 s");
    await t.shot(page, "lifecycle-stopped");

    // A failure freezes the bar in the danger colour.
    const failed = row(page, FAILED);
    await startEditing(page, FAILED);
    await status(failed, "Needs attention", 30_000);
    t.assert(
      (await barText(failed)).endsWith(", failed"),
      `the failed bar's value text: ${await barText(failed)}`,
    );
    await t.shot(page, "lifecycle-failed");

    // A re-edit and a render each start from 0 with their own milestones.
    const rework = row(page, REWORKED);
    await startEditing(page, REWORKED);
    await status(rework, "Edited", 30_000);
    await t.waitFor(
      async () => (await rework.getByRole("progressbar").count()) === 0,
      "the completed edit's bar to go",
      10_000,
    );
    await t.fakeSet(`scenario.${REWORKED}`, "progress");
    await rework.getByRole("button", { name: "Re-Edit" }).click();
    const reEdit = page.getByRole("dialog", { name: "Re-Edit" });
    await reEdit.getByLabel("What should change").fill("Shorter intro.");
    await reEdit.getByRole("button", { name: "Re-Edit" }).click();
    await reEdit.waitFor({ state: "detached" });
    await status(rework, "Re-editing");
    await reach(REWORKED, true);
    let value = await waitBar(t, rework, 65, "re-edit bar at its changes milestone");
    t.assert(value < 95, `the re-edit bar shows ${value}% before the new version`);
    await t.shot(page, "lifecycle-re-edit");
    await t.fakeSet(`next.${REWORKED}`);
    await reach(REWORKED);
    await status(rework, "Edited", 30_000);
    await t.waitFor(
      async () => (await rework.getByRole("progressbar").count()) === 0,
      "the re-edit's bar to go",
      10_000,
    );

    await rework.getByRole("button", { name: "Render Final 4K" }).click();
    const render = page.getByRole("dialog", { name: "Render Final 4K" });
    await render.getByRole("button", { name: "Render Final 4K" }).click();
    await render.waitFor({ state: "detached" });
    await status(rework, "Rendering");
    await reach(REWORKED, true);
    value = await waitBar(t, rework, 10, "render bar at its first milestone");
    t.assert(value < 70, `the render bar shows ${value}% before the final file`);
    await t.fakeSet(`next.${REWORKED}`);
    await reach(REWORKED, true);
    value = await waitBar(t, rework, 95, "render bar at the written final file");
    await t.shot(page, "lifecycle-render");
    await t.fakeSet(`next.${REWORKED}`);
    await status(rework, "Final rendered", 30_000);
    t.note(`re-edit and render bars rose from 0 to ${value}%`);
  },
};

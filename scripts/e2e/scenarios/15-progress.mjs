// The progress bar of a job in the real app (SPEC sections 6 and 9, Progress):
// - "progress": the fake Claude works through the steps of a real edit one at a time (scenario
//   "progress": the tool calls and [VIDAI_PROGRESS ...] markers of each step, then it waits for
//   `next.<video>`), at text size 20 in the smallest window. After every step the bar on the
//   video row and the one in the activity panel (role "progressbar", read through
//   aria-valuenow) show at least that milestone's value and never the next one's, they never go
//   backwards, the row's stage label fits, and the row keeps its height. A completed bar stays
//   full for 2.5 s, fades and leaves a clean row.
// - "progress-lifecycle": the bar freezes on pause and goes on from the same value on Continue,
//   freezes on Stop and on a failure, and a re-edit and a render each start from 0 with their own
//   milestones.
import { seedLibrary } from "../library.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario[]} */
export default [
  {
    name: "progress",
    title: "The progress bar rises through the milestones of an edit, at text size 20",
    timeout: 240_000,
    async prepare(ctx) {
      await seedLibrary(ctx, [[VIDEO, "landscape"]], { textSize: 20 });
      ctx.params.video = VIDEO;
      // Where each step of the edit model ends (SPEC section 6, Progress), and the value of the
      // next milestone, which the bar may approach but not reach before the step is done.
      ctx.params.steps = [
        [3, 15],
        [15, 30],
        [30, 64],
        [64, 74],
        [74, 83],
        [83, 91],
        [91, 96],
        [96, 99],
        [99, 100],
      ];
      await ctx.fakeSet("scenario", "progress");
    },
    launches: [
      {
        async page(ui, host, p) {
          /** @type {any} */
          const page = globalThis;
          const valueIn = (/** @type {import("../types.mjs").Scope} */ scope) =>
            Number(scope.all("progressbar")[0]?.getAttribute("aria-valuenow") ?? NaN);
          // The smallest window at the largest text size.
          const [minWidth, minHeight] = await host.native("minSize");
          await host.native("setSize", { width: minWidth, height: minHeight });
          await ui.waitFor(() => page.innerWidth <= 981, "the smallest window (980 CSS px)");

          const row = await ui.row(p.video, 30_000);
          const rowEl = /** @type {any} */ (row.root);
          const height = rowEl.getBoundingClientRect().height;
          /** The row's stage label is shown in full, and the row keeps its height. */
          const checkRow = (/** @type {string} */ when) => {
            ui.equal(rowEl.getBoundingClientRect().height, height, `the row height ${when}`);
            const summary = rowEl.querySelector("[data-progress-summary]");
            if (!summary) return;
            const stage = summary.firstElementChild;
            ui.assert(
              // Whole px round apart in a fractional layout; TruncatedText allows 1 px too.
              stage.scrollWidth <= stage.clientWidth + 1,
              `the stage "${stage.textContent}" is cut off on the row ${when} (${stage.scrollWidth} > ${stage.clientWidth} px; row ${rowEl.clientWidth} px, detail line ${[...summary.parentElement.children].map((c) => `${c.textContent.slice(0, 24)}=${c.getBoundingClientRect().width.toFixed(1)}`).join(", ")}; controls ${rowEl.querySelector(":scope > [data-row-controls]")?.getBoundingClientRect().width.toFixed(1)})`,
            );
          };
          await row.press("Start Editing");
          await (await ui.dialog("Start Editing")).press("Start Editing");
          await row.status("Editing");
          checkRow("when the edit starts");

          let last = 0;
          for (const [index, [atLeast, below]] of p.steps.entries()) {
            const step = index + 1;
            await host.call("waitFile", { path: `fake/reached.${p.video}`, timeout: 30_000 });
            await host.call("fake", { name: `reached.${p.video}`, remove: true });
            // The row with the activity panel closed (the widest list), then the panel.
            const value = await ui.waitFor(
              () => (valueIn(row) >= atLeast ? valueIn(row) : 0),
              `the row progress bar at ${atLeast}% or more after step ${step}`,
              20_000,
            );
            ui.assert(value < below, `the row bar shows ${value}%, below ${below}% expected`);
            ui.assert(value >= last, `the row bar went back from ${last}% to ${value}%`);
            checkRow(`after step ${step}`);
            await row.click("button", p.video);
            const panel = ui.within(await ui.find("complementary", "Activity"));
            const inPanel = await ui.waitFor(
              () => (valueIn(panel) >= atLeast ? valueIn(panel) : 0),
              `the activity panel progress bar at ${atLeast}% or more after step ${step}`,
              20_000,
            );
            ui.assert(inPanel < below, `the panel bar shows ${inPanel}%, below ${below}%`);
            ui.equal(rowEl.getBoundingClientRect().height, height, "the row height with the panel");
            last = valueIn(row);
            ui.log(
              `step ${step}: ${last}%, ${rowEl.querySelector("[data-progress-summary]")?.textContent}`,
            );
            if (step === 3) await host.shot("progress-planned");
            if (step === 8) await host.shot("progress-review-saved");
            await ui.key("Escape");
            await ui.gone("complementary", "Activity");
            await host.call("fake", { name: `next.${p.video}` });
          }

          // Done: the full bar stays for 2.5 s, fades out and leaves a clean row.
          await row.status("Edited", 30_000);
          const doneAt = Date.now();
          ui.equal(valueIn(row), 100, "the bar of a done edit");
          await host.shot("progress-done");
          await ui.waitFor(() => !row.has("progressbar"), "the completed bar to go", 10_000);
          const shown = Date.now() - doneAt;
          ui.assert(shown >= 2000, `the completed bar went after ${shown} ms, before its 2.5 s`);
          ui.equal(rowEl.getBoundingClientRect().height, height, "the row height after the bar");
          ui.log(`the completed bar went ${shown} ms after Edited`);
          await host.shot("progress-done-clean");

          await row.click("button", p.video);
          const panel = ui.within(await ui.find("complementary", "Activity"));
          // A finished edit opens on its outputs.
          await panel.click("tab", "Log");
          await panel.text("Transcription done");
          await panel.text("Review project saved");
          ui.assert(
            !panel.content().includes("VIDAI_PROGRESS"),
            "no raw progress markers in the log",
          );
          ui.assert(!panel.has("progressbar"), "the panel of a done edit has no bar any more");
        },
      },
    ],
  },
  {
    name: "progress-lifecycle",
    title: "The bar freezes on pause, stop and failure; a re-edit and a render start from 0",
    timeout: 240_000,
    async prepare(ctx) {
      const videos = ["001 Paused", "002 Failed", "003 Reworked"];
      await seedLibrary(ctx, [
        [videos[0], "landscape"],
        [videos[1], "landscape"],
        [videos[2], "portrait"],
      ]);
      ctx.params.videos = videos;
      await ctx.fakeSet(`scenario.${videos[0]}`, "progress");
      await ctx.fakeSet(`scenario.${videos[1]}`, "no_output");
      await ctx.fakeSet(`scenario.${videos[2]}`, "complete");
    },
    ops: {
      async paced(ctx, args) {
        await ctx.fakeSet(`scenario.${args.video}`, "progress");
        return true;
      },
    },
    launches: [
      {
        async page(ui, host, p) {
          const [pausedVideo, failedVideo, reworked] = p.videos;
          const barOf = (/** @type {import("../types.mjs").Scope} */ scope) =>
            scope.all("progressbar")[0] ?? null;
          const valueIn = (/** @type {import("../types.mjs").Scope} */ scope) =>
            Number(barOf(scope)?.getAttribute("aria-valuenow") ?? NaN);
          const textIn = (/** @type {import("../types.mjs").Scope} */ scope) =>
            barOf(scope)?.getAttribute("aria-valuetext") ?? "";
          /** Waits for the fake to reach a step, then lets it go on unless `hold`. */
          const reach = async (/** @type {string} */ video, hold = false) => {
            await host.call("waitFile", { path: `fake/reached.${video}`, timeout: 30_000 });
            await host.call("fake", { name: `reached.${video}`, remove: true });
            if (!hold) await host.call("fake", { name: `next.${video}` });
          };
          const start = async (/** @type {string} */ video) => {
            const row = await ui.row(video, 30_000);
            await row.press("Start Editing");
            await (await ui.dialog("Start Editing")).press("Start Editing");
            return row;
          };

          // Pause freezes the bar, Continue goes on from the same value.
          const row = await start(pausedVideo);
          await reach(pausedVideo);
          await reach(pausedVideo, true);
          await ui.waitFor(() => valueIn(row) >= 15, "the bar at the transcript (15%)");
          await row.press("Pause Editing");
          await row.status("Paused", 20_000);
          const paused = valueIn(row);
          ui.equal(textIn(row), `${paused}%, paused`, "the paused bar's value text");
          await ui.sleep(2500);
          ui.equal(valueIn(row), paused, "the paused bar after 2.5 s");
          await host.shot("lifecycle-paused");
          await row.press("Continue Editing");
          await row.status("Editing");
          ui.assert(valueIn(row) >= paused, `the bar went back from ${paused}% on Continue`);
          await reach(pausedVideo, true);
          await ui.waitFor(() => valueIn(row) >= 30, "the bar at the plan (30%) after Continue");
          ui.log(`paused at ${paused}%, continued to ${valueIn(row)}%`);

          // Stop freezes it too, and the stopped bar stays while the pill says Stopped.
          await row.press("Stop Editing");
          await (await ui.dialog("Stop editing?")).press("Stop Editing");
          await row.status("Stopped", 20_000);
          const stopped = valueIn(row);
          ui.equal(textIn(row), `${stopped}%, stopped`, "the stopped bar's value text");
          await ui.sleep(1500);
          ui.equal(valueIn(row), stopped, "the stopped bar after 1.5 s");
          await host.shot("lifecycle-stopped");

          // A failure freezes the bar in the danger colour.
          const failedRow = await start(failedVideo);
          await failedRow.status("Needs attention", 30_000);
          const failed = barOf(failedRow);
          if (failed) {
            ui.assert(
              textIn(failedRow).endsWith(", failed"),
              `the failed bar's value text: ${textIn(failedRow)}`,
            );
          }
          await host.shot("lifecycle-failed");

          // A re-edit and a render each start from 0 with their own milestones.
          const rework = await start(reworked);
          await rework.status("Edited", 30_000);
          await ui.waitFor(
            () => !rework.has("progressbar"),
            "the completed edit's bar to go",
            10_000,
          );
          await host.call("paced", { video: reworked });
          await rework.press("Re-Edit");
          const sheet = await ui.dialog("Re-Edit");
          await sheet.fill("What should change", "Shorter intro.");
          await sheet.press("Re-Edit");
          await rework.status("Re-editing");
          await reach(reworked, true);
          let value = await ui.waitFor(
            () => (valueIn(rework) >= 65 ? valueIn(rework) : 0),
            "the re-edit bar at its changes milestone (65%)",
          );
          ui.assert(value < 95, `the re-edit bar shows ${value}% before the new version`);
          await host.shot("lifecycle-re-edit");
          await host.call("fake", { name: `next.${reworked}` });
          await reach(reworked);
          await rework.status("Edited", 30_000);
          await ui.waitFor(() => !rework.has("progressbar"), "the re-edit's bar to go", 10_000);

          await rework.press("Render Final 4K");
          await (await ui.dialog("Render Final 4K")).press("Render Final 4K");
          await rework.status("Rendering");
          await reach(reworked, true);
          value = await ui.waitFor(
            () => (valueIn(rework) >= 10 ? valueIn(rework) : 0),
            "the render bar at its first milestone (10%)",
          );
          ui.assert(value < 70, `the render bar shows ${value}% before the final file`);
          await host.call("fake", { name: `next.${reworked}` });
          await reach(reworked, true);
          value = await ui.waitFor(
            () => (valueIn(rework) >= 95 ? valueIn(rework) : 0),
            "the render bar at the written final file (95%)",
          );
          await host.shot("lifecycle-render");
          await host.call("fake", { name: `next.${reworked}` });
          await rework.status("Final rendered", 30_000);
          ui.log(`re-edit and render bars rose from 0 to ${value}%`);
        },
      },
    ],
  },
];

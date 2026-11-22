// The progress bar of a job in the browser (SPEC sections 6 and 9, Progress): the fake Claude Code
// works through the steps of a real edit one at a time (scenario "progress": the tool calls and
// [VIDAI_PROGRESS ...] markers of each step, then it waits for `next.<video>`), at text size 20 in
// the smallest window the desktop app allows (980 x 620 px), where the page is larger than the
// window (the floor of 980 x 620 zoomed px, SPEC section 12): it scrolls, and the top bar controls
// do not overlap. After every step the bar on the
// video row and the one in the activity panel (role "progressbar", read through aria-valuenow)
// show at least that milestone's value and never the next one's, they never go backwards, the
// row's stage label fits, and the row keeps its height. A completed bar stays full for 2.5 s,
// fades and leaves a clean row.
import { barValue, openPanel, reachProblem, softChecks } from "../jobs.mjs";
import { activity, row, status } from "../ui.mjs";

const VIDEO = "001 Landscape Clip";

/** Where each step of the edit model ends (SPEC section 6, Progress), and the value of the next
 * milestone, which the bar may approach but not reach before the step is done. */
const STEPS = [
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

/** The smallest layout (`MIN_LAYOUT_SIZE` in src/app/appearance.ts) and the text size's zoom. */
const FLOOR = { width: 980, height: 620, zoom: 20 / 13 };

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "progress",
  title: "The progress bar rises through the milestones of an edit, at text size 20",
  timeout: 240_000,
  async run(t) {
    await t.seedLibrary([[VIDEO, "landscape"]], { textSize: 20 });
    await t.fakeSet("scenario", "progress");
    const server = await t.startServer();
    const page = await t.open(server);
    await page.setViewportSize({ width: 980, height: 620 });
    const video = row(page, VIDEO);
    await video.waitFor();

    // The floor: the page is 980 x 620 zoomed px (about 1508 x 954 on screen) and scrolls in this
    // smaller window, and no control of the top bar sits on another.
    const floor = await page.evaluate(() => {
      /** @type {any} */
      const w = globalThis;
      const root = w.document.documentElement;
      const controls = [
        ...w.document.querySelectorAll("button,[role=combobox],[role=radio],[role=tab],input"),
      ].filter(
        (/** @type {any} */ el) =>
          !el.closest("[role=listitem]") && el.getBoundingClientRect().width > 0,
      );
      /** @type {string[]} */
      const overlaps = [];
      for (const [i, a] of controls.entries()) {
        for (const b of controls.slice(i + 1)) {
          if (a.contains(b) || b.contains(a)) continue;
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (x > 1 && y > 1) overlaps.push(`${a.textContent?.trim()} x ${b.textContent?.trim()}`);
        }
      }
      return {
        width: root.scrollWidth,
        height: root.scrollHeight,
        clientWidth: root.clientWidth,
        clientHeight: root.clientHeight,
        overlaps,
      };
    });
    t.assert(
      Math.abs(floor.width - FLOOR.width * FLOOR.zoom) < 2 &&
        Math.abs(floor.height - FLOOR.height * FLOOR.zoom) < 2,
      `the page is ${floor.width} x ${floor.height} px, not the floor 980 x 620 zoomed`,
    );
    t.assert(
      floor.width > floor.clientWidth && floor.height > floor.clientHeight,
      "the page does not scroll in a window smaller than the floor",
    );
    t.assert(
      floor.overlaps.length === 0,
      `top bar controls overlap at the smallest window: ${floor.overlaps.join("; ")}`,
    );

    /** The row's size, and its stage label (if the row shows one) in full. */
    const rowState = () =>
      video.evaluate((el) => {
        const summary = el.querySelector("[data-progress-summary]");
        const stage = summary?.firstElementChild;
        return {
          height: el.getBoundingClientRect().height,
          stage: stage
            ? {
                text: String(stage.textContent),
                scrollWidth: stage.scrollWidth,
                clientWidth: stage.clientWidth,
              }
            : null,
          summary: summary ? String(summary.textContent) : null,
        };
      });
    const height = (await rowState()).height;
    /** @param {string} when */
    const checkRow = async (when) => {
      const state = await rowState();
      t.equal(state.height, height, `the row height ${when}`);
      if (state.stage) {
        // Whole px round apart in a fractional layout.
        t.assert(
          state.stage.scrollWidth <= state.stage.clientWidth + 1,
          `the stage "${state.stage.text}" is cut off on the row ${when} (${state.stage.scrollWidth} > ${state.stage.clientWidth} px)`,
        );
      }
      return state;
    };

    // Every button of the Start Editing sheet can be reached at this text size and window size.
    // A failure here is kept and fails the scenario at its end, so the bar is still checked; the
    // edit is started with Cmd+Return (the sheet's keyboard shortcut) so this does not depend on it.
    const soft = softChecks();
    await video.getByRole("button", { name: "Start Editing" }).click();
    const sheet = page.getByRole("dialog", { name: "Start Editing" });
    await sheet.waitFor();
    const problem = await reachProblem(page, sheet);
    soft.check(!problem, `the Start Editing sheet at text size 20 has a button ${problem}`);
    await t.shot(page, "start-sheet-text-size-20");
    await page.keyboard.press("Meta+Enter");
    await sheet.waitFor({ state: "detached" });
    await status(video, "Editing");
    await checkRow("when the edit starts");

    let last = 0;
    for (const [index, [atLeast = 0, below = 100]] of STEPS.entries()) {
      const step = index + 1;
      await t.waitFake(`reached.${VIDEO}`);
      await t.fakeRemove(`reached.${VIDEO}`);
      // The row with the activity panel closed (the widest list), then the panel.
      const value = await t.waitFor(async () => {
        const v = await barValue(video);
        return v >= atLeast ? v : 0;
      }, `the row progress bar at ${atLeast}% or more after step ${step}`);
      t.assert(value < below, `the row bar shows ${value}%, below ${below}% expected`);
      t.assert(value >= last, `the row bar went back from ${last}% to ${value}%`);
      await checkRow(`after step ${step}`);
      const panel = await openPanel(page, video, VIDEO);
      const inPanel = await t.waitFor(async () => {
        const v = await barValue(panel);
        return v >= atLeast ? v : 0;
      }, `the activity panel progress bar at ${atLeast}% or more after step ${step}`);
      t.assert(inPanel < below, `the panel bar shows ${inPanel}%, below ${below}%`);
      t.equal((await rowState()).height, height, "the row height with the panel");
      last = await barValue(video);
      t.note(`step ${step}: ${last}%, ${(await rowState()).summary}`);
      if (step === 3) await t.shot(page, "progress-planned");
      if (step === 8) await t.shot(page, "progress-review-saved");
      await page.keyboard.press("Escape");
      await activity(page).waitFor({ state: "detached" });
      await t.fakeSet(`next.${VIDEO}`);
    }

    // Done: the full bar stays for 2.5 s, fades out and leaves a clean row.
    await status(video, "Edited", 30_000);
    const doneAt = Date.now();
    t.equal(await barValue(video), 100, "the bar of a done edit");
    await t.shot(page, "progress-done");
    await t.waitFor(
      async () => (await video.getByRole("progressbar").count()) === 0,
      "the completed bar to go",
      10_000,
    );
    const shown = Date.now() - doneAt;
    t.assert(shown >= 2000, `the completed bar went after ${shown} ms, before its 2.5 s`);
    t.equal((await rowState()).height, height, "the row height after the bar");
    t.note(`the completed bar went ${shown} ms after Edited`);
    await t.shot(page, "progress-done-clean");

    const panel = await openPanel(page, video, VIDEO);
    await panel.getByRole("tab", { name: "Log" }).click();
    await panel.getByText("Transcription done").first().waitFor();
    await panel.getByText("Review project saved").first().waitFor();
    t.assert(!(await panel.innerText()).includes("VIDAI_PROGRESS"), "no raw progress markers");
    t.equal(await panel.getByRole("progressbar").count(), 0, "bars in the panel of a done edit");
    soft.done();
  },
};

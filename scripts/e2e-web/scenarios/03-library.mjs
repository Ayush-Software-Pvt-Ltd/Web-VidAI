// The library: a seeded library lists its channel and videos with their Long / Short types, a
// thumbnail really loads through `/api/asset` (SPEC section 12, Routes), and a video folder
// created on disk shows up when the tab gets focus again (SPEC section 12, User interface in the
// browser).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CHANNEL, reviewFile } from "../../e2e/library.mjs";
import { png } from "../../e2e/media.mjs";
import { row, status, activity } from "../ui.mjs";

const EDITED = "001 Landscape Clip";
const PORTRAIT = "002 Portrait Clip";
const ROTATED = "003 Rotated Clip";
const NEW_VIDEO = "004 Added Later";

/** What the page's focus handler throttles by (`RESCAN_THROTTLE_MS`, src/app/useRescanOnFocus.ts). */
const RESCAN_THROTTLE_MS = 2000;

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "library",
  title: "Channel and videos listed, thumbnails through /api/asset, a new folder after focus",
  async run(t) {
    await t.seedLibrary([
      [EDITED, "landscape"],
      [PORTRAIT, "portrait"],
      [ROTATED, "rotated"],
    ]);
    // One video already has an edit: a review project and two thumbnails.
    const output = path.join(t.editing, CHANNEL, EDITED, "output");
    await mkdir(output, { recursive: true });
    await writeFile(
      path.join(output, reviewFile(EDITED, 1)),
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.11"><resources/><library/></fcpxml>\n',
    );
    for (const n of [1, 2]) await writeFile(path.join(output, `thumbnail-${n}.png`), png(320, 180));
    await writeFile(path.join(output, "meta.txt"), "Title: a test video\n");

    const server = await t.startServer();
    const page = await t.open(server);
    const opened = Date.now();

    // The channel and the videos, with the type the core detected from each A-roll.
    await page
      .getByRole("button", { name: new RegExp(CHANNEL) })
      .first()
      .waitFor();
    const edited = row(page, EDITED);
    await edited.waitFor();
    await status(edited, "Edited");
    await edited.getByRole("button", { name: /^Video type: Long 16:9\./ }).waitFor();
    await row(page, PORTRAIT)
      .getByRole("button", { name: /^Video type: Short 9:16\./ })
      .waitFor();
    await row(page, ROTATED)
      .getByRole("button", { name: /^Video type: Short 9:16\./ })
      .waitFor();
    t.equal(await page.locator('[role="listitem"][data-video-id]').count(), 3, "the video rows");
    await edited.getByRole("button", { name: "Re-Edit" }).waitFor();
    await t.shot(page, "library");

    // The thumbnails come through /api/asset and really decode.
    await edited.getByRole("button", { name: EDITED, exact: true }).click();
    const panel = activity(page);
    await panel.getByRole("tab", { name: "Outputs" }).click();
    await panel.getByText("Thumbnails").waitFor();
    const images = panel.locator("img");
    await t.waitFor(async () => (await images.count()) >= 2, "two thumbnails in the panel");
    const loaded = await t.waitFor(async () => {
      const found = await images.evaluateAll((all) =>
        all.map((img) => {
          /** @type {any} */
          const el = img;
          return {
            src: String(el.getAttribute("src")),
            width: Number(el.naturalWidth),
            complete: Boolean(el.complete),
          };
        }),
      );
      return found.length >= 2 && found.every((i) => i.complete && i.width > 0) ? found : null;
    }, "two decoded thumbnails");
    for (const image of loaded) {
      t.assert(
        image.src.includes("/api/asset?path="),
        `a thumbnail comes from /api/asset: ${image.src}`,
      );
      t.equal(image.width, 320, "the thumbnail's natural width");
    }
    await t.shot(page, "outputs-thumbnails");

    // A folder made on disk shows up when the tab gets focus again. A headless browser has no
    // window focus to give back, so the page gets the events the browser sends: the tab went
    // hidden and is visible again, and the window got focus. The page rescans at most every
    // 2 s, so the focus comes after that.
    const folder = await t.video(CHANNEL, NEW_VIDEO, "landscape");
    t.assert(folder.endsWith(NEW_VIDEO), "the new video folder exists on disk");
    const wait = RESCAN_THROTTLE_MS + 200 - (Date.now() - opened);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    await page.evaluate(() => {
      /** @type {any} */
      const w = globalThis;
      w.dispatchEvent(new w.Event("blur"));
      w.document.dispatchEvent(new w.Event("visibilitychange"));
      w.dispatchEvent(new w.Event("focus"));
    });
    await row(page, NEW_VIDEO).waitFor({ timeout: 10_000 });
    await status(row(page, NEW_VIDEO), /\S/);
    t.equal(await page.locator('[role="listitem"][data-video-id]').count(), 4, "the video rows");
    await t.shot(page, "library-after-focus");
  },
};

// Appearance (SPEC section 9 and section 12): the text size in Settings sets the root `zoom` (the
// page zooms itself in a browser) and survives a reload, the browser's own zoom keys are left to the
// browser, the theme sets `data-theme` and survives a reload too.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { row } from "../ui.mjs";

const VIDEO = "001 Landscape Clip";

/** `appearance::zoom_factor`: the text size over the base size of 13. */
const zoomOf = (/** @type {number} */ size) => size / 13;

/** @param {import("playwright").Page} page */
function pageScroll(page) {
  return page.evaluate(() => {
    /** @type {any} */
    const w = globalThis;
    const root = w.document.documentElement;
    return {
      x: root.scrollWidth - root.clientWidth,
      y: root.scrollHeight - root.clientHeight,
    };
  });
}

/** @param {import("playwright").Page} page */
function pageState(page) {
  return page.evaluate(() => {
    /** @type {any} */
    const w = globalThis;
    const root = w.document.documentElement;
    return {
      zoom: Number(w.getComputedStyle(root).zoom),
      inline: String(root.style.zoom),
      theme: root.dataset.theme === undefined ? null : String(root.dataset.theme),
      scheme: String(w.getComputedStyle(root).colorScheme),
    };
  });
}

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "appearance",
  title: "Text size sets the root zoom and survives a reload, the theme sets data-theme",
  async run(t) {
    await t.seedLibrary([[VIDEO, "landscape"]]);
    const settingsOnDisk = async () =>
      JSON.parse(await readFile(path.join(t.data, "settings.json"), "utf8"));
    const server = await t.startServer();
    const page = await t.open(server);
    await row(page, VIDEO).waitFor();

    /** @param {number} size */
    const expectZoom = async (size) => {
      await t.waitFor(
        async () => Math.abs((await pageState(page)).zoom - zoomOf(size)) < 0.002,
        `the page zoom for text size ${size} (${zoomOf(size).toFixed(3)})`,
        10_000,
      );
    };
    /** @param {import("playwright").Page} where */
    const openAppearance = async (where) => {
      await where.getByRole("button", { name: "Settings" }).click();
      await where
        .getByRole("navigation", { name: "Settings" })
        .getByRole("button", { name: "Appearance" })
        .click();
    };

    // A fresh install: the default text size, following the browser's colour scheme.
    await expectZoom(15);
    const first = await pageState(page);
    t.equal(first.theme, null, "no forced theme at first");
    await openAppearance(page);
    await page.getByRole("status", { name: "Text size 15 points" }).waitFor();
    await t.shot(page, "settings-appearance-default");

    // A window at least as large as the floor (980 x 620 zoomed px) has no scrollbar; a smaller
    // one scrolls instead of squeezing the layout (SPEC section 12).
    await page.setViewportSize({ width: 1280, height: 800 });
    t.equal(JSON.stringify(await pageScroll(page)), '{"x":0,"y":0}', "scroll at 1280x800");
    await page.setViewportSize({ width: 980, height: 620 });
    const small = await pageScroll(page);
    t.assert(
      Math.abs(small.x - (980 * zoomOf(15) - 980)) < 2 &&
        Math.abs(small.y - (620 * zoomOf(15) - 620)) < 2,
      `the page scrolls ${small.x} x ${small.y} px at 980x620 (floor 980 x 620 zoomed)`,
    );
    await page.setViewportSize({ width: 1280, height: 800 });

    // The text size buttons zoom the page at once and are saved.
    await page.getByRole("button", { name: "Make Text Bigger" }).click();
    await page.getByRole("status", { name: "Text size 16 points" }).waitFor();
    await expectZoom(16);
    await page.getByRole("button", { name: "Make Text Bigger" }).click();
    await page.getByRole("button", { name: "Make Text Bigger" }).click();
    await page.getByRole("status", { name: "Text size 18 points" }).waitFor();
    await expectZoom(18);
    await page.getByRole("button", { name: "Make Text Smaller" }).click();
    await page.getByRole("status", { name: "Text size 17 points" }).waitFor();
    await expectZoom(17);
    await t.waitFor(async () => (await settingsOnDisk()).textSize === 17, "17 saved on disk");

    // The browser's own zoom keys stay with the browser: the page ignores them.
    for (const key of ["Meta+=", "Meta+-", "Meta+0", "Control+="]) await page.keyboard.press(key);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expectZoom(17);
    t.equal((await settingsOnDisk()).textSize, 17, "the zoom keys changed nothing on disk");

    // The theme sets data-theme (and so the `color-scheme` the page is drawn in).
    await page.getByRole("radio", { name: "Dark" }).click();
    await t.waitFor(async () => (await pageState(page)).theme === "dark", "data-theme=dark");
    t.equal((await pageState(page)).scheme, "dark", "the page is drawn dark");
    await t.shot(page, "settings-appearance-dark-17");
    await page.getByRole("radio", { name: "Light" }).click();
    await t.waitFor(async () => (await pageState(page)).theme === "light", "data-theme=light");
    t.equal((await pageState(page)).scheme, "light", "the page is drawn light");
    await page.getByRole("radio", { name: "Dark" }).click();
    await t.waitFor(async () => (await settingsOnDisk()).theme === "dark", "dark saved on disk");

    // Both survive a reload.
    await page.reload();
    await row(page, VIDEO).waitFor();
    await expectZoom(17);
    const after = await pageState(page);
    t.equal(after.theme, "dark", "data-theme after the reload");
    t.equal(after.scheme, "dark", "the page is drawn dark after the reload");
    await openAppearance(page);
    await page.getByRole("status", { name: "Text size 17 points" }).waitFor();
    await t.shot(page, "settings-after-reload");

    // System follows the browser again, and Done leaves Settings.
    await page.getByRole("radio", { name: "System" }).click();
    await t.waitFor(async () => (await pageState(page)).theme === null, "no forced theme again");
    await page.getByRole("button", { name: "Done" }).click();
    await row(page, VIDEO).waitFor();
    await t.waitFor(async () => (await settingsOnDisk()).theme === "system", "system saved");
  },
};

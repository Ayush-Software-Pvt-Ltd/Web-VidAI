// What a browser tab does with the Outputs tab, the clipboard and the keyboard (SPEC section 12):
// thumbnails load through /api/asset, Copy puts the session id on the clipboard, and the shortcuts
// the page can have in a browser work: Cmd+Return submits the job sheet, Cmd+S saves an edited
// prompt, Cmd+F focuses the search field (Ctrl on Windows), each taking the key from the browser's
// own find and save. Cmd+, and Cmd/Ctrl with =, -, 0 are not asserted: Cmd+, belongs to the
// browser on a Mac and the zoom keys are left to the browser's own zoom by design (the
// appearance scenario covers that). The row menu and the search field's key hint use the
// platform's words.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CHANNEL } from "../../e2e/library.mjs";
import { currentInterface } from "../../e2e/interface.mjs";
import { png } from "../../e2e/media.mjs";
import { openPanel, returnToTab, sessions } from "../jobs.mjs";
import { row, status } from "../ui.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "outputs-copy-shortcuts",
  title: "Thumbnails through /api/asset, copy to the clipboard, Cmd+Return, Cmd+S and Cmd+F",
  async run(t) {
    const platform = currentInterface();
    const modifier = platform.modifier === "meta" ? "Meta" : "Control";
    await t.seedLibrary([[VIDEO, "landscape"]]);
    const server = await t.startServer();
    // Reading the clipboard needs the browser's permission; the user's own clipboard is never
    // touched (this is a browser of its own).
    const context = await t.newContext();
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: server.origin,
    });
    const page = await t.open(server, context);
    const video = row(page, VIDEO);
    await video.waitFor();

    // Every key press the page sees. The events themselves are kept: whether the page took a key
    // from the browser (a key the page did not use would open the browser's find bar, save dialog
    // or settings) is only known once every handler has run, so it is read afterwards.
    await page.evaluate(() => {
      /** @type {any} */
      const w = globalThis;
      w.__keys = [];
      w.addEventListener("keydown", (/** @type {any} */ e) => {
        w.__keys.push(e);
      });
    });
    /** Whether the page took the key (the browser's own action is suppressed). @param {string} key */
    const taken = async (key) =>
      page.evaluate((k) => {
        /** @type {any} */
        const w = globalThis;
        const hits = w.__keys.filter(
          (/** @type {any} */ e) =>
            (e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === k.toLowerCase(),
        );
        return hits.length > 0 && hits.every((/** @type {any} */ e) => e.defaultPrevented);
      }, key);

    // Cmd+Return submits the job sheet.
    await video.getByRole("button", { name: "Start Editing" }).click();
    const sheet = page.getByRole("dialog", { name: "Start Editing" });
    await sheet.getByLabel("Notes").fill("Started with the keyboard.");
    await page.keyboard.press(`${modifier}+Enter`);
    await sheet.waitFor({ state: "detached" });
    await status(video, "Edited", 30_000);
    t.assert(await taken("Enter"), "the page took Cmd+Return from the browser");
    const [call] = await sessions(t);
    t.assert(
      call?.messages[0]?.includes("Started with the keyboard."),
      "the notes of the sheet submitted with the keyboard reached Claude Code",
    );

    // Thumbnails written after the edit show in the Outputs tab, through /api/asset.
    const out = path.join(t.editing, CHANNEL, VIDEO, "output");
    for (const n of [1, 2]) await writeFile(path.join(out, `thumbnail-${n}.png`), png(320, 180));

    // The row menu names the platform's file manager (it is not clicked: that would open it).
    await video.getByRole("button", { name: `More for ${VIDEO}` }).click();
    await page.getByRole("menuitem", { name: platform.revealLabel }).waitFor();
    await t.shot(page, "row-menu");
    await page.keyboard.press("Escape");
    await page.getByRole("menuitem", { name: platform.revealLabel }).waitFor({ state: "detached" });

    const panel = await openPanel(page, video, VIDEO);
    await panel.getByRole("tab", { name: "Outputs" }).click();
    await panel.getByText("Thumbnails").waitFor();
    const images = panel.locator("img");
    // The files were made outside VidAI, so they show when the person comes back to the tab.
    const loaded = await t.waitFor(async () => {
      await returnToTab(page);
      const found = await images.evaluateAll((all) =>
        all.map((img) => {
          /** @type {any} */
          const el = img;
          return { src: String(el.getAttribute("src")), width: Number(el.naturalWidth) };
        }),
      );
      return found.length >= 2 && found.every((i) => i.width > 0) ? found : null;
    }, "two decoded thumbnails");
    for (const image of loaded) {
      t.assert(
        image.src.includes("/api/asset?path="),
        `a thumbnail comes from /api/asset: ${image.src}`,
      );
    }
    await t.shot(page, "outputs-thumbnails");

    // Copy puts the session id on the clipboard (a sentinel is there first).
    await panel.getByRole("tab", { name: "Log" }).click();
    const sid = call?.sid ?? "";
    t.assert(sid !== "", "the fake Claude Code had a session id");
    await page.evaluate(() => {
      /** @type {any} */
      const w = globalThis;
      return w.navigator.clipboard.writeText("before the copy");
    });
    await panel.getByRole("button", { name: "Copy session ID" }).click();
    await t.waitFor(
      async () =>
        (await page.evaluate(() => {
          /** @type {any} */
          const w = globalThis;
          return w.navigator.clipboard.readText();
        })) === sid,
      "the session id on the clipboard",
    );
    await panel.getByRole("button", { name: "Copied" }).waitFor();

    // Settings, Channels: Cmd+S saves an edited prompt, and the prompt is on disk afterwards.
    await page.getByRole("button", { name: "Settings" }).click();
    const nav = page.getByRole("navigation", { name: "Settings" });
    await nav.getByRole("button", { name: /^Channels/ }).click();
    await page.getByRole("button", { name: /^Tech Reviews/ }).click();
    await page.getByRole("textbox", { name: "Long 16:9 prompt" }).fill("Saved with Cmd+S.");
    const save = page.getByRole("button", { name: "Save", exact: true });
    await save.waitFor();
    t.assert(await page.getByText("Unsaved changes").first().isVisible(), "the edit is unsaved");
    await page.keyboard.press(`${modifier}+s`);
    await t.waitFor(
      async () =>
        (await save.isDisabled()) && (await page.getByText("Unsaved changes").count()) === 0,
      "Cmd+S to save the prompt",
    );
    t.assert(await taken("s"), "the page took Cmd+S from the browser");
    const saved = JSON.parse(await readFile(path.join(t.data, "settings.json"), "utf8"));
    t.equal(
      saved.channels[0].long.prompts[0].text,
      "Saved with Cmd+S.",
      "the prompt saved with Cmd+S",
    );
    await page.getByRole("button", { name: "Done" }).click();

    // Cmd+F focuses the search field, whose key hint names the platform's key.
    await video.waitFor();
    const hint = await page.locator("main > header kbd").first().textContent();
    t.assert(
      hint !== null && hint.startsWith(platform.modifierLabel),
      `the search field's key hint is ${JSON.stringify(hint)}, expected ${platform.modifierLabel}F`,
    );
    await page.keyboard.press(`${modifier}+f`);
    await t.waitFor(
      async () =>
        page.evaluate(() => {
          /** @type {any} */
          const w = globalThis;
          const el = w.document.activeElement;
          return /search/i.test(
            `${String(el?.getAttribute("aria-label"))} ${String(el?.getAttribute("placeholder"))}`,
          );
        }),
      "Cmd+F to focus the search field",
    );
    t.assert(await taken("f"), "the page took Cmd+F from the browser");
    await t.shot(page, "search-focused");
  },
};

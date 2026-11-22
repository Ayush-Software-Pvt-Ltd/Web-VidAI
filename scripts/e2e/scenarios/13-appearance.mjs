// Appearance: the theme and the text size change through Settings, the keyboard shortcuts and the
// View menu items (macOS; on Windows the hook runs the same Rust code), apply to the real window at
// once (native page zoom, native appearance that the web content's colour scheme follows) and are
// still applied after a relaunch.
//
// The zoom is measured as the window's content width in points (DIPs on Windows) divided by the
// page's width in CSS px. The screenshots let a person check what the page cannot see: the
// traffic lights centred in the top bar at every size, and the title bar in the chosen theme.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { seedLibrary } from "../library.mjs";

const VIDEO = "001 Landscape Clip";

/** @param {import("../types.mjs").Context} ctx */
async function settingsFile(ctx) {
  return JSON.parse(await readFile(path.join(ctx.data, "settings.json"), "utf8"));
}

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "appearance",
  title: "Theme and text size from Settings, shortcuts and the View menu, kept after a relaunch",
  timeout: 120_000,
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    ctx.params.video = VIDEO;
  },
  ops: {
    /** @param {import("../types.mjs").Context} ctx @param {{ theme: string, textSize: number }} args */
    async checkSaved(ctx, args) {
      const settings = await settingsFile(ctx);
      if (settings.theme !== args.theme || settings.textSize !== args.textSize) {
        throw new Error(
          `settings.json has theme ${String(settings.theme)} and text size ${String(settings.textSize)}, expected ${args.theme} and ${String(args.textSize)}`,
        );
      }
      return true;
    },
  },
  launches: [
    {
      exits: true,
      async page(ui, host) {
        /** @type {any} */
        const page = globalThis;
        /** Waits until the window is zoomed for text size `size`. */
        const expectZoom = async (/** @type {number} */ size) => {
          const want = size / 13;
          await ui.waitFor(
            async () => {
              const win = await host.native("window");
              const zoom = win.innerWidth / page.innerWidth;
              return Math.abs(zoom - want) < 0.02 ? zoom : null;
            },
            `the page zoom for text size ${String(size)} (${want.toFixed(3)})`,
          );
        };
        /** Waits until Settings shows text size `size` and the window is zoomed for it. */
        const expectSize = async (/** @type {number} */ size) => {
          await ui.text(`${String(size)} pt`);
          await expectZoom(size);
        };
        /** Waits until the page is in `scheme` and has the theme attribute of `theme`. */
        const expectTheme = async (
          /** @type {"system" | "light" | "dark"} */ theme,
          /** @type {boolean} */ dark,
        ) => {
          await ui.waitFor(
            () =>
              page.document.documentElement.dataset.theme ===
                (theme === "system" ? undefined : theme) &&
              page.matchMedia("(prefers-color-scheme: dark)").matches === dark,
            `the ${theme} theme (${dark ? "dark" : "light"})`,
          );
          // Native panels (the folder picker, alerts) are drawn in the app's AppKit appearance.
          const native = await host.native("appearance");
          ui.assert(
            /Dark/.test(native) === dark,
            `the app's native appearance is ${native} with the ${theme} theme`,
          );
        };

        await ui.row("001 Landscape Clip", 30_000);
        // A fresh install: the default text size, following macOS.
        await expectZoom(15);
        const systemDark = await host.call("systemDark");
        await expectTheme("system", systemDark);
        await host.shot("default-size");

        await ui.shortcut(",");
        const nav = ui.within(await ui.find("navigation", "Settings"));
        await nav.click("button", "Appearance");
        await expectSize(15);

        // Theme, from Settings.
        await ui.click("radio", "Dark");
        await expectTheme("dark", true);
        await host.shot("dark");
        await ui.click("radio", "Light");
        await expectTheme("light", false);
        await host.shot("light");

        // Text size: the buttons, the shortcut in the page, and the View menu (Rust).
        await ui.press("Make Text Bigger");
        await expectSize(16);
        await ui.shortcut("=");
        await expectSize(17);
        await host.call("stdin", { line: "!menu vidai-text-smaller" });
        await expectSize(16);
        for (let i = 0; i < 6; i++) await host.call("stdin", { line: "!menu vidai-text-bigger" });
        await expectSize(20);
        ui.assert(
          ui.state(await ui.find("button", "Make Text Bigger")).disabled,
          "Make Text Bigger is disabled at the largest size",
        );
        await host.shot("largest-size");
        await ui.press("Done");
        await ui.row("001 Landscape Clip");
        await host.shot("largest-size-main");

        await ui.shortcut("-");
        await ui.shortcut("-");
        await ui.shortcut(",");
        // Settings was left and opened again: its navigation is a new element.
        await ui.within(await ui.find("navigation", "Settings")).click("button", "Appearance");
        await expectSize(18);
        await ui.click("radio", "Dark");
        await expectTheme("dark", true);
        await host.call("checkSaved", { theme: "dark", textSize: 18 });
        await host.call("stdin", { line: "!quit" });
      },
    },
    {
      async page(ui, host) {
        /** @type {any} */
        const page = globalThis;
        await ui.row("001 Landscape Clip", 30_000);
        // Applied before the page could do anything: the window was zoomed and dark at launch.
        const win = await host.native("window");
        ui.assert(
          Math.abs(win.innerWidth / page.innerWidth - 18 / 13) < 0.02,
          `the relaunched window is zoomed for text size 18 (window ${String(win.innerWidth)} pt, page ${String(page.innerWidth)} px)`,
        );
        ui.assert(
          page.matchMedia("(prefers-color-scheme: dark)").matches,
          "the relaunched window is dark",
        );
        ui.equal(page.document.documentElement.dataset.theme, "dark", "the theme attribute");
        // Usage is not kept across launches: placeholders hold the meters' place until Claude
        // Code answers (seconds; Git Bash makes it slower on Windows), then the meters show.
        await ui.find("button", /^Usage limits: 5-hour limit/, 30_000);
        await host.shot("relaunched-dark-18");

        // Cmd+0 returns to the default size; System follows macOS again.
        await ui.shortcut("0");
        await ui.shortcut(",");
        await ui.within(await ui.find("navigation", "Settings")).click("button", "Appearance");
        await ui.text("15 pt");
        await ui.click("radio", "System");
        const systemDark = await host.call("systemDark");
        await ui.waitFor(
          () =>
            page.document.documentElement.dataset.theme === undefined &&
            page.matchMedia("(prefers-color-scheme: dark)").matches === systemDark,
          "the System theme",
        );
        await host.call("checkSaved", { theme: "system", textSize: 15 });
        await host.shot("relaunched-back-to-default");
      },
    },
  ],
};

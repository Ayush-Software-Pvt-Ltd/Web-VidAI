// A small laptop screen (1366 x 768, the smallest common Windows screen) at 100 % scaling: the
// window launches at a size that fits the screen with its title bar and borders, centred and
// never below its minimum; the minimum leaves room for the frame; and nothing is cut off, at the
// default text size and at 20 (SPEC section 11, Window and appearance).
//
// The runner changes the display mode only on CI, never on a person's own PC, and puts the
// large screen back afterwards. Display scaling (125 %, 150 %) is not checked: Windows applies a
// changed scaling to running sessions only after signing out, which a CI runner cannot do.
import { currentInterface } from "../interface.mjs";
import { seedLibrary } from "../library.mjs";

const VIDEO = "001 Landscape Clip";

/**
 * The in-page checks of one text size, shared by both launches (`window.__vidaiShared`).
 * @param {import("../types.mjs").Ui} ui @param {import("../types.mjs").Host} host
 * @param {number} size @param {boolean} launched the window was just launched at this size
 */
async function checkFits(ui, host, size, launched) {
  /** @type {any} */
  const page = globalThis;
  const win = await host.native("window");
  const screen = win.screen;
  ui.assert(screen, "the window's screen is known");
  ui.log(
    `size ${size}: window ${win.width.toFixed(0)} x ${win.height.toFixed(0)} at ${win.x.toFixed(0)}, ${win.y.toFixed(0)} (content ${win.innerWidth.toFixed(0)} x ${win.innerHeight.toFixed(0)}), work area ${screen.width} x ${screen.height} at ${screen.x}, ${screen.y}, page ${page.innerWidth} x ${page.innerHeight} CSS px`,
  );
  const slack = 1;
  ui.assert(
    win.x >= screen.x - slack &&
      win.y >= screen.y - slack &&
      win.x + win.width <= screen.x + screen.width + slack &&
      win.y + win.height <= screen.y + screen.height + slack,
    `at size ${size} the window (${win.width.toFixed(0)} x ${win.height.toFixed(0)} at ${win.x.toFixed(0)}, ${win.y.toFixed(0)}) does not fit the work area`,
  );
  const [minWidth, minHeight] = await host.native("minSize");
  const frame = [win.width - win.innerWidth, win.height - win.innerHeight];
  ui.assert(
    minWidth + frame[0] <= screen.width + slack && minHeight + frame[1] <= screen.height + slack,
    `at size ${size} the minimum ${minWidth} x ${minHeight} with the frame does not fit the work area`,
  );
  ui.assert(
    win.innerWidth + 0.5 >= minWidth && win.innerHeight + 0.5 >= minHeight,
    `at size ${size} the window is smaller than its minimum ${minWidth} x ${minHeight}`,
  );
  if (launched) {
    // The new window (1240 x 800) made as small as the screen needs, never below the minimum
    // (appearance::launch_size).
    const room = [screen.width - frame[0], screen.height - frame[1]];
    const want = [
      Math.min(Math.max(1240, minWidth), room[0]),
      Math.min(Math.max(800, minHeight), room[1]),
    ];
    ui.assert(
      Math.abs(win.innerWidth - want[0]) <= 1.5 && Math.abs(win.innerHeight - want[1]) <= 1.5,
      `at size ${size} the window launched at ${win.innerWidth.toFixed(0)} x ${win.innerHeight.toFixed(0)}, expected ${want[0].toFixed(0)} x ${want[1].toFixed(0)}`,
    );
    const centre = [win.x + win.width / 2, win.y + win.height / 2];
    const middle = [screen.x + screen.width / 2, screen.y + screen.height / 2];
    ui.assert(
      Math.abs(centre[0] - middle[0]) <= 2 && Math.abs(centre[1] - middle[1]) <= 2,
      `at size ${size} the launched window is not centred on the work area`,
    );
  }

  // Nothing is cut off: no sideways scrolling, every control of the top bar and the sidebar's
  // Settings button inside the page.
  const doc = page.document;
  ui.assert(
    doc.documentElement.scrollWidth <= page.innerWidth + 1,
    `at size ${size} the page scrolls sideways (${doc.documentElement.scrollWidth} > ${page.innerWidth})`,
  );
  const outside = [...doc.querySelectorAll("main > header button, aside button")]
    .filter((/** @type {any} */ b) => b.getClientRects().length > 0)
    .map((/** @type {any} */ b) => ({
      name: b.getAttribute("aria-label") ?? b.textContent,
      r: b.getBoundingClientRect(),
    }))
    .filter(({ r }) => r.right > page.innerWidth + 0.5 || r.bottom > page.innerHeight + 0.5)
    .map(({ name }) => name);
  ui.equal(outside, [], `controls cut off at size ${size}`);
}

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "small-screen",
  title: "On a 1366 x 768 screen the window launches fitting, and nothing is cut off at 15 and 20",
  skip:
    currentInterface().os !== "windows"
      ? "the screen size of a Mac is not changed by the tests; window-geometry covers the minimum size"
      : process.env.CI !== "true"
        ? "changes the display resolution, which the tests do only on CI"
        : null,
  timeout: 180_000,
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    ctx.params.video = VIDEO;
    await ctx.platform.setDisplay(1366, 768);
  },
  async cleanup(ctx) {
    await ctx.platform.setDisplay(1920, 1080);
  },
  shared: { checkFits },
  launches: [
    {
      async page(ui, host, p) {
        /** @type {any} */
        const { __vidaiShared: shared } = globalThis;
        await ui.row(p.video, 30_000);
        await shared.checkFits(ui, host, 15, true);
        await host.shot("small-screen-15");
        // The largest text size, saved for the next launch.
        await ui.shortcut(",");
        await ui.within(await ui.find("navigation", "Settings")).click("button", "Appearance");
        for (let size = 16; size <= 20; size++) {
          await ui.press("Make Text Bigger");
          await ui.text(`${size} pt`);
        }
        await ui.press("Done");
        await ui.row(p.video);
        await shared.checkFits(ui, host, 20, false);
        await host.shot("small-screen-20-grown");
      },
    },
    {
      async page(ui, host, p) {
        /** @type {any} */
        const { __vidaiShared: shared } = globalThis;
        // Launched at 20 on the small screen.
        await ui.row(p.video, 30_000);
        await shared.checkFits(ui, host, 20, true);
        await host.shot("small-screen-20-launched");
        const row = await ui.row(p.video);
        await row.press("Start Editing");
        const sheet = await ui.dialog("Start Editing");
        await sheet.find("button", "Start Editing");
        await host.shot("small-screen-20-start-sheet");
        await ui.key("Escape");
        await ui.gone("dialog", "Start Editing");
        await ui.shortcut(",");
        await ui.within(await ui.find("navigation", "Settings")).click("button", /^System/);
        await ui.text("This computer:", 20_000);
        await host.shot("small-screen-20-settings-system");
      },
    },
  ],
};

// The native side of the text size, measured in the real window (SPEC section 9, Appearance):
// - macOS: the traffic lights sit 18 pt from the left, vertically centred on the top bar, at text
//   sizes 11, 13, 15, 17 and 20, and stay there after a resize, a zoom (the green button's zoom)
//   and full screen; a click anywhere on the top bar reaches the web content (its controls and its
//   drag region), although the native title bar container is as tall as the top bar, and a click
//   on a traffic light reaches the button; the View menu items are disabled at the limits;
// - everywhere: nothing in the top bar overlaps or sticks out, the page sees the window size
//   divided by the zoom, and the window never gets smaller than 980 x 620 CSS px (capped to the
//   screen); on Windows also when a person drags its corner;
// - the shortcuts Cmd+=, Cmd+Shift+= (Cmd+Plus), Cmd+- and Cmd+0 (Ctrl on Windows), pressed through
//   the OS like real keys, change the size by exactly one step (on Windows WebView2 has its own
//   zoom keys, which must not add a second step), on macOS also with the focus outside the web
//   content; on Windows Ctrl+F pressed for real focuses the search field.
// The screenshots show menus, sheets, tooltips and the activity panel at sizes 11 and 20.
import { seedLibrary } from "../library.mjs";

// The third name is Hindi in Devanagari and long, as real folder names are: it must render in a
// Devanagari font and be cut off cleanly at every text size.
const VIDEOS = [
  "001 Landscape Clip",
  "002 Portrait Clip",
  "003 नया फ़ोन रिव्यू - कैमरा, बैटरी और डिस्प्ले की पूरी जानकारी हिंदी में",
];

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "window-geometry",
  title:
    "Window size, top bar, text size keys in the real window (and the traffic lights on macOS)",
  timeout: 240_000,
  async prepare(ctx) {
    await seedLibrary(ctx, [
      [VIDEOS[0], "landscape"],
      [VIDEOS[1], "portrait"],
      [VIDEOS[2], "landscape"],
    ]);
    ctx.params.videos = VIDEOS;
  },
  launches: [
    {
      async page(ui, host, p) {
        /** @type {any} */
        const page = globalThis;
        const mac = ui.platform.os === "macos";
        const near = (/** @type {number} */ a, /** @type {number} */ b, tolerance = 0.51) =>
          Math.abs(a - b) <= tolerance;

        /** The window's zoom: its content width in points over the page width in CSS px. */
        const zoomNow = async () => {
          const win = await host.native("window");
          return win.innerWidth / page.innerWidth;
        };
        const expectZoom = async (/** @type {number} */ size) => {
          await ui.waitFor(
            async () => near(await zoomNow(), size / 13, 0.01),
            `the page zoom of text size ${size}`,
          );
        };
        /** Sets the text size through the View menu items (Rust), one step at a time. */
        let size = 15;
        const setSize = async (/** @type {number} */ target) => {
          while (size !== target) {
            const step = target > size ? "bigger" : "smaller";
            await host.call("stdin", { line: `!menu vidai-text-${step}` });
            size += target > size ? 1 : -1;
          }
          await expectZoom(target);
        };

        /** The traffic lights are where they belong (macOS). */
        const checkLights = async (/** @type {string} */ when) => {
          if (!ui.platform.trafficLights) return;
          const zoom = size / 13;
          const bar = 52 * zoom;
          await ui.waitFor(
            async () => {
              const lights = await host.native("trafficLights");
              if (lights.length !== 3) return null;
              const [close] = lights;
              return near(close[0], 18) && near(close[1] + close[3] / 2, bar / 2) ? lights : null;
            },
            `the traffic lights 18 pt from the left and centred on the ${bar.toFixed(1)} pt top bar (${when}, size ${size})`,
            5_000,
          );
          const lights = await host.native("trafficLights");
          ui.log(
            `size ${size}, ${when}: close button at ${lights[0].map((/** @type {number} */ v) => v.toFixed(1)).join(", ")}, bar ${bar.toFixed(1)} pt`,
          );
        };

        /** A click at the centre of `el` reaches the web content (asked of AppKit, macOS). */
        const clickReachesPage = async (/** @type {any} */ el, /** @type {string} */ what) => {
          if (!mac) return;
          const r = el.getBoundingClientRect();
          const zoom = size / 13;
          const chain = await host.native("hitTest", {
            x: (r.left + r.width / 2) * zoom,
            y: (r.top + r.height / 2) * zoom,
          });
          ui.assert(
            chain.some((/** @type {string} */ c) => /WebView/.test(c)),
            `a click on ${what} at size ${size} reaches ${chain[0]} (${chain.join(" < ")}), not the web content`,
          );
        };

        /** Every part of the top bar takes clicks in the page, the traffic lights stay native. */
        const checkTopBar = async () => {
          const header = page.document.querySelector("main > header");
          await clickReachesPage(header, "the top bar");
          await clickReachesPage(
            page.document.querySelector("aside > [data-tauri-drag-region]"),
            "the sidebar's top bar",
          );
          ui.assert(
            header.hasAttribute("data-tauri-drag-region") === ui.platform.dragRegions,
            ui.platform.dragRegions
              ? "the top bar is a drag region of the page"
              : "the top bar drags the window, although the native title bar does that",
          );
          for (const el of header.querySelectorAll("button, input, [role=radio], [role=tab]")) {
            if (el.getClientRects().length === 0) continue;
            await clickReachesPage(el, el.getAttribute("aria-label") ?? el.textContent.trim());
          }
          // Nothing in the top bar overlaps or sticks out of it (at every size, the window being
          // as small as it gets at large sizes).
          const parts = [...header.querySelectorAll(":scope > div > *")]
            .map((el) => ({ el, r: el.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0)
            .sort((a, b) => a.r.left - b.r.left);
          const bar = header.getBoundingClientRect();
          for (const [i, { el, r }] of parts.entries()) {
            const name = el.getAttribute("aria-label") ?? el.textContent.trim().slice(0, 30);
            const next = parts[i + 1];
            if (next) {
              ui.assert(
                r.right <= next.r.left + 0.5,
                `at size ${size} "${name}" overlaps "${next.el.getAttribute("aria-label") ?? next.el.textContent.trim().slice(0, 30)}" in the top bar`,
              );
            }
            ui.assert(
              r.right <= bar.right + 0.5,
              `at size ${size} "${name}" sticks out of the top bar`,
            );
          }
          if (!ui.platform.trafficLights) return;
          const [close] = await host.native("trafficLights");
          const chain = await host.native("hitTest", {
            x: close[0] + close[2] / 2,
            y: close[1] + close[3] / 2,
          });
          ui.assert(
            !chain.some((/** @type {string} */ c) => /WebView/.test(c)),
            `a click on the close button reaches the web content (${chain.join(" < ")})`,
          );
        };

        /** The smallest content size this text size allows, capped to the screen. */
        const wantedMinimum = async () => {
          const zoom = size / 13;
          const win = await host.native("window");
          const screen = win.screen ?? { width: Infinity, height: Infinity };
          // The window's frame (the Windows title bar) needs room on the screen too.
          const frame = [win.width - win.innerWidth, win.height - win.innerHeight];
          return [
            Math.min(980 * zoom, screen.width - frame[0]),
            Math.min(620 * zoom, screen.height - frame[1]),
          ];
        };

        /**
         * A person cannot make the window smaller than the smallest layout at this size (capped to
         * the screen), and a window that is smaller grows. (The limit itself is read: AppKit does
         * not apply it to a programmatic resize.)
         */
        const checkMinimum = async () => {
          const zoom = size / 13;
          const win = await host.native("window");
          const want = await wantedMinimum();
          const [minWidth, minHeight] = await host.native("minSize");
          ui.assert(
            near(minWidth, want[0], 1) && near(minHeight, want[1], 1),
            `the minimum window size at size ${size} is ${minWidth} x ${minHeight} pt, expected ${want[0].toFixed(0)} x ${want[1].toFixed(0)}`,
          );
          ui.assert(
            win.innerWidth + 0.5 >= want[0] && win.innerHeight + 0.5 >= want[1],
            `the window is ${win.innerWidth} x ${win.innerHeight} pt, smaller than the minimum at size ${size}`,
          );
          ui.log(
            `size ${size}: smallest window ${minWidth.toFixed(0)} x ${minHeight.toFixed(0)} pt = ${(minWidth / zoom).toFixed(0)} x ${(minHeight / zoom).toFixed(0)} CSS px; window ${win.innerWidth.toFixed(0)} x ${win.innerHeight.toFixed(0)} pt, page ${page.innerWidth} x ${page.innerHeight} CSS px (screen ${String(win.screen?.width)} x ${String(win.screen?.height)})`,
          );
          ui.assert(
            near(win.innerWidth / page.innerWidth, zoom, 0.01),
            `the page is ${page.innerWidth} CSS px wide in a ${win.innerWidth} pt window at size ${size}`,
          );
        };

        /**
         * Windows: a person drags the window's bottom-right corner far up and left; the window
         * stops at the minimum. The drag starts in the resize border just outside the visible
         * frame, as a person grabs it.
         */
        const checkDragToMinimum = async () => {
          if (mac) return;
          const win = await host.native("window");
          const scale = win.scale;
          const corner = [
            Math.round((win.x + win.width) * scale) - 3,
            Math.round((win.y + win.height) * scale) - 3,
          ];
          const after = await host.call("drag", {
            from: corner,
            to: [corner[0] - 2000, corner[1] - 2000],
          });
          const want = await wantedMinimum();
          const dragged = await host.native("window");
          ui.log(
            `size ${size}: dragging the corner by 2000 px left the window ${dragged.innerWidth.toFixed(0)} x ${dragged.innerHeight.toFixed(0)} DIP (client ${after.clientWidth} x ${after.clientHeight} px), the minimum is ${want[0].toFixed(0)} x ${want[1].toFixed(0)}`,
          );
          ui.assert(
            near(dragged.innerWidth, want[0], 2) && near(dragged.innerHeight, want[1], 2),
            `after dragging the corner the window is ${dragged.innerWidth} x ${dragged.innerHeight} DIP, expected the minimum ${want[0].toFixed(0)} x ${want[1].toFixed(0)} at size ${size}`,
          );
        };

        /**
         * A scroll area whose content fits shows no scrollbar, also under the pointer: the
         * rounding of a fractional layout (page zoom) must not count as overflow.
         */
        const checkScrollbars = async (/** @type {string} */ where) => {
          for (const viewport of page.document.querySelectorAll(
            "[data-radix-scroll-area-viewport]",
          )) {
            const root = viewport.parentElement;
            root.dispatchEvent(
              new page.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }),
            );
            root.dispatchEvent(new page.PointerEvent("pointerenter", { pointerType: "mouse" }));
          }
          await ui.sleep(100);
          for (const viewport of page.document.querySelectorAll(
            "[data-radix-scroll-area-viewport]",
          )) {
            const fits = viewport.scrollHeight - viewport.clientHeight <= 1;
            const bar = viewport.parentElement.querySelector(
              ':scope > [data-orientation="vertical"]',
            );
            ui.assert(
              !fits || bar === null,
              `${where} at size ${size}: a scrollbar shows although the content fits (${viewport.scrollHeight} / ${viewport.clientHeight} px)`,
            );
          }
        };

        /**
         * Empty text boxes show their placeholder and must not scroll sideways: WebKit sizes the
         * placeholder of a textarea with the page zoom applied twice, so at text size 20 an empty
         * box showed a horizontal scrollbar (src/styles.css limits the placeholder's width).
         */
        const checkTextBoxes = (/** @type {string} */ where) => {
          const areas = [...page.document.querySelectorAll("textarea")];
          ui.assert(areas.length > 0, `${where} at size ${size}: no text box found`);
          for (const area of areas) {
            ui.assert(
              area.value !== "" || area.scrollWidth - area.clientWidth <= 1,
              `${where} at size ${size}: an empty text box scrolls sideways (${area.scrollWidth} / ${area.clientWidth} px)`,
            );
          }
        };

        const first = await ui.row(p.videos[0], 30_000);
        const start = await host.native("window");
        ui.log(
          `screen ${JSON.stringify(start.screen)}, window ${start.width} x ${start.height} pt, content ${start.innerWidth} x ${start.innerHeight}, scale ${start.scale}`,
        );
        // The fonts the page asks for (the screenshots show which ones the system drew).
        const hindi = await ui.row(p.videos[2]);
        const fontOf = (/** @type {any} */ el) =>
          el ? page.getComputedStyle(el).fontFamily : "(no element)";
        ui.log(
          `fonts: body ${fontOf(page.document.body)}; Devanagari row ${fontOf(/** @type {any} */ (hindi.root).querySelector("span"))}; code ${fontOf(page.document.querySelector("code, kbd, .font-mono"))}`,
        );

        for (const target of [11, 13, 15, 17, 20]) {
          await setSize(target);
          await checkLights("as set");
          await checkTopBar();
          await checkScrollbars("the library");
          await checkMinimum();
          // A resize, as small as the layout allows at this size, then back.
          const [minWidth, minHeight] = await host.native("minSize");
          await host.native("setSize", { width: minWidth, height: minHeight });
          await ui.waitFor(
            async () => near((await host.native("window")).innerWidth, minWidth, 1),
            "the smallest window",
          );
          await checkLights("in the smallest window");
          await checkTopBar();
          await host.shot(`size-${target}-smallest-window`);
          // Back to the usual window: it stays smaller than the minimum of the next sizes, so
          // checkMinimum also sees it grow when the text size goes up.
          await host.native("setSize", {
            width: Math.max(1240, minWidth),
            height: Math.max(800, minHeight),
          });
          if (ui.platform.appMenu) {
            ui.equal(
              JSON.stringify((await host.native("window")).textSizeItems),
              JSON.stringify([target < 20, target > 11, target !== 15]),
              `the View menu items Bigger, Smaller, Default at size ${target}`,
            );
          }
          if (target === 11 || target === 20) {
            await checkDragToMinimum();
            await host.native("setSize", {
              width: Math.max(1240, minWidth),
              height: Math.max(800, minHeight),
            });
            await host.shot(`size-${target}-main`);
            // A menu, a sheet, a tooltip and the activity panel at the extreme sizes.
            await ui.click("button", /^Model: /);
            await ui.find("menuitemradio");
            await host.shot(`size-${target}-model-menu`);
            await ui.key("Escape");
            await first.press("Start Editing");
            await ui.dialog("Start Editing");
            checkTextBoxes("the Start Editing sheet");
            await host.shot(`size-${target}-start-sheet`);
            await ui.key("Escape");
            await ui.gone("dialog");
            await first.click("button", p.videos[0]);
            await ui.find("complementary", "Activity");
            await host.shot(`size-${target}-activity-panel`);
            await ui.key("Escape");
          }
        }

        // The window maximized (the green button's zoom on macOS), and full screen, at the
        // largest size.
        await host.native("maximize");
        await ui.waitFor(async () => (await host.native("window")).maximized, "a zoomed window");
        await checkLights("after the green button's zoom");
        await host.shot("size-20-maximized");
        await host.native("unmaximize");
        await ui.waitFor(async () => !(await host.native("window")).maximized, "zoomed back");
        await checkLights("after zooming back");
        await host.native("fullscreen", { on: true });
        await ui.waitFor(
          async () => (await host.native("window")).fullscreen,
          "full screen",
          10_000,
        );
        await ui.sleep(1500);
        await host.shot("size-20-full-screen");
        await host.native("fullscreen", { on: false });
        await ui.waitFor(
          async () => !(await host.native("window")).fullscreen,
          "out of full screen",
          10_000,
        );
        await ui.sleep(1500);
        await checkLights("after leaving full screen");
        await host.shot("size-20-after-full-screen");

        // Real key presses through the OS: with the focus in the web content, then (macOS)
        // elsewhere.
        await setSize(15);
        await host.native("focus");
        /** @param {"=" | "+" | "-" | "0"} key @param {number} expected */
        const press = async (key, expected, /** @type {string} */ focus) => {
          await host.pressShortcut(key);
          await expectZoom(expected);
          // One step, not two: nothing else reacts to the same key a moment later.
          await ui.sleep(400);
          ui.assert(
            near(await zoomNow(), expected / 13, 0.01),
            `${ui.platform.modifier}+${key} with the focus ${focus} changed the size by more than one step`,
          );
          size = expected;
        };
        for (const focus of mac ? ["in the web content", "elsewhere"] : ["in the web content"]) {
          if (focus === "elsewhere") await host.native("blur");
          else page.document.querySelector("main")?.focus();
          await press("=", 16, focus);
          await press("+", 17, focus);
          await press("-", 16, focus);
          await press("0", 15, focus);
          ui.log(`text size keys work with the focus ${focus}`);
        }

        // Windows: Ctrl and the mouse wheel do not zoom the page (WebView2's own zoom is off;
        // the text size is VidAI's), in either direction.
        if (!mac) {
          const win = await host.native("window");
          const at = [
            Math.round((win.x + win.width / 2) * win.scale),
            Math.round((win.y + win.height / 2) * win.scale),
          ];
          for (const delta of [120, -120, -120]) {
            await host.call("wheel", { at, delta, ctrl: true });
            await ui.sleep(400);
            ui.assert(
              near(await zoomNow(), 15 / 13, 0.01),
              `Ctrl and the mouse wheel (${delta}) changed the page zoom to ${(await zoomNow()).toFixed(3)}`,
            );
          }
          ui.log("Ctrl and the mouse wheel leave the zoom alone");
        }

        // Windows: Ctrl+F pressed for real reaches the page (WebView2 has a find bar of its own)
        // and focuses the search field. (On macOS the test app is never the active app, so a
        // real Cmd+F, which is no menu key, does not reach its web content.)
        if (!mac) {
          page.document.querySelector("main")?.focus();
          await host.pressShortcut("f");
          await ui.waitFor(
            () => /search/i.test(ui.focused() ?? ""),
            "a real Ctrl+F to focus the search",
          );
          await host.shot("search-focused-by-key");
        }
      },
    },
  ],
};

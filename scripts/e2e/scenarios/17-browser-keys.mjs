// The Windows window is an app, not a browser (SPEC section 11, "No browser in the window"): real
// key presses of the browser's reload and print keys do nothing, and a real right click shows no
// browser menu outside text fields, while text fields keep their Cut, Copy and Paste menu.
//
// The guard runs in release builds and, for this scenario, in the debug build while the
// end-to-end hook is active (`guards_webview` in src-tauri/src/lib.rs); a developer's debug build
// keeps reload and the developer tools, which a Rust unit test checks.
import { currentInterface } from "../interface.mjs";
import { seedLibrary } from "../library.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "browser-keys",
  title: "F5, Ctrl+R and Ctrl+P do nothing; no browser menu on a right click outside text fields",
  skip:
    currentInterface().os === "windows"
      ? null
      : "WKWebView on macOS has no browser keys or browser menu without a menu item",
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    ctx.params.video = VIDEO;
  },
  launches: [
    {
      async page(ui, host, p) {
        /** @type {any} */
        const page = globalThis;
        await ui.row(p.video, 30_000);
        ui.assert(page.__VIDAI_WEBVIEW_GUARD__ === true, "the Rust core asked for the guard");

        // A reload would replace this page (and this step with it), so the marker would be gone.
        page.__vidaiNotReloaded = true;
        let printRequests = 0;
        page.addEventListener("beforeprint", () => {
          printRequests += 1;
        });
        /** @type {{ prevented: boolean }[]} */
        const menus = [];
        // Added after the guard, so it sees the guard's decision.
        page.addEventListener("contextmenu", (/** @type {any} */ event) => {
          menus.push({ prevented: event.defaultPrevented });
        });

        const keys = [
          { key: "F5", name: "F5" },
          { key: "r", ctrl: true, name: "Ctrl+R" },
          { key: "F5", ctrl: true, name: "Ctrl+F5" },
          { key: "r", ctrl: true, shift: true, name: "Ctrl+Shift+R" },
        ];
        for (const { name, ...press } of keys) {
          ui.log(`pressing ${name}`);
          await host.call("pressKey", press);
          await ui.sleep(1500);
          ui.assert(page.__vidaiNotReloaded === true, `${name} reloaded the page`);
          await ui.row(p.video);
        }
        ui.log("F5, Ctrl+R, Ctrl+F5 and Ctrl+Shift+R do not reload the page");

        await host.call("pressKey", { key: "p", ctrl: true });
        await ui.sleep(1500);
        ui.equal(printRequests, 0, "print requests after Ctrl+P");
        await host.shot("after-reload-and-print-keys");
        ui.log("Ctrl+P opens no print dialog");

        /** The middle of an element in pixels of the client area, for a real click. */
        const at = (/** @type {any} */ el) => {
          const r = el.getBoundingClientRect();
          const scale = page.devicePixelRatio;
          return [
            Math.round((r.left + r.width / 2) * scale),
            Math.round((r.top + r.height / 2) * scale),
          ];
        };

        // Outside text fields: no menu at all.
        const list =
          page.document.querySelector("main [role='list']") ?? page.document.querySelector("main");
        const row = await ui.row(p.video);
        const rowBox = /** @type {any} */ (row.root).getBoundingClientRect();
        const listBox = list.getBoundingClientRect();
        const scale = page.devicePixelRatio;
        // Empty space under the last row.
        const empty = [
          Math.round((listBox.left + listBox.width / 2) * scale),
          Math.round(Math.min(listBox.bottom - 40, rowBox.bottom + 120) * scale),
        ];
        await host.call("click", { at: empty, button: "right" });
        await ui.waitFor(() => menus.length === 1, "the right click to reach the page");
        ui.assert(
          menus[0]?.prevented === true,
          "the browser menu was not declined outside a text field",
        );
        await host.shot("right-click-outside-text");

        // In a text field: the native Cut, Copy and Paste menu stays.
        const search = await ui.find("textbox", /search/i);
        await host.call("click", { at: at(search), button: "right" });
        await ui.waitFor(() => menus.length === 2, "the right click on the search field");
        ui.assert(menus[1]?.prevented === false, "the text field's own menu was declined");
        await host.shot("right-click-in-search");
        await host.call("pressKey", { key: "Escape" });
        await ui.sleep(300);
        ui.log("a right click shows no browser menu outside text fields; text fields keep theirs");
        await ui.row(p.video);
      },
    },
  ],
};

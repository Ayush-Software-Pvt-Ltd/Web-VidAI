// Things only the real webview can show: thumbnails load through the asset protocol in the
// Outputs tab, Copy puts the session id on the real clipboard (the user's clipboard is saved
// and restored exactly), and the shortcuts Cmd+, Cmd+F and Cmd+S (Ctrl on Windows) work with the
// native menu in place. The row menu and the search field's key hint use the platform's words,
// and its menu still closes while another window covers VidAI.
//
// The keys are dispatched as DOM events, so this checks the web UI's handling. That the native
// menu lets these keys through is by construction: `lifecycle::menu` binds none of them. Real key
// presses through the OS are in window-geometry (16).
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { CHANNEL, seedLibrary, sessions } from "../library.mjs";
import { png } from "../media.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "outputs-copy-shortcuts",
  title: "Thumbnails through the asset protocol, copy to the clipboard, Cmd+, Cmd+F Cmd+S",
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    ctx.params.video = VIDEO;
  },
  ops: {
    async addThumbnails(ctx) {
      const out = path.join(ctx.editing, CHANNEL, VIDEO, "output");
      for (const n of [1, 2]) await writeFile(path.join(out, `thumbnail-${n}.png`), png(320, 180));
      return true;
    },
    async sessionId(ctx) {
      return (await sessions(ctx))[0]?.sid ?? null;
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        const row = await ui.row(p.video, 30_000);
        await row.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await row.status("Edited", 20_000);
        await host.call("addThumbnails");

        // The row menu names the platform's file manager.
        await row.click("button", `More for ${p.video}`);
        await ui.find("menuitem", ui.platform.revealLabel);
        await host.shot("row-menu");
        await ui.key("Escape");
        await ui.gone("menuitem", ui.platform.revealLabel);

        // The person's own windows may cover VidAI at any time (the test app never takes the
        // focus). The page must go on running like a visible page: a covered page that counts as
        // hidden runs no animations, so a menu that closes with one never goes away.
        await host.call("cover");
        try {
          await ui.sleep(500);
          /** @type {any} */
          const covered = globalThis;
          ui.equal(
            covered.document.visibilityState,
            "visible",
            "the page's visibility while a window covers VidAI",
          );
          await row.click("button", `More for ${p.video}`);
          await ui.find("menuitem", ui.platform.revealLabel);
          await ui.key("Escape");
          await ui.gone("menuitem", ui.platform.revealLabel);
        } finally {
          await host.call("uncover");
        }

        // Thumbnails through the asset protocol.
        await row.click("button", p.video);
        const panel = ui.within(await ui.find("complementary", "Activity"));
        await panel.click("tab", "Outputs");
        await panel.text("Thumbnails");
        const images = await ui.waitFor(() => {
          const all = panel.all("img").map((img) => ui.image(img));
          return all.length >= 2 && all.every((i) => i.loaded) ? all : null;
        }, "two loaded thumbnails");
        ui.assert(
          images.every(
            (i) => (i.src ?? "").startsWith("asset:") || (i.src ?? "").includes("asset.localhost"),
          ),
          `thumbnails come through the asset protocol: ${JSON.stringify(images)}`,
        );
        await host.shot("outputs-thumbnails");

        // Copy the session id to the real clipboard.
        await panel.click("tab", "Log");
        const sid = await host.call("sessionId");
        await host.call("clipboardSave");
        try {
          await panel.click("button", "Copy session ID");
          await ui.waitFor(
            async () => (await host.call("clipboardRead")) === sid,
            "the session id on the clipboard",
          );
          ui.log("copy: the session id reached the system clipboard");
        } finally {
          await host.call("clipboardRestore");
        }

        // Cmd+, opens Settings; Cmd+S saves an edited prompt there.
        await ui.shortcut(",");
        const nav = ui.within(await ui.find("navigation", "Settings"));
        await nav.click("button", /^Channels/);
        await ui.click("button", /^Tech Reviews/);
        await ui.fill("Long 16:9 prompt", "Saved with Cmd+S.");
        await ui.find("button", "Save");
        await ui.shortcut("s");
        await ui.waitFor(
          // Save is disabled while it saves too: the change is saved once it is no longer unsaved.
          () =>
            ui.all("button", "Save").every((b) => ui.state(b).disabled) &&
            !ui.content().includes("Unsaved changes"),
          "Cmd+S to save the prompt",
        );
        await ui.press("Done");

        // Cmd+F focuses the search field, whose key hint names the platform's key.
        await ui.row(p.video);
        /** @type {any} */
        const page = globalThis;
        const hint = page.document.querySelector("main > header kbd")?.textContent ?? null;
        ui.assert(
          hint !== null && hint.startsWith(ui.platform.modifierLabel),
          `the search field's key hint is ${JSON.stringify(hint)}, expected ${ui.platform.modifierLabel}F`,
        );
        await ui.shortcut("f");
        await ui.waitFor(() => /search/i.test(ui.focused() ?? ""), "Cmd+F to focus the search");
      },
    },
  ],
};

// A person with only a Claude subscription (SPEC section 6, "Readiness of a launch"): Claude Code
// is installed and logged in, the OpenCode 2 program does not exist on this computer and nothing of OpenCode
// is set up. Nothing asks for anything of OpenCode: no onboarding card, no OpenCode in the main
// window, the sidebar says Claude Code is ready, an edit runs in Claude Code, and no OpenCode
// server ever starts. Settings, System shows the OpenCode 2 program only as quiet information.
import { currentInterface } from "../interface.mjs";
import { seedLibrary, sessions } from "../library.mjs";
import { NOT_INSTALLED, servers } from "../no-claude.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "claude-only",
  title: "Claude subscription only: nothing of OpenCode is asked, shown or started",
  skip:
    currentInterface().os !== "macos"
      ? "The OpenCode 2 program exists on Macs only (SPEC section 11, OpenCode on Windows)"
      : null,
  timeout: 120_000,
  env: { VIDAI_OPENCODE2_BIN: NOT_INSTALLED },
  async prepare(ctx) {
    await seedLibrary(ctx, [[VIDEO, "landscape"]]);
    Object.assign(ctx.params, { video: VIDEO });
  },
  ops: {
    async checkEdit(ctx) {
      if ((await sessions(ctx)).length !== 1) throw new Error("expected one Claude Code edit");
      if ((await servers(ctx, "opencode2.calls")).length > 0)
        throw new Error("an OpenCode server started");
      return true;
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        // No onboarding, straight to the main window with Claude Code ready.
        const row = await ui.row(p.video, 30_000);
        await ui.text("Claude Code ready", 20_000);
        ui.assert(!/OpenCode/.test(ui.content()), "nothing of OpenCode is on the main window");
        await host.shot("claude-only-main");

        await row.press("Start Editing");
        const sheet = await ui.dialog("Start Editing");
        ui.assert(!/OpenCode/.test(sheet.content()), "nothing of OpenCode is in the start sheet");
        await sheet.press("Start Editing");
        await row.status("Edited", 30_000);
        await host.call("checkEdit");
        await row.click("button", p.video);
        const panel = ui.within(await ui.find("complementary", "Activity"));
        ui.assert(
          !/OpenCode/.test(panel.content()),
          "nothing of OpenCode is in the activity panel",
        );
        await host.shot("claude-only-panel");

        // Settings, System: the OpenCode 2 program is information, never an alarm.
        await ui.click("button", /^Settings/);
        const nav = ui.within(await ui.find("navigation", "Settings"));
        await nav.click("button", "System");
        await ui.find("region", "OpenCode 2", 20_000);
        ui.assert(!ui.has("alert"), "no alert in Settings, System");
        await host.shot("claude-only-system");
        await ui.press("Done");
        await ui.row(p.video, 20_000);
        await ui.text("Claude Code ready");
      },
    },
  ],
};

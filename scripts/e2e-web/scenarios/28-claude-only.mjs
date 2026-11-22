// A person with only a Claude subscription (desktop 26-claude-only; SPEC section 6, "Readiness of
// a launch"): Claude Code is installed and logged in, the OpenCode 2 program does not exist on this
// computer and nothing of OpenCode is set up. Nothing asks for anything of OpenCode: no onboarding
// card, no OpenCode in the main window, the sidebar says Claude Code is ready, an edit runs in
// Claude Code, and no OpenCode server ever starts. Settings, System shows the OpenCode 2 program
// only as quiet information.
import { NOT_INSTALLED, claudeSessions, openSettings, opencodeServers } from "../setups.mjs";
import { activity, row, status } from "../ui.mjs";

const VIDEO = "001 Landscape Clip";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "claude-only",
  title: "Claude subscription only: nothing of OpenCode is asked, shown or started",
  timeout: 120_000,
  async run(t) {
    await t.seedLibrary([[VIDEO, "landscape"]]);
    const server = await t.startServer({ env: { VIDAI_OPENCODE2_BIN: NOT_INSTALLED } });
    const page = await t.open(server);
    const body = page.locator("body");

    // No onboarding, straight to the main window with Claude Code ready.
    const video = row(page, VIDEO);
    await video.waitFor({ timeout: 30_000 });
    await page.getByText("Claude Code ready").first().waitFor({ timeout: 20_000 });
    t.assert(!/OpenCode/.test(await body.innerText()), "nothing of OpenCode is on the main window");
    await t.shot(page, "claude-only-main");

    await video.getByRole("button", { name: "Start Editing" }).click();
    const sheet = page.getByRole("dialog", { name: "Start Editing" });
    await sheet.waitFor();
    t.assert(
      !/OpenCode/.test(await sheet.innerText()),
      "nothing of OpenCode is in the start sheet",
    );
    await sheet.getByRole("button", { name: "Start Editing" }).click();
    await status(video, "Edited", 30_000);
    t.equal((await claudeSessions(t)).length, 1, "Claude Code edits");
    t.equal((await opencodeServers(t)).length, 0, "OpenCode servers");
    await video.getByRole("button", { name: VIDEO, exact: true }).click();
    t.assert(
      !/OpenCode/.test(await activity(page).innerText()),
      "nothing of OpenCode is in the activity panel",
    );
    await t.shot(page, "claude-only-panel");

    // Settings, System: the OpenCode 2 program is information, never an alarm.
    await openSettings(page, "System");
    await page.getByRole("region", { name: "OpenCode 2" }).waitFor({ timeout: 20_000 });
    t.equal(await page.getByRole("alert").count(), 0, "no alert in Settings, System");
    await t.shot(page, "claude-only-system");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await row(page, VIDEO).waitFor({ timeout: 20_000 });
    await page.getByText("Claude Code ready").first().waitFor();
  },
};

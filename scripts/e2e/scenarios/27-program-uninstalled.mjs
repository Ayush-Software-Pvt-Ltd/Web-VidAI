// The OpenCode 2 program is uninstalled between two edits (SPEC section 6, "Readiness of a
// launch"): no Claude at all, edits run in the OpenCode 2 program (the fake, copied to a place the
// scenario can remove it from). The first edit completes; the program is removed; the next Start
// Editing is refused and the window turns into the "Install OpenCode 2" card; the program comes
// back, Check Again finds it, and the second edit completes in a new server.
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HARNESS_UI, SETUP_LABEL, apiOptions, seedLibrary, sessions } from "../library.mjs";
import { FAKE_OPENCODE2, NOT_INSTALLED, servers } from "../no-claude.mjs";
import { KEY, gateway, startGateway, stopGateway } from "../opencode-gateway.mjs";

const FIRST = "001 Landscape Clip";
const SECOND = "002 Landscape Twin";
const DIR = path.join(os.tmpdir(), "vidai-e2e-27-program");
const PROGRAM = path.join(DIR, "opencode2");

async function install() {
  await mkdir(DIR, { recursive: true });
  await copyFile(FAKE_OPENCODE2, PROGRAM);
  await chmod(PROGRAM, 0o755);
}

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "program-uninstalled",
  title: "The OpenCode 2 program is uninstalled between two edits, then comes back",
  skip: null,
  timeout: 240_000,
  shared: HARNESS_UI,
  env: {
    VIDAI_CLAUDE_BIN: NOT_INSTALLED,
    VIDAI_OPENCODE2_BIN: PROGRAM,
  },
  async prepare(ctx) {
    await startGateway();
    await install();
    await seedLibrary(
      ctx,
      [
        [FIRST, "landscape"],
        [SECOND, "landscape"],
      ],
      {
        setup: "claudeSubscription",
        apiOptions: apiOptions({ opencodeGo: { baseUrl: gateway.base } }),
      },
    );
    Object.assign(ctx.params, { first: FIRST, second: SECOND, key: KEY, setup: SETUP_LABEL });
  },
  async cleanup() {
    await stopGateway();
    await rm(DIR, { recursive: true, force: true });
  },
  ops: {
    async uninstall() {
      await rm(PROGRAM);
      return true;
    },
    async reinstall() {
      await install();
      return true;
    },
    async checkServers(ctx) {
      if ((await sessions(ctx)).length > 0) throw new Error("Claude Code ran an edit");
      if ((await ctx.fakeCalls()).length > 0) throw new Error("Claude Code was started");
      // One server for each of the two edits, none for the refused start.
      const all = await servers(ctx, "opencode2.calls");
      if (all.length !== 2) throw new Error(`expected 2 servers, got ${all.length}`);
      return true;
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        // No Claude Code on this computer and the Claude subscription still chosen: the window
        // shows the install card of Claude Code; the person goes back to the choice, takes
        // OpenCode Go, saves the key and chooses the model.
        /** @type {any} */
        const { __vidaiShared: shared } = globalThis;
        const label = p.setup.opencodeGo;
        await ui.text("Install Claude Code", 30_000);
        await shared.onboardOption(ui, label, p.key);
        const first = await ui.row(p.first, 30_000);
        await ui.text("OpenCode 2 ready", 20_000);
        await first.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await first.status("Edited", 40_000);

        // The program goes away; the next start is refused, in the program's own words, and the
        // window turns into the install card of the OpenCode 2 program.
        await host.call("uninstall");
        const second = await ui.row(p.second);
        await second.press("Start Editing");
        // The sheet opens; whether VidAI has noticed the missing program by itself already (the
        // window then shows the card instead) or the start is refused makes no difference.
        await ui.waitFor(
          () => ui.has("dialog", "Start Editing") || ui.content().includes("Install OpenCode 2"),
          "the sheet or the install card",
          20_000,
        );
        if (ui.has("dialog", "Start Editing")) {
          await (await ui.dialog("Start Editing")).press("Start Editing");
        }
        // The refusal refreshes what is known about this computer, so the card shows.
        await ui.text("Install OpenCode 2", 30_000);
        await host.shot("program-uninstalled-card");
        // Back again: Check Again finds the program and the main window returns.
        await host.call("reinstall");
        await ui.press("Check Again");
        const again = await ui.row(p.second, 30_000);
        await ui.text("OpenCode 2 ready", 20_000);
        // The person goes on where they were.
        if (!ui.has("dialog", "Start Editing")) await again.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await again.status("Edited", 40_000);
        await host.call("checkServers");
      },
    },
  ],
};

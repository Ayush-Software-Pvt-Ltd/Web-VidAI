// Edits in the OpenCode 2 program (desktop 21-opencode-program), with Claude Code logged out,
// against the fake OpenCode 2 (src-tauri/tests/support/fake-opencode2.py) and the local stand-in
// for the gateway: the key and the model are set up through the onboarding, the OpenCode 2
// program is the one that edits (Settings, Harness + API Keys shows it), and then, with no Claude
// login and no Claude Code process at all: an edit is paused and continued in the same session,
// an edit whose model ends its turn early is kept going by VidAI and then re-edited, and an edit is
// stopped with its whole process tree. The OpenCode 2 servers get the command line and
// environment of SPEC section 7a, and the key reaches no file VidAI writes.
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { apiOptions } from "../../e2e/library.mjs";
import {
  KEY,
  filesUnder,
  gateway,
  startGateway,
  stopGateway,
} from "../../e2e/opencode-gateway.mjs";
import {
  SETUP_LABEL,
  claudeSessions,
  expectParts,
  onboardOption,
  openSettings,
  opencodeServers,
  savedLog,
  withCleanup,
} from "../setups.mjs";
import { FAKE_OPENCODE2 } from "../../e2e/no-claude.mjs";
import { activity, row, startEditing, status } from "../ui.mjs";

const PAUSED = "001 Landscape Clip";
const KEPT = "002 Landscape Twin";
const STOPPED = "003 Landscape Third";

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "opencode-program",
  title:
    "Edits in the OpenCode 2 program: pause and continue, kept going, re-edit, stop, no Claude Code",
  timeout: 240_000,
  async run(t) {
    await withCleanup(async () => {
      await startGateway();
      await t.fakeSet("logged_out");
      await t.seedLibrary(
        [
          [PAUSED, "landscape"],
          [KEPT, "landscape"],
          [STOPPED, "landscape"],
        ],
        {
          setup: "claudeSubscription",
          apiOptions: apiOptions({ opencodeGo: { baseUrl: gateway.base } }),
        },
      );
      await t.fakeSet(`scenario.${PAUSED}`, "hold");
      await t.fakeSet(`scenario.${KEPT}`, "early_end");
      await t.fakeSet(`scenario.${STOPPED}`, "tree");
      const server = await t.startServer({ env: { VIDAI_OPENCODE2_BIN: FAKE_OPENCODE2 } });
      const page = await t.open(server);

      // The Claude subscription is still chosen and Claude Code is logged out, so the window shows
      // the login card; the person goes back to the choice, takes OpenCode Go, saves the key and
      // chooses the model (SPEC section 9, Onboarding).
      await page.getByText("Log in to Claude Code").first().waitFor({ timeout: 30_000 });
      await onboardOption(page, SETUP_LABEL.opencodeGo, KEY);

      // No Claude login needed: the sidebar says the OpenCode 2 program is ready.
      const paused = row(page, PAUSED);
      await paused.waitFor({ timeout: 30_000 });
      await page.getByText("OpenCode 2 ready").first().waitFor({ timeout: 20_000 });
      await t.shot(page, "opencode-program-main");

      // Settings, Harness + API Keys, Program: the OpenCode 2 program does the editing.
      await openSettings(page, "Harness + API Keys");
      const program = page.getByRole("region", { name: "Program" });
      await program.getByText("Installed").first().waitFor({ timeout: 20_000 });
      await t.shot(page, "opencode-program-chosen");
      await page.getByRole("button", { name: "Done", exact: true }).click();

      // Pause and continue, in the same session.
      await startEditing(page, PAUSED);
      await t.waitFake(`started.${PAUSED}`);
      await t.fakeRemove(`started.${PAUSED}`);
      await status(paused, "Editing");
      await paused.getByRole("button", { name: "Pause Editing" }).click();
      await status(paused, "Paused", 20_000);
      await paused.getByRole("button", { name: "Continue Editing" }).click();
      await t.waitFake(`started.${PAUSED}`);
      await t.fakeRemove(`started.${PAUSED}`);
      await t.release(PAUSED);
      await status(paused, "Edited", 30_000);
      await paused.getByRole("button", { name: PAUSED, exact: true }).click();
      const panel = activity(page);
      await panel.getByText("OpenCode Go").first().waitFor();
      await t.shot(page, "opencode-program-panel");
      await panel.getByRole("tab", { name: "Log" }).click();
      await panel.getByText("Transcription done").first().waitFor();
      t.assert(!(await panel.innerText()).includes(KEY), "the key is not in the activity panel");
      await t.shot(page, "opencode-program-log");
      // The saved log of the paused and continued edit names OpenCode, never Claude Code.
      const texts = await savedLog(t);
      for (const want of [
        "Started a new OpenCode 2 session (model glm-5.3)",
        "Sent the edit instructions to OpenCode 2",
        "Resumed the OpenCode 2 session (model glm-5.3)",
        "Asked OpenCode 2 to continue",
      ]) {
        t.assert(texts.includes(want), `the log has no line ${JSON.stringify(want)}`);
      }
      t.assert(!texts.some((x) => x.includes("Claude Code")), "the log names Claude Code");

      // A model that ends its turn early is kept going, then the edit is re-edited.
      const kept = row(page, KEPT);
      await startEditing(page, KEPT);
      await status(kept, "Edited", 30_000);
      await kept.getByRole("button", { name: "Re-Edit" }).click();
      const sheet = page.getByRole("dialog", { name: "Re-Edit" });
      await sheet
        .getByRole("textbox", { name: "What should change" })
        .fill("Make the intro ten seconds shorter.");
      await sheet.getByRole("button", { name: "Re-Edit" }).click();
      await sheet.waitFor({ state: "detached" });
      await status(kept, "Edited", 30_000);

      // Stop ends the server and the commands it started.
      const stopped = row(page, STOPPED);
      await startEditing(page, STOPPED);
      await t.waitFor(
        () => existsSync(path.join(t.fake, "tree.ready")),
        "the tree to be ready",
        30_000,
      );
      const pids = (await readFile(path.join(t.fake, "tree.pids"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map(Number);
      t.assert(pids.length > 0 && pids.every(alive), `the tree runs: ${pids.join(", ")}`);
      await stopped.getByRole("button", { name: "Stop Editing" }).click();
      await page
        .getByRole("alertdialog", { name: "Stop editing?" })
        .getByRole("button", { name: "Stop Editing" })
        .click();
      await status(stopped, "Stopped", 20_000);
      await t.waitFor(
        () => pids.every((pid) => !alive(pid)),
        "the stopped job's processes to end",
        20_000,
      );

      // The servers: command line, environment, sessions, no Claude Code, no key on disk.
      t.equal((await claudeSessions(t)).length, 0, "Claude Code sessions");
      const all = await opencodeServers(t);
      // Pause and continue: two; kept going and re-edited: two; stopped: one.
      t.equal(all.length, 5, "the OpenCode 2 servers");
      for (const one of all) {
        t.equal(one["args"], "serve --stdio --hostname 127.0.0.1 --port 0", "the command line");
        t.equal(one["cwd"], t.editing, "the working folder");
        t.assert(one["OPENCODE_API_KEY"] === KEY, "the server got the key");
        for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
          t.equal(one[name], "<unset>", `${name} for the OpenCode 2 program`);
        }
        t.assert(
          one["OPENCODE_CONFIG_DIR"]?.endsWith("opencode2-config"),
          `OPENCODE_CONFIG_DIR is ${one["OPENCODE_CONFIG_DIR"]}`,
        );
        const config = one["OPENCODE_CONFIG_CONTENT"] ?? "{}";
        expectParts(JSON.stringify(JSON.parse(config)), ['"glm-5.3"'], "The run configuration");
        t.assert(!config.includes(KEY), "the key is in the configuration");
      }
      const prompts = (await readdir(t.fake)).filter((f) => f.startsWith("prompts."));
      t.equal(prompts.length, 3, "the OpenCode sessions");
      const state = JSON.parse(await readFile(path.join(t.data, "state.json"), "utf8"));
      for (const video of Object.values(state.videos ?? {})) {
        t.equal(/** @type {any} */ (video).latestJob?.harness, "opencode2", "the job's program");
      }
      const counts = (
        await Promise.all(
          prompts.map(
            async (f) => (await readFile(path.join(t.fake, f), "utf8")).trim().split("\n").length,
          ),
        )
      ).sort();
      // Stopped: 1 message; paused and continued: 2; kept going (2) and re-edited (1): 3.
      t.equal(counts, [1, 2, 3], "the messages of the sessions");
      for (const file of await filesUnder(t.data)) {
        const text = await readFile(file, "utf8").catch(() => "");
        t.assert(!text.includes(KEY), `the key is in ${path.relative(t.data, file)}`);
      }
    }, stopGateway);
  },
};

// A person with NO Claude at all (desktop 25-no-claude-opencode2 and 27-program-uninstalled; SPEC
// section 6, "Readiness of a launch"): Claude Code is not installed on this computer, the OpenCode
// 2 program is (the fake). The page goes from the card "Install Claude Code" through the choice of
// program, the key and the model to a completed edit without ever asking to install or log in to
// anything of Claude and without one Claude Code process. Then the OpenCode 2 program is removed
// between two edits: the next Start Editing is refused and the page turns into the "Install
// OpenCode 2" card; the program comes back, Check Again finds it, and the second edit completes
// in a new server.
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { apiOptions } from "../../e2e/library.mjs";
import { FAKE_OPENCODE2 } from "../../e2e/no-claude.mjs";
import {
  KEY,
  filesUnder,
  gateway,
  startGateway,
  stopGateway,
} from "../../e2e/opencode-gateway.mjs";
import {
  NOT_INSTALLED,
  SETUP_LABEL,
  expectParts,
  onboardOption,
  opencodeServers,
  savedLog,
  claudeSessions,
  withCleanup,
} from "../setups.mjs";
import { activity, row, startEditing, status } from "../ui.mjs";
import { readFile } from "node:fs/promises";

const FIRST = "001 Landscape Clip";
const SECOND = "002 Landscape Twin";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "no-claude",
  title:
    "No Claude at all: OpenCode 2 program, key, model, an edit; the program is uninstalled and back",
  timeout: 240_000,
  async run(t) {
    await withCleanup(async () => {
      // The program is a copy of the fake that the scenario can remove.
      const program = path.join(t.dir, "program", "opencode2");
      const install = async () => {
        await mkdir(path.dirname(program), { recursive: true });
        await copyFile(FAKE_OPENCODE2, program);
        await chmod(program, 0o755);
      };
      await install();
      await startGateway();
      await t.seedLibrary(
        [
          [FIRST, "landscape"],
          [SECOND, "landscape"],
        ],
        {
          setup: "claudeSubscription",
          apiOptions: apiOptions({ opencodeGo: { baseUrl: gateway.base } }),
        },
      );
      const server = await t.startServer({
        env: { VIDAI_CLAUDE_BIN: NOT_INSTALLED, VIDAI_OPENCODE2_BIN: program },
      });
      const page = await t.open(server);
      const body = page.locator("body");

      // Nothing asks to install or log in to Claude Code beyond the first card: the stored setup
      // is the Claude subscription, which Claude Code not being installed blocks, so the page
      // shows the card of that; the person goes back to the choice, takes OpenCode Go, saves the
      // key and chooses the model.
      await page.getByText("Install Claude Code").first().waitFor({ timeout: 30_000 });
      await t.shot(page, "no-claude-card");
      await onboardOption(page, SETUP_LABEL.opencodeGo, KEY);
      t.equal(
        await page.getByRole("button", { name: "Log In" }).count(),
        0,
        "no Claude login is asked for",
      );

      // The program is installed: the main window, ready, with no Claude anywhere.
      const first = row(page, FIRST);
      await first.waitFor({ timeout: 30_000 });
      await page.getByText("OpenCode 2 ready").first().waitFor({ timeout: 20_000 });
      await page
        .getByRole("button", {
          name: /^New edits run with OpenCode 2 on OpenCode Go with GLM-5\.3/,
        })
        .waitFor();
      await t.shot(page, "no-claude-main");
      await startEditing(page, FIRST);
      await status(first, "Edited", 40_000);

      // Not one Claude Code process, not even its helper for models and usage.
      t.equal((await t.fakeCalls()).length, 0, "Claude Code processes");
      t.equal((await claudeSessions(t)).length, 0, "Claude Code sessions");
      let servers = await opencodeServers(t);
      t.equal(servers.length, 1, "the OpenCode 2 servers");
      const [one] = servers;
      t.equal(one?.["args"], "serve --stdio --hostname 127.0.0.1 --port 0", "the command line");
      t.assert(one?.["OPENCODE_API_KEY"] === KEY, "the server got the key");
      t.equal(one?.["cwd"], t.editing, "the working folder");
      for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
        t.equal(one?.[name], "<unset>", `${name} for the OpenCode 2 program`);
      }
      const config = one?.["OPENCODE_CONFIG_CONTENT"] ?? "{}";
      expectParts(JSON.stringify(JSON.parse(config)), ['"glm-5.3"'], "The run configuration");
      t.assert(!config.includes(KEY), "the key is in the configuration");
      // The user's own OpenCode configuration stays out of the job.
      t.assert(
        one?.["OPENCODE_CONFIG_DIR"]?.endsWith("opencode2-config"),
        `OPENCODE_CONFIG_DIR is ${one?.["OPENCODE_CONFIG_DIR"]}`,
      );
      const texts = await savedLog(t);
      for (const want of [
        "Started a new OpenCode 2 session (model glm-5.3)",
        "Sent the edit instructions to OpenCode 2",
      ]) {
        t.assert(texts.includes(want), `the log has no line ${JSON.stringify(want)}`);
      }
      t.assert(!texts.some((x) => x.includes("Claude")), "the log names Claude");
      await first.getByRole("button", { name: FIRST, exact: true }).click();
      const panel = activity(page);
      await panel.getByText("OpenCode Go").first().waitFor();
      await t.shot(page, "no-claude-panel");
      t.assert(!(await panel.innerText()).includes(KEY), "the key is not in the activity panel");

      // The program goes away; the next start is refused, in the program's own words, and the
      // window turns into the install card of the OpenCode 2 program.
      await rm(program);
      // A refused start is a 400 of the server (the page then shows the card), expected here.
      t.allowFailure(/api\/invoke\/start_edit/);
      const second = row(page, SECOND);
      await second.getByRole("button", { name: "Start Editing" }).click();
      // The sheet opens; whether VidAI has noticed the missing program by itself already (the
      // page then shows the card instead) or the start is refused makes no difference.
      const sheet = page.getByRole("dialog", { name: "Start Editing" });
      const card = page.getByText("Install OpenCode 2").first();
      await sheet.or(card).first().waitFor({ timeout: 20_000 });
      if (await sheet.isVisible()) {
        await sheet.getByRole("button", { name: "Start Editing" }).click();
      }
      await card.waitFor({ timeout: 30_000 });
      await t.shot(page, "program-uninstalled-card");
      t.assert(!(await body.innerText()).includes(KEY), "the key is never shown");

      // Back again: Check Again finds the program and the main window returns.
      await install();
      await page.getByRole("button", { name: "Check Again" }).click();
      await second.waitFor({ timeout: 30_000 });
      await page.getByText("OpenCode 2 ready").first().waitFor({ timeout: 20_000 });
      // The person goes on where they were.
      if (!(await sheet.isVisible())) {
        await second.getByRole("button", { name: "Start Editing" }).click();
      }
      await sheet.getByRole("button", { name: "Start Editing" }).click();
      await status(second, "Edited", 40_000);
      t.equal((await t.fakeCalls()).length, 0, "Claude Code was never started");
      // One server for each of the two edits, none for the refused start.
      servers = await opencodeServers(t);
      t.equal(servers.length, 2, "the OpenCode 2 servers after the second edit");
      for (const file of await filesUnder(t.data)) {
        const text = await readFile(file, "utf8").catch(() => "");
        t.assert(!text.includes(KEY), `the key is in ${path.relative(t.data, file)}`);
      }
      await rm(path.dirname(program), { recursive: true, force: true });
    }, stopGateway);
  },
};

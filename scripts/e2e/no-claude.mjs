// The scenarios of a person with NO Claude at all (SPEC section 6, "Readiness of a launch"):
// Claude Code is not installed on this computer, the OpenCode 2 program is, and the person goes
// through the first screens (which program edits, the key, the model) and completes an edit
// without ever being asked to install or log in to anything of Claude (25-no-claude-opencode2);
// 27-program-uninstalled takes the program away between two edits.
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  HARNESS_UI,
  SETUP_LABEL,
  apiOptions,
  expectParts,
  seedLibrary,
  sessions,
} from "./library.mjs";
import { KEY, filesUnder, gateway, startGateway, stopGateway } from "./opencode-gateway.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const support = path.resolve(here, "../../src-tauri/tests/support");
export const FAKE_OPENCODE2 = path.join(support, "fake-opencode2.py");
/** A program that is not installed: the override points at nothing, so it is the only candidate. */
export const NOT_INSTALLED = "/nonexistent/e2e-not-installed";

/**
 * The servers of the fake OpenCode 2 program, oldest first, as `key=value` maps.
 * @param {import("./types.mjs").Context} ctx @param {string} list the calls file of the fake
 */
export async function servers(ctx, list) {
  const file = path.join(ctx.fake, list);
  if (!existsSync(file)) return [];
  const pids = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  return Promise.all(
    pids.map(async (pid) => {
      /** @type {Record<string, string>} */
      const fields = { pid };
      for (const line of (await readFile(path.join(ctx.fake, `call.${pid}`), "utf8")).split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1);
      }
      return fields;
    }),
  );
}

/** The log lines of every saved job, in order of the files. @param {import("./types.mjs").Context} ctx */
export async function savedLog(ctx) {
  const dir = path.join(ctx.data, "logs");
  /** @type {string[]} */
  const texts = [];
  for (const file of (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of (await readFile(path.join(dir, file), "utf8")).split("\n")) {
      if (line) texts.push(JSON.parse(line).text);
    }
  }
  return texts;
}

/** Throws when the key is in any file VidAI wrote. @param {import("./types.mjs").Context} ctx */
export async function expectNoKeyOnDisk(ctx) {
  for (const file of await filesUnder(ctx.data)) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.includes(KEY)) throw new Error(`the key is in ${path.relative(ctx.data, file)}`);
  }
}

/**
 * The scenario of the story: no Claude Code, the OpenCode 2 program installed (the fake).
 * @param {{ name: string, title: string, skip: string | null }} options
 * @returns {import("./types.mjs").Scenario}
 */
export function noClaudeScenario({ name, title, skip }) {
  const VIDEO = "001 Landscape Clip";
  return {
    name,
    title,
    skip,
    shared: HARNESS_UI,
    timeout: 180_000,
    env: {
      VIDAI_CLAUDE_BIN: NOT_INSTALLED,
      VIDAI_OPENCODE2_BIN: FAKE_OPENCODE2,
    },
    async prepare(ctx) {
      await startGateway();
      await seedLibrary(ctx, [[VIDEO, "landscape"]], {
        setup: "claudeSubscription",
        apiOptions: apiOptions({ opencodeGo: { baseUrl: gateway.base } }),
      });
      Object.assign(ctx.params, { video: VIDEO, key: KEY, setup: SETUP_LABEL });
    },
    async cleanup() {
      await stopGateway();
    },
    ops: {
      async checkEdit(ctx) {
        // Not one Claude Code process, not even its helper for models and usage.
        const claude = await ctx.fakeCalls();
        if (claude.length > 0) throw new Error(`Claude Code was started ${claude.length} times`);
        if ((await sessions(ctx)).length > 0) throw new Error("Claude Code ran an edit");
        const all = await servers(ctx, "opencode2.calls");
        if (all.length !== 1) throw new Error(`expected 1 server, got ${all.length}`);
        const [server] = all;
        if (server.args !== "serve --stdio --hostname 127.0.0.1 --port 0") {
          throw new Error(`the command line is ${server.args}`);
        }
        if (server.OPENCODE_API_KEY !== KEY) throw new Error("the server did not get the key");
        if (server.cwd !== ctx.editing) throw new Error(`the working folder is ${server.cwd}`);
        for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
          if (server[name] !== "<unset>")
            throw new Error(`${name} is set for the OpenCode 2 program`);
        }
        const config = JSON.parse(server.OPENCODE_CONFIG_CONTENT ?? "{}");
        expectParts(JSON.stringify(config), ['"glm-5.3"'], "The run configuration");
        if (JSON.stringify(config).includes(KEY))
          throw new Error("the key is in the configuration");
        // The user's own OpenCode configuration stays out of the job.
        if (!server.OPENCODE_CONFIG_DIR?.endsWith("opencode2-config"))
          throw new Error(`OPENCODE_CONFIG_DIR is ${server.OPENCODE_CONFIG_DIR}`);
        const texts = await savedLog(ctx);
        for (const want of [
          "Started a new OpenCode 2 session (model glm-5.3)",
          "Sent the edit instructions to OpenCode 2",
        ]) {
          if (!texts.includes(want)) throw new Error(`the log has no line ${JSON.stringify(want)}`);
        }
        if (texts.some((t) => t.includes("Claude"))) throw new Error("the log names Claude");
        await expectNoKeyOnDisk(ctx);
        return true;
      },
    },
    launches: [
      {
        async page(ui, host, p) {
          // Without any Claude: nothing asks to install or log in to Claude Code. The stored
          // setup is still the Claude subscription, which Claude Code not being installed
          // blocks, so the window shows the card of that; the person goes back to the choice,
          // takes OpenCode Go, saves the key and chooses the model.
          /** @type {any} */
          const { __vidaiShared: shared } = globalThis;
          const label = p.setup.opencodeGo;
          await ui.text("Install Claude Code", 30_000);
          await host.shot("no-claude-card");
          await shared.onboardOption(ui, label, p.key);
          ui.assert(!ui.has("button", "Log In"), "no Claude login is asked for");

          // The program is installed: the main window, ready, with no Claude anywhere.
          const row = await ui.row(p.video, 30_000);
          await ui.text("OpenCode 2 ready", 20_000);
          await ui.find("button", /^New edits run with OpenCode 2 on OpenCode Go with GLM-5\.3/);
          await host.shot("no-claude-main");

          await row.press("Start Editing");
          await (await ui.dialog("Start Editing")).press("Start Editing");
          await row.status("Edited", 40_000);
          await host.call("checkEdit");
          await row.click("button", p.video);
          const panel = ui.within(await ui.find("complementary", "Activity"));
          await panel.text("OpenCode Go");
          await host.shot("no-claude-panel");
          ui.assert(!panel.content().includes(p.key), "the key is not in the activity panel");
        },
      },
    ],
  };
}

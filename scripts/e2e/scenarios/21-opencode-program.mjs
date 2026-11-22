// Edits in the OpenCode 2 program (SPEC section 7a, "The program that edits"), on a Mac with
// Claude Code logged out, against the fake OpenCode 2 (tests/support/fake-opencode2.py) and
// the local stand-in for the gateway: the key and the model are set up through the onboarding,
// the OpenCode 2 program is the one that edits (onboarding chooses it, Settings, API Keys shows it), and then, with no
// Claude login and no Claude Code process at all: an edit is paused and continued in the same
// session, an edit whose model ends its turn early is kept going by VidAI and then re-edited, and
// an edit is stopped with its whole process tree. The OpenCode 2 servers get the command line and
// environment of SPEC section 7a, and the key reaches no file VidAI writes.
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  HARNESS_UI,
  SETUP_LABEL,
  apiOptions,
  expectParts,
  seedLibrary,
  sessions,
} from "../library.mjs";
import { FAKE_OPENCODE2, servers } from "../no-claude.mjs";
import { KEY, filesUnder, gateway, startGateway, stopGateway } from "../opencode-gateway.mjs";

const PAUSED = "001 Landscape Clip";
const KEPT = "002 Landscape Twin";
const STOPPED = "003 Landscape Third";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "opencode-program",
  title:
    "Edits in the OpenCode 2 program: pause and continue, kept going, re-edit, stop, no Claude Code",
  timeout: 240_000,
  shared: HARNESS_UI,
  env: { VIDAI_OPENCODE2_BIN: FAKE_OPENCODE2 },
  async prepare(ctx) {
    await startGateway();
    await ctx.fakeSet("logged_out");
    await seedLibrary(
      ctx,
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
    await ctx.fakeSet(`scenario.${PAUSED}`, "hold");
    await ctx.fakeSet(`scenario.${KEPT}`, "early_end");
    await ctx.fakeSet(`scenario.${STOPPED}`, "tree");
    Object.assign(ctx.params, {
      paused: PAUSED,
      kept: KEPT,
      stopped: STOPPED,
      key: KEY,
      setup: SETUP_LABEL,
    });
  },
  async cleanup() {
    await stopGateway();
  },
  ops: {
    /** Waits until the held command of `video` runs, and takes its signal. */
    async held(ctx, args) {
      const file = path.join(ctx.fake, `started.${args.video}`);
      const deadline = Date.now() + 30_000;
      while (!existsSync(file)) {
        if (Date.now() > deadline) throw new Error(`${args.video} never started its command`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await rm(file);
      return true;
    },
    async release(ctx, args) {
      await ctx.fakeSet(`release.${args.video}`);
      return true;
    },
    /** The pids of the stopped job's tree (the server and its two commands). */
    async treePids(ctx) {
      const file = path.join(ctx.fake, "tree.pids");
      const deadline = Date.now() + 30_000;
      while (!existsSync(path.join(ctx.fake, "tree.ready"))) {
        if (Date.now() > deadline) throw new Error("the tree never got ready");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return (await readFile(file, "utf8")).split("\n").filter(Boolean).map(Number);
    },
    /** The saved log of the paused and continued edit names OpenCode, never Claude Code. */
    async checkLog(ctx) {
      const dir = path.join(ctx.data, "logs");
      const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
      const texts = [];
      for (const file of files) {
        for (const line of (await readFile(path.join(dir, file), "utf8")).split("\n")) {
          if (line) texts.push(JSON.parse(line).text);
        }
      }
      for (const want of [
        "Started a new OpenCode 2 session (model glm-5.3)",
        "Sent the edit instructions to OpenCode 2",
        "Resumed the OpenCode 2 session (model glm-5.3)",
        "Asked OpenCode 2 to continue",
      ]) {
        if (!texts.includes(want)) throw new Error(`the log has no line ${JSON.stringify(want)}`);
      }
      if (texts.some((t) => t.includes("Claude Code")))
        throw new Error("the log names Claude Code");
      return true;
    },
    async checkServers(ctx) {
      if ((await sessions(ctx)).length > 0) throw new Error("Claude Code was started for an edit");
      const all = await servers(ctx, "opencode2.calls");
      // Pause and continue: two; kept going and re-edited: two; stopped: one.
      if (all.length !== 5) throw new Error(`expected 5 OpenCode 2 servers, got ${all.length}`);
      for (const server of all) {
        if (server.args !== "serve --stdio --hostname 127.0.0.1 --port 0") {
          throw new Error(`the command line is ${server.args}`);
        }
        if (server.cwd !== ctx.editing) throw new Error(`the working folder is ${server.cwd}`);
        if (server.OPENCODE_API_KEY !== KEY) throw new Error("the server did not get the key");
        for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
          if (server[name] !== "<unset>")
            throw new Error(`${name} is set for the OpenCode 2 program`);
        }
        if (!server.OPENCODE_CONFIG_DIR?.endsWith("opencode2-config"))
          throw new Error(`OPENCODE_CONFIG_DIR is ${server.OPENCODE_CONFIG_DIR}`);
        const config = JSON.parse(server.OPENCODE_CONFIG_CONTENT ?? "{}");
        expectParts(JSON.stringify(config), ['"glm-5.3"'], "The run configuration");
        if (JSON.stringify(config).includes(KEY))
          throw new Error("the key is in the configuration");
      }
      // The paused edit continued its own session in a new server.
      const prompts = (await readdir(ctx.fake)).filter((f) => f.startsWith("prompts."));
      if (prompts.length !== 3)
        throw new Error(`expected 3 OpenCode sessions, got ${prompts.length}`);
      const state = JSON.parse(await readFile(path.join(ctx.data, "state.json"), "utf8"));
      const jobs = Object.values(state.videos ?? {}).map((v) => /** @type {any} */ (v).latestJob);
      for (const job of jobs) {
        if (job?.harness !== "opencode2") throw new Error(`a job ran in ${job?.harness}`);
      }
      const texts = await Promise.all(
        prompts.map(async (f) =>
          (await readFile(path.join(ctx.fake, f), "utf8")).trim().split("\n"),
        ),
      );
      const counts = texts.map((t) => t.length).sort();
      // Stopped: 1 message; paused and continued: 2; kept going (2) and re-edited (1): 3.
      if (JSON.stringify(counts) !== JSON.stringify([1, 2, 3])) {
        throw new Error(`the sessions got ${JSON.stringify(counts)} messages`);
      }
      for (const file of await filesUnder(ctx.data)) {
        const text = await readFile(file, "utf8").catch(() => "");
        if (text.includes(KEY)) throw new Error(`the key is in ${path.relative(ctx.data, file)}`);
      }
      return true;
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        // The Claude subscription is still chosen and Claude Code is logged out, so the window
        // shows the login card; the person goes back to the choice, takes OpenCode Go, saves
        // the key and chooses the model (SPEC section 9, Onboarding).
        /** @type {any} */
        const { __vidaiShared: shared } = globalThis;
        const label = p.setup.opencodeGo;
        await ui.text("Log in to Claude Code", 30_000);
        await shared.onboardOption(ui, label, p.key);

        // No Claude login needed: the sidebar says the OpenCode 2 program is ready.
        await ui.row(p.paused, 30_000);
        await ui.text("OpenCode 2 ready", 20_000);
        await host.shot("opencode-program-main");

        // Settings, Harness + API Keys, Program: the OpenCode 2 program does the editing.
        await ui.shortcut(",");
        await ui
          .within(await ui.find("navigation", "Settings"))
          .click("button", "Harness + API Keys");
        const program = ui.within(await ui.find("region", "Program"));
        await program.text("Installed", 20_000);
        await host.shot("opencode-program-chosen");
        await ui.press("Done");

        // Pause and continue, in the same session.
        const paused = await ui.row(p.paused, 30_000);
        await paused.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await host.call("held", { video: p.paused });
        await paused.status("Editing");
        await paused.press("Pause Editing");
        await paused.status("Paused", 20_000);
        await paused.press("Continue Editing");
        await host.call("held", { video: p.paused });
        await host.call("release", { video: p.paused });
        await paused.status("Edited", 30_000);
        await paused.click("button", p.paused);
        const panel = ui.within(await ui.find("complementary", "Activity"));
        await panel.text("OpenCode Go");
        await host.shot("opencode-program-panel");
        await panel.click("tab", "Log");
        await panel.text("Transcription done");
        await host.call("checkLog", { video: p.paused });
        ui.assert(!panel.content().includes(p.key), "the key is not in the activity panel");
        await host.shot("opencode-program-log");

        // A model that ends its turn early is kept going, then the edit is re-edited.
        const kept = await ui.row(p.kept);
        await kept.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await kept.status("Edited", 30_000);
        await kept.press("Re-Edit");
        const sheet = await ui.dialog("Re-Edit");
        await sheet.fill("What should change", "Make the intro ten seconds shorter.");
        await sheet.press("Re-Edit");
        await ui.gone("dialog", "Re-Edit");
        await kept.status("Edited", 30_000);

        // Stop ends the server and the commands it started.
        const stopped = await ui.row(p.stopped);
        await stopped.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        const pids = await host.call("treePids");
        await stopped.press("Stop Editing");
        await (await ui.dialog("Stop editing?")).press("Stop Editing");
        await stopped.status("Stopped", 20_000);
        await ui.waitFor(
          async () => (await host.call("fakeAlive", { pids })).length === 0,
          "the stopped job's processes to end",
          20_000,
        );

        await host.call("checkServers");
      },
    },
  ],
};

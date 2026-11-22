// Edits on an Anthropic compatible API with Claude Code as the program (SPEC section 7a, the
// "Claude Code with Anthropic Compatible API" setup), with Claude Code logged out: Settings,
// Harness + API Keys saves a key through the real UI and types the model id (nothing asks the
// service for a list on its own; Fetch Models asks once and pages through the list of a local
// stand-in for the gateway); an edit runs without any Claude login and the fake Claude Code
// receives exactly the five variables and --model; the top bar and the activity panel name the
// service and model; Test sends one tiny request; choosing the Claude subscription again says
// Claude Code needs its login, and the API setup can be chosen again. The key never reaches a
// log, state.json or settings.json. The key is optional on this option (SPEC section 7a, The key
// is optional): removing it keeps the option selected, Test says the service wants a key when it
// refuses a request without one, a server that needs none is tested and listed without any key
// header, and an edit runs with ANTHROPIC_AUTH_TOKEN=no-key and no ANTHROPIC_API_KEY, so Claude
// Code never falls back to a Claude login. Runs on Macs and on Windows.
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  HARNESS_UI,
  SETUP_LABEL,
  apiOptions,
  expectParts,
  seedLibrary,
  sessions,
} from "../library.mjs";
import { KEY, filesUnder, gateway, startGateway, stopGateway } from "../opencode-gateway.mjs";

const VIDEO = "001 Landscape Clip";
const KEYLESS_VIDEO = "002 Landscape Twin";

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "anthropic-api",
  title:
    "Edits on an Anthropic compatible API without a Claude login: key, model, back again, no key",
  timeout: 180_000,
  shared: HARNESS_UI,
  // No OpenCode 2 program on this computer, whatever the machine running the test has installed.
  env: { VIDAI_OPENCODE2_BIN: "/nonexistent/opencode2" },
  async prepare(ctx) {
    await startGateway();
    // Claude Code is installed but logged out; the API option's address is the stand-in.
    await ctx.fakeSet("logged_out");
    await seedLibrary(
      ctx,
      [
        [VIDEO, "landscape"],
        [KEYLESS_VIDEO, "landscape"],
      ],
      {
        apiOptions: apiOptions({ anthropicApi: { baseUrl: gateway.base } }),
      },
    );
    Object.assign(ctx.params, {
      video: VIDEO,
      keyless: KEYLESS_VIDEO,
      key: KEY,
      base: gateway.base,
      setup: SETUP_LABEL,
    });
  },
  async cleanup() {
    await stopGateway();
  },
  ops: {
    /** A typed model needs no list: nothing has asked the service for one yet. */
    async checkNoModelList() {
      const lists = gateway.requests.filter((r) => r.path.endsWith("/v1/models"));
      if (lists.length > 0) {
        throw new Error(`the model list was asked for on its own: ${JSON.stringify(lists)}`);
      }
      return true;
    },
    /** Fetch Models asked for the list, page by page. */
    async checkModelList() {
      const lists = gateway.requests.filter((r) => r.path.endsWith("/v1/models"));
      if (lists.length < 2)
        throw new Error(`the model list was not paged: ${JSON.stringify(lists)}`);
      return true;
    },
    async checkEditOnApi(ctx) {
      const [edit] = await sessions(ctx);
      if (!edit) throw new Error("no edit");
      const env = edit.env;
      const want = {
        ANTHROPIC_BASE_URL: gateway.base,
        ANTHROPIC_API_KEY: KEY,
        // The user's own token never competes with the key (SPEC section 7a).
        ANTHROPIC_AUTH_TOKEN: "<unset>",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3",
      };
      for (const [name, value] of Object.entries(want)) {
        if (env[name] !== value) {
          throw new Error(
            `${name} is ${JSON.stringify(name === "ANTHROPIC_API_KEY" ? "(hidden)" : env[name])}`,
          );
        }
      }
      expectParts(edit.args, ["--model glm-5.3"], "The arguments");
      if (edit.args.includes("--effort")) throw new Error(`--effort on OpenCode: ${edit.args}`);
      if (edit.args.includes(KEY)) throw new Error("the key is an argument");
      // The key never reaches a file VidAI writes.
      for (const file of await filesUnder(ctx.data)) {
        const text = await readFile(file, "utf8").catch(() => "");
        if (text.includes(KEY)) throw new Error(`the key is in ${path.relative(ctx.data, file)}`);
      }
      return true;
    },
    /** From now on the stand-in answers like a local model server that needs no key. */
    async serveWithoutKey() {
      gateway.keyless = true;
      return true;
    },
    /** The last request of this kind carried no key header at all (Test, Fetch Models). */
    async checkLastRequestHadNoKey(_ctx, { method, suffix }) {
      const last = gateway.requests
        .filter((r) => r.method === method && r.path.endsWith(suffix))
        .at(-1);
      if (!last || last.bearer !== "none") {
        throw new Error(`the ${method} ${suffix} request: ${JSON.stringify(last)}`);
      }
      return true;
    },
    /** The edit without a key: the placeholder token, never the key or the user's own login. */
    async checkEditWithoutKey(ctx) {
      const [, edit] = await sessions(ctx);
      if (!edit) throw new Error("no second edit");
      const want = {
        ANTHROPIC_BASE_URL: gateway.base,
        ANTHROPIC_API_KEY: "<unset>",
        ANTHROPIC_AUTH_TOKEN: "no-key",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3",
      };
      for (const [name, value] of Object.entries(want)) {
        if (edit.env[name] !== value) {
          throw new Error(`${name} is ${JSON.stringify(edit.env[name])}, expected ${value}`);
        }
      }
      expectParts(edit.args, ["--model glm-5.3"], "The arguments");
      return true;
    },
    async checkTest() {
      const tests = gateway.requests.filter((r) => r.method === "POST");
      const last = tests.at(-1);
      if (
        !last ||
        last.bearer !== "key" ||
        last.body?.max_tokens !== 1 ||
        last.body?.model !== "glm-5.3"
      ) {
        throw new Error(`the Test request: ${JSON.stringify(last)}`);
      }
      return true;
    },
  },
  launches: [
    {
      async page(ui, host, p) {
        /** @type {any} */
        const { __vidaiShared: shared } = globalThis;
        const label = p.setup.anthropicApi;
        // The Claude subscription is still chosen and Claude Code is logged out, so the window
        // shows the login card (SPEC section 6, Readiness of a launch).
        await ui.text("Log in to Claude Code", 30_000);
        await host.shot("anthropic-api-logged-out");

        // Back to the choice, the API option's card: the key, the typed model, Continue.
        await shared.onboardOption(ui, label, p.key, "glm-5.3");
        await host.call("checkNoModelList");

        // The main window, without any Claude login: the service and model in the top bar.
        const row = await ui.row(p.video, 30_000);
        await ui.find(
          "button",
          /^New edits run with Claude Code on Anthropic Compatible API with glm-5\.3/,
        );
        ui.assert(!ui.has("button", /^Model: /), "no Claude model picker on an API setup");
        await ui.text("Claude Code ready");
        await host.shot("anthropic-api-main");

        await row.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await row.status("Edited", 30_000);
        await host.call("checkEditOnApi");
        await row.click("button", p.video);
        const panel = ui.within(await ui.find("complementary", "Activity"));
        await panel.text("Anthropic API");
        await panel.text("glm-5.3");
        await host.shot("anthropic-api-panel");
        await panel.click("tab", "Log");
        await panel.text("Sent the edit instructions to Claude");
        ui.assert(!panel.content().includes(p.key), "the key is not in the activity panel");
        await host.shot("anthropic-api-panel-log");

        // Settings: Test, then back to the Claude subscription and again to the API.
        await ui.click("button", /^New edits run with/);
        await ui
          .within(await ui.find("navigation", "Settings"))
          .find("button", "Harness + API Keys");
        // The selected option's panel starts open.
        if (!ui.has("group", `Settings of ${label}`)) await ui.press(`Configure ${label}`);
        const form = ui.within(await ui.find("group", `Settings of ${label}`));
        await form.press("Test");
        await ui.text("Anthropic Compatible API answered with glm-5.3.", 20_000);
        await host.call("checkTest");
        // Fetch Models asks the service for its list (the only time), and the list is offered.
        await form.press("Fetch Models");
        const list = ui.within(await ui.find("dialog", "Models", 15_000));
        await list.find("option", "GLM-5.3 (glm-5.3)", 15_000);
        await host.call("checkModelList");
        await ui.key("Escape");
        ui.assert(!ui.content().includes(p.key), "the key is never shown");
        await host.shot("anthropic-api-settings");
        // The Claude subscription needs the login of the logged out Claude Code, so choosing it
        // turns the window into the login card (SPEC section 6, Readiness of a launch).
        await ui.click("radio", p.setup.claudeSubscription);
        await ui.text("Log in to Claude Code", 20_000);
        await host.shot("anthropic-api-back-to-subscription");
        // Back to the choice and the API option again: its key and model are saved, so its
        // Continue is enabled at once.
        await ui.press("Back");
        await ui.click("radio", label);
        await ui.press("Continue");
        await ui.find("textbox", "API Key (optional)");
        await ui.press("Continue");
        // Settings was open when the onboarding took over, and is again.
        await ui.press("Done");
        await ui.row(p.video, 30_000);
        await ui.find(
          "button",
          /^New edits run with Claude Code on Anthropic Compatible API with glm-5\.3/,
        );

        // The key is optional on this option: remove it in Settings, and the option stays
        // selected, its field says so, and Test says the service wants a key when it refuses.
        await ui.click("button", /^New edits run with/);
        await ui
          .within(await ui.find("navigation", "Settings"))
          .find("button", "Harness + API Keys");
        if (!ui.has("group", `Settings of ${label}`)) await ui.press(`Configure ${label}`);
        const keyed = ui.within(await ui.find("group", `Settings of ${label}`));
        await keyed.find("textbox", "API Key (optional)");
        await keyed.press(/^Remove/);
        await (await ui.dialog("Remove the API key?")).press("Remove Key");
        await ui.text("API key removed", 20_000);
        await ui.text("Leave it empty if your server needs no key", 20_000);
        await keyed.press("Test");
        await ui.text("The service wants an API key", 20_000);
        await host.shot("anthropic-api-no-key-refused");

        // A server that needs no key: Fetch Models and Test send no key header at all.
        await host.call("serveWithoutKey");
        await keyed.press("Test");
        await ui.text("Anthropic Compatible API answered with glm-5.3.", 20_000);
        await host.call("checkLastRequestHadNoKey", { method: "POST", suffix: "/v1/messages" });
        await keyed.press("Fetch Models");
        const keylessList = ui.within(await ui.find("dialog", "Models", 15_000));
        await keylessList.find("option", "GLM-5.3 (glm-5.3)", 15_000);
        await host.call("checkLastRequestHadNoKey", { method: "GET", suffix: "/v1/models" });
        await ui.key("Escape");
        await host.shot("anthropic-api-no-key-settings");

        // The option is still selected: an edit runs without a key and without a login.
        await ui.press("Done");
        await ui.find(
          "button",
          /^New edits run with Claude Code on Anthropic Compatible API with glm-5\.3/,
        );
        const twin = await ui.row(p.keyless, 30_000);
        await twin.press("Start Editing");
        await (await ui.dialog("Start Editing")).press("Start Editing");
        await twin.status("Edited", 30_000);
        await host.call("checkEditWithoutKey");
      },
    },
  ],
};

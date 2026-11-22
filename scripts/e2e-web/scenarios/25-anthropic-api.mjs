// Edits on an Anthropic compatible API with Claude Code as the program (desktop 19-anthropic-api),
// with Claude Code logged out: Settings, Harness + API Keys saves a key through the real UI and
// types the model id (nothing asks the service for a list on its own; Fetch Models asks once and
// pages through the list of a local stand-in for the gateway); an edit runs without any Claude
// login and the fake Claude Code receives exactly the five variables and --model; the top bar and
// the activity panel name the service and model; Test sends one tiny request; choosing the Claude
// subscription again says Claude Code needs its login, and the API setup can be chosen again. The
// key never reaches a log, state.json or settings.json. The key is optional on this option:
// removing it keeps the option selected, Test says the service wants a key when it refuses a
// request without one, a server that needs none is tested and listed without any key header, and an
// edit runs with ANTHROPIC_AUTH_TOKEN=no-key and no ANTHROPIC_API_KEY.
import { readFile } from "node:fs/promises";
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
  withCleanup,
} from "../setups.mjs";
import { row, status } from "../ui.mjs";

const VIDEO = "001 Landscape Clip";
const KEYLESS_VIDEO = "002 Landscape Twin";
const ON_API = /^New edits run with Claude Code on Anthropic Compatible API with glm-5\.3/;
const LABEL = SETUP_LABEL.anthropicApi;

/** @type {import("../types.mjs").Scenario} */
export default {
  name: "anthropic-api",
  title:
    "Edits on an Anthropic compatible API without a Claude login: key, model, back again, no key",
  timeout: 180_000,
  async run(t) {
    await withCleanup(async () => {
      await startGateway();
      // Claude Code is installed but logged out; the API option's address is the stand-in.
      await t.fakeSet("logged_out");
      await t.seedLibrary(
        [
          [VIDEO, "landscape"],
          [KEYLESS_VIDEO, "landscape"],
        ],
        { apiOptions: apiOptions({ anthropicApi: { baseUrl: gateway.base } }) },
      );
      const server = await t.startServer();
      const page = await t.open(server);
      const body = page.locator("body");
      const modelLists = () => gateway.requests.filter((r) => r.path.endsWith("/v1/models"));
      /** The settings of the API option, opened from the top bar. */
      const optionForm = async () => {
        await page.getByRole("button", { name: /^New edits run with/ }).click();
        await page
          .getByRole("navigation", { name: "Settings" })
          .getByRole("button", { name: "Harness + API Keys" })
          .waitFor();
        const form = page.getByRole("group", { name: `Settings of ${LABEL}` });
        if (!(await form.isVisible())) {
          await page.getByRole("button", { name: `Configure ${LABEL}` }).click();
        }
        await form.waitFor();
        return form;
      };

      // The Claude subscription is still chosen and Claude Code is logged out, so the window
      // shows the login card (SPEC section 6, Readiness of a launch).
      await page.getByText("Log in to Claude Code").first().waitFor({ timeout: 30_000 });
      await t.shot(page, "anthropic-api-logged-out");

      // Back to the choice, the API option's card: the key, the typed model, Continue.
      await onboardOption(page, LABEL, KEY, "glm-5.3");
      t.equal(modelLists().length, 0, "a typed model needs no list: nothing asked for one");

      // The main window, without any Claude login: the service and model in the top bar.
      const video = row(page, VIDEO);
      await video.waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: ON_API }).waitFor();
      t.equal(
        await page.getByRole("button", { name: /^Model: / }).count(),
        0,
        "no Claude model picker on an API setup",
      );
      await page.getByText("Claude Code ready").first().waitFor();
      await t.shot(page, "anthropic-api-main");

      await video.getByRole("button", { name: "Start Editing" }).click();
      await page
        .getByRole("dialog", { name: "Start Editing" })
        .getByRole("button", { name: "Start Editing" })
        .click();
      await status(video, "Edited", 30_000);
      const [edit] = await claudeSessions(t);
      t.assert(edit, "the fake Claude Code ran the edit");
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
        const got = edit?.env[name];
        t.assert(
          got === value,
          `${name} is ${JSON.stringify(name === "ANTHROPIC_API_KEY" ? "(hidden)" : got)}`,
        );
      }
      expectParts(edit?.args ?? "", ["--model glm-5.3"], "The arguments");
      t.assert(!edit?.args.includes("--effort"), `--effort on an API setup: ${edit?.args}`);
      t.assert(!edit?.args.includes(KEY), "the key is an argument");
      // The key never reaches a file VidAI writes.
      for (const file of await filesUnder(t.data)) {
        const text = await readFile(file, "utf8").catch(() => "");
        t.assert(!text.includes(KEY), `the key is in ${path.relative(t.data, file)}`);
      }
      await video.getByRole("button", { name: VIDEO, exact: true }).click();
      const panel = page.getByRole("complementary", { name: "Activity" });
      await panel.getByText("Anthropic API").first().waitFor();
      await panel.getByText("glm-5.3").first().waitFor();
      await t.shot(page, "anthropic-api-panel");
      await panel.getByRole("tab", { name: "Log" }).click();
      await panel.getByText("Sent the edit instructions to Claude").first().waitFor();
      t.assert(!(await panel.innerText()).includes(KEY), "the key is not in the activity panel");

      // Settings: Test, then Fetch Models, then back to the Claude subscription and again.
      const form = await optionForm();
      await form.getByRole("button", { name: "Test", exact: true }).click();
      await page
        .getByText("Anthropic Compatible API answered with glm-5.3.")
        .first()
        .waitFor({ timeout: 20_000 });
      const test = gateway.requests.filter((r) => r.method === "POST").at(-1);
      t.assert(
        test?.bearer === "key" && test.body?.max_tokens === 1 && test.body?.model === "glm-5.3",
        `the Test request: ${JSON.stringify(test)}`,
      );
      // Fetch Models asks the service for its list (the only time), and the list is offered.
      await form.getByRole("button", { name: "Fetch Models" }).click();
      const list = page.getByRole("dialog", { name: "Models" });
      await list.getByRole("option", { name: "GLM-5.3 (glm-5.3)" }).waitFor({ timeout: 15_000 });
      t.assert(
        modelLists().length >= 2,
        `the model list was paged: ${JSON.stringify(modelLists())}`,
      );
      await page.keyboard.press("Escape");
      t.assert(!(await body.innerText()).includes(KEY), "the key is never shown");
      await t.shot(page, "anthropic-api-settings");

      // The Claude subscription needs the login of the logged out Claude Code, so choosing it
      // turns the window into the login card.
      await page
        .getByRole("radio", { name: new RegExp(`^${SETUP_LABEL.claudeSubscription}`) })
        .click();
      await page.getByText("Log in to Claude Code").first().waitFor({ timeout: 20_000 });
      await t.shot(page, "anthropic-api-back-to-subscription");
      // Back to the choice and the API option again: its key and model are saved, so its
      // Continue is enabled at once.
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.getByRole("radio", { name: new RegExp(`^${LABEL}`) }).click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("textbox", { name: "API Key (optional)" }).waitFor();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      // Settings was open when the onboarding took over, and is again.
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await row(page, VIDEO).waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: ON_API }).waitFor();

      // The key is optional on this option: remove it in Settings, and the option stays
      // selected, its field says so, and Test says the service wants a key when it refuses.
      const keyed = await optionForm();
      await keyed.getByRole("textbox", { name: "API Key (optional)" }).waitFor();
      await keyed.getByRole("button", { name: /^Remove/ }).click();
      await page
        .getByRole("alertdialog", { name: "Remove the API key?" })
        .getByRole("button", { name: "Remove Key" })
        .click();
      await page.getByText("API key removed").first().waitFor({ timeout: 20_000 });
      await page.getByText("Leave it empty if your server needs no key").first().waitFor();
      await keyed.getByRole("button", { name: "Test", exact: true }).click();
      await page.getByText("The service wants an API key").first().waitFor({ timeout: 20_000 });
      await t.shot(page, "anthropic-api-no-key-refused");

      // A server that needs no key: Test and Fetch Models send no key header at all.
      gateway.keyless = true;
      const lastWithoutKey = (/** @type {string} */ method, /** @type {string} */ suffix) =>
        gateway.requests.filter((r) => r.method === method && r.path.endsWith(suffix)).at(-1);
      await keyed.getByRole("button", { name: "Test", exact: true }).click();
      await page
        .getByText("Anthropic Compatible API answered with glm-5.3.")
        .first()
        .waitFor({ timeout: 20_000 });
      t.equal(lastWithoutKey("POST", "/v1/messages")?.bearer, "none", "Test sent no key");
      await keyed.getByRole("button", { name: "Fetch Models" }).click();
      await page
        .getByRole("dialog", { name: "Models" })
        .getByRole("option", { name: "GLM-5.3 (glm-5.3)" })
        .waitFor({ timeout: 15_000 });
      t.equal(lastWithoutKey("GET", "/v1/models")?.bearer, "none", "Fetch Models sent no key");
      await page.keyboard.press("Escape");
      await t.shot(page, "anthropic-api-no-key-settings");

      // The option is still selected: an edit runs without a key and without a login.
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("button", { name: ON_API }).waitFor();
      const twin = row(page, KEYLESS_VIDEO);
      await twin.waitFor({ timeout: 30_000 });
      await twin.getByRole("button", { name: "Start Editing" }).click();
      await page
        .getByRole("dialog", { name: "Start Editing" })
        .getByRole("button", { name: "Start Editing" })
        .click();
      await status(twin, "Edited", 30_000);
      const keyless = (await claudeSessions(t))[1];
      t.assert(keyless, "the second edit ran");
      const wantKeyless = {
        ANTHROPIC_BASE_URL: gateway.base,
        ANTHROPIC_API_KEY: "<unset>",
        ANTHROPIC_AUTH_TOKEN: "no-key",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3",
      };
      for (const [name, value] of Object.entries(wantKeyless)) {
        t.assert(
          keyless?.env[name] === value,
          `${name} is ${JSON.stringify(keyless?.env[name])}, expected ${value}`,
        );
      }
      expectParts(keyless?.args ?? "", ["--model glm-5.3"], "The arguments");
    }, stopGateway);
  },
};

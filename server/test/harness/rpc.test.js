// The admin harness functions end to end: RPC, settings, encrypted keys, events, and a local
// provider for the fetch and test requests.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createSettingsRepo } from "../../src/db/settings.js";
import { createHarnessModule } from "../../src/agents/index.js";
import { createSetupStore } from "../../src/agents/setupStore.js";
import { createTestApp, rejectsWith } from "../rpc/support.js";
import { startProvider } from "./fakeProvider.js";

const KEY = "sk-test-secret-1234";

/** @type {(() => Promise<void>)[]} */
const closers = [];
after(async () => {
  for (const close of closers) await close();
});

/**
 * @param {{ claudeModels?: import("../../../src/lib/wire/harness.ts").ClaudeModelInfo[], opencodeInstalled?: boolean }} [options]
 */
function setup({ claudeModels = [], opencodeInstalled = true } = {}) {
  const app = createTestApp();
  /** @type {{ event: string, payload: any, userId: string | null, admins: boolean }[]} */
  const emitted = [];
  const module = createHarnessModule({
    settingsRepo: createSettingsRepo(app.db),
    settings: app.settings,
    secrets: app.secrets,
    events: { emit: (event) => void emitted.push(/** @type {never} */ (event)), closeUser() {} },
    clock: app.clock,
    version: "1.2.3",
    claudeModels: async () => claudeModels,
    detectRouting: async () => null,
    probes: {
      locateClaude: async () => true,
      claudeLoggedIn: async () => true,
      locateOpencode: async () => ({
        found: opencodeInstalled,
        supported: opencodeInstalled,
        version: "2.2.6",
      }),
    },
  });
  app.rpc.register(module.rpc);
  const admin = app.makeUser("admin@example.com", { role: "admin" });
  const user = app.makeUser("user@example.com");
  const adminCtx = app.contextFor(admin);
  const userCtx = app.contextFor(user);
  /** @param {string} name @param {unknown} [input] */
  const asAdmin = (name, input = {}) => app.rpc.call(name, input, adminCtx);
  return { app, module, emitted, asAdmin, adminCtx, userCtx };
}

/** @param {unknown} state @returns {any} */
const as = (state) => state;

describe("access", () => {
  it("every admin function is for admins, the read-only ones for everybody signed in", async () => {
    const { app, module, userCtx } = setup();
    for (const fn of module.rpc) {
      if (fn.access === "admin") await rejectsWith(app.rpc.call(fn.name, {}, userCtx), "forbidden");
    }
    const anon = app.contextFor(null);
    await rejectsWith(app.rpc.call("getHarness", {}, anon), "unauthenticated");
    assert.deepEqual(
      module.rpc
        .filter((fn) => fn.access === "user")
        .map((fn) => fn.name)
        .sort(),
      ["getHarness", "getOpencodeUsage", "getReadiness"],
    );
  });

  it("users see the setup and model read-only, no keys or addresses", async () => {
    const { app, asAdmin, userCtx } = setup();
    await asAdmin("adminSetApiModel", { option: "anthropicApi", model: "glm-5.3" });
    await asAdmin("adminSetApiKey", { option: "anthropicApi", key: KEY });
    await asAdmin("adminSetSetup", { setup: "anthropicApi" });
    const view = as(await app.rpc.call("getHarness", {}, userCtx));
    assert.deepEqual(view, {
      setup: "anthropicApi",
      program: "claudeCode",
      model: "glm-5.3",
      modelName: "glm-5.3",
      effort: null,
    });
    assert.equal(JSON.stringify(view).includes(KEY), false);
  });
});

describe("the admin screen", () => {
  it("starts on the Claude subscription with the default addresses", async () => {
    const { asAdmin } = setup();
    const state = as(await asAdmin("adminGetHarness"));
    assert.equal(state.setup, "claudeSubscription");
    assert.equal(state.program, "claudeCode");
    assert.equal(
      state.options.opencodeGo.effectiveBaseUrl,
      "https://opencode.ai/inference/go/anthropic",
    );
    assert.equal(state.options.anthropicApi.defaultBaseUrl, "https://api.anthropic.com");
    assert.equal(state.options.openaiApi.effectiveBaseUrl, "https://opencode.ai/inference/go/v1");
    assert.deepEqual(
      ["opencodeGo", "anthropicApi", "openaiApi"].map((o) => state.options[o].keyRequired),
      [true, false, false],
    );
    assert.deepEqual(state.options.opencodeGo.key, { saved: false, last4: null });
    assert.deepEqual(state.claude, { model: null, effort: null, models: [] });
    assert.equal(state.claudeRouting, null);
  });

  it("shows only the status of a saved key and keeps it encrypted-store only", async () => {
    const { app, asAdmin } = setup();
    const state = as(await asAdmin("adminSetApiKey", { option: "opencodeGo", key: `  ${KEY} ` }));
    assert.deepEqual(state.options.opencodeGo.key, { saved: true, last4: "1234" });
    assert.equal(JSON.stringify(state).includes(KEY), false);
    assert.equal(app.secrets.get("opencode-go-api-key"), KEY);
    const rows = JSON.stringify(createSettingsRepo(app.db).all());
    assert.equal(rows.includes(KEY), false, "the key is not in the settings table");
    const cleared = as(await asAdmin("adminClearApiKey", { option: "opencodeGo" }));
    assert.deepEqual(cleared.options.opencodeGo.key, { saved: false, last4: null });
  });

  it("refuses a bad key, option, address, model and effort", async () => {
    const { asAdmin } = setup();
    await rejectsWith(
      asAdmin("adminSetApiKey", { option: "opencodeGo", key: "a b" }),
      "invalidInput",
      /no spaces/,
    );
    await rejectsWith(
      asAdmin("adminSetApiKey", { option: "nope", key: "k" }),
      "invalidInput",
      /API options/,
    );
    await rejectsWith(
      asAdmin("adminSetApiBaseUrl", { option: "anthropicApi", baseUrl: "http://example.com" }),
      "invalidInput",
      /Plain http/,
    );
    await rejectsWith(
      asAdmin("adminSetApiModel", { option: "openaiApi", model: "two words" }),
      "invalidInput",
      /not a model id/,
    );
    await rejectsWith(
      asAdmin("adminSetApiEffort", { option: "openaiApi", model: "m", effort: "extreme" }),
      "invalidInput",
      /one of/,
    );
    await rejectsWith(asAdmin("adminSetSetup", { setup: "nope" }), "invalidInput", /four setups/);
    await rejectsWith(
      asAdmin("adminSetApiKey", { option: "opencodeGo", key: "k", extra: 1 }),
      "invalidInput",
    );
  });

  it("stores a normalized address and null for the default", async () => {
    const { asAdmin } = setup();
    let state = as(
      await asAdmin("adminSetApiBaseUrl", {
        option: "anthropicApi",
        baseUrl: "https://proxy.example.com/v1/messages/",
      }),
    );
    assert.equal(state.options.anthropicApi.baseUrl, "https://proxy.example.com");
    assert.equal(state.options.anthropicApi.effectiveBaseUrl, "https://proxy.example.com");
    state = as(await asAdmin("adminSetApiBaseUrl", { option: "anthropicApi", baseUrl: null }));
    assert.equal(state.options.anthropicApi.baseUrl, null);
    assert.equal(state.options.anthropicApi.effectiveBaseUrl, "https://api.anthropic.com");
  });

  it("remembers an effort per model", async () => {
    const { asAdmin } = setup();
    await asAdmin("adminSetApiEffort", { option: "openaiApi", model: "a", effort: "high" });
    const state = as(
      await asAdmin("adminSetApiEffort", { option: "openaiApi", model: "b", effort: "low" }),
    );
    assert.deepEqual(state.options.openaiApi.efforts, { a: "high", b: "low" });
    const forgot = as(
      await asAdmin("adminSetApiEffort", { option: "openaiApi", model: "a", effort: null }),
    );
    assert.deepEqual(forgot.options.openaiApi.efforts, { b: "low" });
  });
});

describe("selecting a setup", () => {
  it("needs what the option needs", async () => {
    const { asAdmin } = setup();
    await rejectsWith(
      asAdmin("adminSetSetup", { setup: "opencodeGo" }),
      "invalidInput",
      /Save an API key and choose a model first\./,
    );
    await asAdmin("adminSetApiKey", { option: "opencodeGo", key: KEY });
    await rejectsWith(
      asAdmin("adminSetSetup", { setup: "opencodeGo" }),
      "invalidInput",
      /Choose a model first\./,
    );
    await asAdmin("adminSetApiModel", { option: "opencodeGo", model: "glm-5.3" });
    assert.equal(as(await asAdmin("adminSetSetup", { setup: "opencodeGo" })).setup, "opencodeGo");
    // The two compatible APIs need no key, only a model.
    await rejectsWith(
      asAdmin("adminSetSetup", { setup: "openaiApi" }),
      "invalidInput",
      /Type a model first\./,
    );
    await asAdmin("adminSetApiModel", { option: "openaiApi", model: "local" });
    const state = as(await asAdmin("adminSetSetup", { setup: "openaiApi" }));
    assert.equal(state.setup, "openaiApi");
    assert.equal(state.program, "opencode2");
  });

  it("goes back to the Claude subscription when the key or model of the selected option goes", async () => {
    const { asAdmin } = setup();
    await asAdmin("adminSetApiKey", { option: "opencodeGo", key: KEY });
    await asAdmin("adminSetApiModel", { option: "opencodeGo", model: "glm-5.3" });
    await asAdmin("adminSetSetup", { setup: "opencodeGo" });
    assert.equal(
      as(await asAdmin("adminClearApiKey", { option: "opencodeGo" })).setup,
      "claudeSubscription",
    );

    await asAdmin("adminSetApiModel", { option: "anthropicApi", model: "m" });
    await asAdmin("adminSetSetup", { setup: "anthropicApi" });
    // No key needed: clearing one keeps the selection ...
    assert.equal(
      as(await asAdmin("adminClearApiKey", { option: "anthropicApi" })).setup,
      "anthropicApi",
    );
    // ... clearing the model does not.
    assert.equal(
      as(await asAdmin("adminSetApiModel", { option: "anthropicApi", model: null })).setup,
      "claudeSubscription",
    );
  });

  it("tells every signed-in page with a settings-changed event", async () => {
    const { asAdmin, emitted } = setup();
    await asAdmin("adminSetApiModel", { option: "anthropicApi", model: "m" });
    await asAdmin("adminSetSetup", { setup: "anthropicApi" });
    const last = emitted.at(-1);
    assert.equal(last?.event, "settings-changed");
    assert.equal(last?.userId, null);
    assert.equal(last?.admins, false);
    assert.equal(last?.payload.setup, "anthropicApi");
    assert.deepEqual(last?.payload.harness, {
      setup: "anthropicApi",
      program: "claudeCode",
      model: "m",
      modelName: "m",
      effort: null,
    });
    assert.equal(typeof last?.payload.maxUploadGb, "number");
  });
});

describe("the Claude subscription model", () => {
  const models = [
    { value: "opus", displayName: "Opus", description: "", effortLevels: ["low", "high"] },
    { value: "haiku", displayName: "Haiku", description: "", effortLevels: [] },
  ];

  it("keeps a model and effort the list allows and names it for users", async () => {
    const { app, asAdmin, userCtx } = setup({ claudeModels: models });
    const state = as(await asAdmin("adminSetModelSelection", { model: "opus", effort: "high" }));
    assert.deepEqual(state.claude.model, "opus");
    assert.equal(state.claude.models.length, 2);
    const view = as(await app.rpc.call("getHarness", {}, userCtx));
    assert.equal(view.modelName, "Opus");
    assert.equal(view.effort, "high");
  });

  it("refuses an effort the model does not support", async () => {
    const { asAdmin } = setup({ claudeModels: models });
    await rejectsWith(
      asAdmin("adminSetModelSelection", { model: "opus", effort: "max" }),
      "invalidInput",
      /supports these reasoning efforts: low, high/,
    );
    await rejectsWith(
      asAdmin("adminSetModelSelection", { model: "haiku", effort: "low" }),
      "invalidInput",
      /no reasoning effort/,
    );
    const cleared = as(await asAdmin("adminSetModelSelection", { model: null, effort: null }));
    assert.deepEqual([cleared.claude.model, cleared.claude.effort], [null, null]);
  });
});

describe("models and the Test request against a provider", () => {
  it("fetches, keeps the OpenCode Go list for its address, and tests with the display name", async () => {
    const p = await startProvider(({ url, headers }) => {
      if (url.startsWith("/v1/models")) {
        return {
          status: 200,
          body: JSON.stringify({
            data: [
              { id: "glm-5.3", display_name: "GLM-5.3" },
              { id: "kimi", display_name: "Kimi" },
            ],
            has_more: false,
          }),
        };
      }
      return headers.authorization === `Bearer ${KEY}`
        ? { status: 200, body: JSON.stringify({ type: "message" }) }
        : { status: 401, body: "{}" };
    });
    closers.push(p.close);
    const { asAdmin, module } = setup();
    await asAdmin("adminSetApiBaseUrl", { option: "opencodeGo", baseUrl: p.url });
    await asAdmin("adminSetApiKey", { option: "opencodeGo", key: KEY });

    const empty = as(await asAdmin("adminGetApiModels", { option: "opencodeGo" }));
    assert.deepEqual([empty.models, empty.fetchedAt], [[], null]);
    const fetched = as(await asAdmin("adminGetApiModels", { option: "opencodeGo", refresh: true }));
    assert.deepEqual(
      fetched.models.map((/** @type {{ id: string }} */ m) => m.id),
      ["glm-5.3", "kimi"],
    );
    assert.equal(typeof fetched.fetchedAt, "number");
    const kept = as(await asAdmin("adminGetApiModels", { option: "opencodeGo" }));
    assert.equal(kept.models.length, 2);

    await rejectsWith(
      asAdmin("adminTestApi", { option: "opencodeGo" }),
      "invalidInput",
      /Choose a model first/,
    );
    await asAdmin("adminSetApiModel", { option: "opencodeGo", model: "glm-5.3" });
    assert.deepEqual(await asAdmin("adminTestApi", { option: "opencodeGo" }), {
      ok: true,
      message: "OpenCode Go answered with GLM-5.3.",
    });

    // A model the last list no longer offers blocks a launch, not the settings.
    await asAdmin("adminSetApiModel", { option: "opencodeGo", model: "gone" });
    assert.match(module.service.apiSetup("opencodeGo").offered?.join(",") ?? "", /glm-5\.3,kimi/);

    // The list belongs to its address: another address has none.
    await asAdmin("adminSetApiBaseUrl", { option: "opencodeGo", baseUrl: "http://127.0.0.1:9" });
    assert.equal(as(await asAdmin("adminGetApiModels", { option: "opencodeGo" })).models.length, 0);
  });

  it("does not keep the list of the compatible APIs and needs no key to test them", async () => {
    const p = await startProvider(({ url }) =>
      url === "/v1/models"
        ? { status: 200, body: JSON.stringify({ data: [{ id: "llama3" }] }) }
        : { status: 200, body: JSON.stringify({ choices: [{}] }) },
    );
    closers.push(p.close);
    const { asAdmin } = setup();
    await asAdmin("adminSetApiBaseUrl", { option: "openaiApi", baseUrl: `${p.url}/v1` });
    const fetched = as(await asAdmin("adminGetApiModels", { option: "openaiApi", refresh: true }));
    assert.deepEqual(fetched.models, [{ id: "llama3", displayName: "llama3" }]);
    assert.equal(as(await asAdmin("adminGetApiModels", { option: "openaiApi" })).models.length, 0);
    await asAdmin("adminSetApiModel", { option: "openaiApi", model: "llama3" });
    assert.equal(as(await asAdmin("adminTestApi", { option: "openaiApi" })).ok, true);
    assert.equal(p.seen.at(-1)?.headers.authorization, undefined);
  });

  it("OpenCode Go cannot be tested without a key", async () => {
    const { asAdmin } = setup();
    await rejectsWith(
      asAdmin("adminTestApi", { option: "opencodeGo" }),
      "invalidInput",
      /Save a key first/,
    );
  });

  it("never puts a key into the error of a refused request", async () => {
    const p = await startProvider(() => ({
      status: 401,
      body: JSON.stringify({ error: { type: "AuthError", message: KEY } }),
    }));
    closers.push(p.close);
    const { asAdmin } = setup();
    await asAdmin("adminSetApiBaseUrl", { option: "anthropicApi", baseUrl: p.url });
    await asAdmin("adminSetApiKey", { option: "anthropicApi", key: KEY });
    await assert.rejects(
      asAdmin("adminGetApiModels", { option: "anthropicApi", refresh: true }),
      (error) => {
        assert.equal(/** @type {Error} */ (error).message.includes(KEY), false);
        return true;
      },
    );
  });
});

describe("what the job engine takes", () => {
  it("launchFor gives the setup, program, model, effort, address and key", async () => {
    const { asAdmin, module } = setup();
    assert.deepEqual(module.launchFor(), {
      setup: "claudeSubscription",
      program: "claudeCode",
      option: null,
      model: null,
      effort: null,
      baseUrl: null,
      key: null,
    });
    await asAdmin("adminSetApiKey", { option: "anthropicApi", key: KEY });
    await asAdmin("adminSetApiModel", { option: "anthropicApi", model: "glm-5.3" });
    await asAdmin("adminSetApiEffort", {
      option: "anthropicApi",
      model: "glm-5.3",
      effort: "xhigh",
    });
    const launch = module.launchFor("anthropicApi");
    assert.deepEqual(launch, {
      setup: "anthropicApi",
      program: "claudeCode",
      option: "anthropicApi",
      model: "glm-5.3",
      effort: "xhigh",
      baseUrl: "https://api.anthropic.com",
      key: KEY,
    });
    const env = module.jobEnv(launch, { PATH: "/bin" });
    assert.equal(env.ANTHROPIC_API_KEY, KEY);
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "glm-5.3");
  });

  it("secretsToScrub lists every saved key and only those", async () => {
    const { asAdmin, module } = setup();
    assert.deepEqual(module.secretsToScrub(), []);
    await asAdmin("adminSetApiKey", { option: "opencodeGo", key: "key-one-1111" });
    await asAdmin("adminSetApiKey", { option: "openaiApi", key: "key-two-2222" });
    assert.deepEqual(module.secretsToScrub().sort(), ["key-one-1111", "key-two-2222"]);
  });

  it("readiness follows the selected setup and tells users to ask an admin", async () => {
    const { app, asAdmin, module, userCtx, adminCtx } = setup({ opencodeInstalled: false });
    assert.equal(as(await app.rpc.call("getReadiness", {}, adminCtx)).problem, null);
    await asAdmin("adminSetApiKey", { option: "opencodeGo", key: KEY });
    await asAdmin("adminSetApiModel", { option: "opencodeGo", model: "glm-5.3" });
    await asAdmin("adminSetSetup", { setup: "opencodeGo" });
    const forAdmin = as(await app.rpc.call("getReadiness", {}, adminCtx));
    assert.equal(forAdmin.problem, "programMissing");
    assert.match(forAdmin.message, /Fix it|See Admin/);
    const forUser = as(await app.rpc.call("getReadiness", {}, userCtx));
    assert.equal(forUser.problem, "programMissing");
    assert.match(forUser.message, /Ask an admin/);
    await rejectsWith(module.ensureReady(), "notReady", /not installed/);
  });
});

describe("the stored settings", () => {
  it("read leniently: damaged rows fall back to defaults", () => {
    const app = createTestApp();
    const repo = createSettingsRepo(app.db);
    repo.set("harness.options", {
      opencodeGo: { baseUrl: 5, model: "  ", efforts: { a: "extreme", b: "low" } },
      junk: 1,
    });
    repo.set("harness.claude", "nope");
    repo.set("harness.apiModels", {
      opencodeGo: { baseUrl: "https://x", models: [{ id: "a" }, 3], fetchedAt: "x" },
    });
    const store = createSetupStore({ repo });
    assert.deepEqual(store.option("opencodeGo"), {
      baseUrl: null,
      model: null,
      efforts: { b: "low" },
    });
    assert.deepEqual(store.option("anthropicApi"), { baseUrl: null, model: null, efforts: {} });
    assert.deepEqual(store.claude(), { model: null, effort: null });
    assert.equal(store.apiModels("anthropicApi"), null);
  });
});

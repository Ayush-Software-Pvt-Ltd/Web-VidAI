import { afterEach, describe, expect, it } from "vitest";
import type { SettingsChangedPayload } from "../../rpc";
import { MockBackend } from "../backend";
import type { ScenarioName } from "../scenarios";
import { harnessSim, SAMPLE_OPENCODE_KEY } from "../seed/harness";
import { normalizeBaseUrl } from "../apiRules";

const made: MockBackend[] = [];

function mock(scenarios: ScenarioName[] = ["default"], as?: "admin" | "user" | null) {
  const backend = new MockBackend({
    scenarios,
    latencyMs: 0,
    autoTick: false,
    ...(as === undefined ? {} : { as }),
  });
  made.push(backend);
  return backend;
}

afterEach(() => {
  for (const backend of made.splice(0)) backend.dispose();
});

async function saveGoKeyAndModel(backend: MockBackend, model = "glm-5.3") {
  await backend.adminSetApiKey({ option: "opencodeGo", key: SAMPLE_OPENCODE_KEY });
  await backend.adminSetApiModel({ option: "opencodeGo", model });
}

describe("mock harness: access and state", () => {
  it("starts on the Claude subscription with no keys and the Claude model list", async () => {
    const state = await mock().adminGetHarness();
    expect(state.setup).toBe("claudeSubscription");
    expect(state.program).toBe("claudeCode");
    expect(state.options.opencodeGo.key).toEqual({ saved: false, last4: null });
    expect(state.options.opencodeGo.keyRequired).toBe(true);
    expect(state.options.anthropicApi.keyRequired).toBe(false);
    expect(state.claude.models.map((m) => m.displayName)).toEqual([
      "Opus 5.5",
      "Sonnet 5.5",
      "Haiku 5.5",
    ]);
  });

  it("refuses every function to a plain user and to nobody signed in", async () => {
    for (const as of ["user", null] as const) {
      const backend = mock(["default"], as);
      const code = as === null ? "unauthenticated" : "forbidden";
      await expect(backend.adminGetHarness()).rejects.toMatchObject({ code });
      await expect(backend.adminSetSetup({ setup: "claudeSubscription" })).rejects.toMatchObject({
        code,
      });
      await expect(backend.adminTestApi({ option: "opencodeGo" })).rejects.toMatchObject({ code });
    }
  });

  it("lets a user read the public harness", async () => {
    const backend = mock(["setup-opencode-go"], "user");
    expect(await backend.getHarness()).toMatchObject({
      setup: "opencodeGo",
      program: "opencode2",
      model: "glm-5.3",
      modelName: "GLM-5.3",
      effort: "high",
    });
  });
});

describe("mock harness: keys", () => {
  it("keeps only the last 4 characters on the wire and trims the key", async () => {
    const backend = mock();
    const state = await backend.adminSetApiKey({
      option: "opencodeGo",
      key: `  ${SAMPLE_OPENCODE_KEY}  `,
    });
    expect(state.options.opencodeGo.key).toEqual({ saved: true, last4: "7c3a" });
    expect(JSON.stringify(state)).not.toContain(SAMPLE_OPENCODE_KEY);
    expect(harnessSim(backend.world).keys.opencodeGo).toBe(SAMPLE_OPENCODE_KEY);
  });

  it("refuses an empty key and a key with spaces", async () => {
    const backend = mock();
    await expect(
      backend.adminSetApiKey({ option: "opencodeGo", key: "   " }),
    ).rejects.toMatchObject({
      code: "invalidInput",
      message: "Enter an API key.",
    });
    await expect(
      backend.adminSetApiKey({ option: "opencodeGo", key: "sk-test one" }),
    ).rejects.toMatchObject({
      message: "An API key has no spaces or line breaks. Copy it again and paste only the key.",
    });
    expect((await backend.adminGetHarness()).options.opencodeGo.key.saved).toBe(false);
  });

  it("shows no last 4 characters for a key that is too short", async () => {
    const state = await mock().adminSetApiKey({ option: "anthropicApi", key: "sk-tiny" });
    expect(state.options.anthropicApi.key).toEqual({ saved: true, last4: null });
  });

  it("sends the key back to the Claude subscription when OpenCode Go's key is removed", async () => {
    const backend = mock(["setup-opencode-go"]);
    const state = await backend.adminClearApiKey({ option: "opencodeGo" });
    expect(state.options.opencodeGo.key.saved).toBe(false);
    expect(state.setup).toBe("claudeSubscription");
    expect(state.program).toBe("claudeCode");
    expect(backend.world.harnessPublic.setup).toBe("claudeSubscription");
    expect(backend.world.adminSettings.setup).toBe("claudeSubscription");
  });

  it("keeps a compatible API selected when its key is removed (it works without)", async () => {
    const backend = mock(["setup-anthropic-api"]);
    const state = await backend.adminClearApiKey({ option: "anthropicApi" });
    expect(state.setup).toBe("anthropicApi");
    expect(state.options.anthropicApi.key.saved).toBe(false);
  });
});

describe("mock harness: choosing the setup", () => {
  it("refuses OpenCode Go without a key and a model, with the server's sentences", async () => {
    const backend = mock();
    await expect(backend.adminSetSetup({ setup: "opencodeGo" })).rejects.toMatchObject({
      code: "invalidInput",
      message: "Save an API key and choose a model first.",
    });
    await backend.adminSetApiModel({ option: "opencodeGo", model: "glm-5.3" });
    await expect(backend.adminSetSetup({ setup: "opencodeGo" })).rejects.toMatchObject({
      message: "Save an API key first.",
    });
    await backend.adminSetApiKey({ option: "opencodeGo", key: SAMPLE_OPENCODE_KEY });
    await backend.adminSetApiModel({ option: "opencodeGo", model: null });
    await expect(backend.adminSetSetup({ setup: "opencodeGo" })).rejects.toMatchObject({
      message: "Choose a model first.",
    });
  });

  it("asks for a typed model on a compatible API but not for a key", async () => {
    const backend = mock();
    await expect(backend.adminSetSetup({ setup: "openaiApi" })).rejects.toMatchObject({
      message: "Type a model first.",
    });
    await backend.adminSetApiModel({ option: "openaiApi", model: "gpt-5.3" });
    const state = await backend.adminSetSetup({ setup: "openaiApi" });
    expect(state).toMatchObject({ setup: "openaiApi", program: "opencode2" });
  });

  it("refuses a name that is not one of the four setups", async () => {
    await expect(mock().adminSetSetup({ setup: "other" as never })).rejects.toMatchObject({
      message: "That is not one of the four setups.",
    });
  });

  it("keeps the public view, the settings and the readiness in step and tells everybody", async () => {
    const admin = mock();
    const user = new MockBackend({
      scenarios: ["default"],
      latencyMs: 0,
      autoTick: false,
      as: "user",
      world: admin.world,
    });
    made.push(user);
    const seen: SettingsChangedPayload[] = [];
    user.on.settingsChanged((payload) => seen.push(payload));
    await saveGoKeyAndModel(admin);
    seen.length = 0;
    await admin.adminSetSetup({ setup: "opencodeGo" });
    expect(admin.world.adminSettings.setup).toBe("opencodeGo");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.setup).toBe("opencodeGo");
    expect(seen[0]?.harness).toMatchObject({ program: "opencode2", model: "glm-5.3" });
  });

  it("falls back to the Claude subscription when the selected option loses its model", async () => {
    const backend = mock(["setup-anthropic-api"]);
    const state = await backend.adminSetApiModel({ option: "anthropicApi", model: null });
    expect(state.setup).toBe("claudeSubscription");
    expect(state.options.anthropicApi.model).toBeNull();
  });
});

describe("mock harness: addresses", () => {
  it("normalizes the address per protocol and stores the default as null", async () => {
    const backend = mock();
    let state = await backend.adminSetApiBaseUrl({
      option: "anthropicApi",
      baseUrl: "https://gateway.example.com/v1/messages/",
    });
    expect(state.options.anthropicApi).toMatchObject({
      baseUrl: "https://gateway.example.com",
      effectiveBaseUrl: "https://gateway.example.com",
    });
    state = await backend.adminSetApiBaseUrl({
      option: "openaiApi",
      baseUrl: "https://gateway.example.com/v1/chat/completions",
    });
    expect(state.options.openaiApi.baseUrl).toBe("https://gateway.example.com/v1");
    state = await backend.adminSetApiBaseUrl({
      option: "anthropicApi",
      baseUrl: "https://api.anthropic.com/v1",
    });
    expect(state.options.anthropicApi.baseUrl).toBeNull();
    expect(state.options.anthropicApi.effectiveBaseUrl).toBe("https://api.anthropic.com");
    state = await backend.adminSetApiBaseUrl({ option: "openaiApi", baseUrl: null });
    expect(state.options.openaiApi.baseUrl).toBeNull();
  });

  it("refuses the addresses the server refuses, with its sentences", () => {
    const refused = (text: string) => {
      try {
        normalizeBaseUrl("anthropicApi", text);
      } catch (error) {
        return (error as Error).message;
      }
      return null;
    };
    expect(refused("http://gateway.example.com")).toContain("Use https:// for the address");
    expect(refused("http://localhost:8080")).toBeNull();
    expect(refused("not an address")).toBe(
      "Enter an address that starts with https://, for example https://api.anthropic.com.",
    );
    expect(refused("https://user:pass@example.com")).toBe(
      "Leave the user name and password out of the address; VidAI sends the API key itself.",
    );
    expect(refused("https://example.com/path?x=1")).toBe(
      "The address cannot contain a ? or # part.",
    );
  });

  it("does not change the address when it is refused", async () => {
    const backend = mock();
    await expect(
      backend.adminSetApiBaseUrl({ option: "openaiApi", baseUrl: "http://example.com" }),
    ).rejects.toMatchObject({ code: "invalidInput" });
    expect((await backend.adminGetHarness()).options.openaiApi.baseUrl).toBeNull();
  });
});

describe("mock harness: models and efforts", () => {
  it("keeps an effort per model and forgets one with null", async () => {
    const backend = mock();
    await backend.adminSetApiEffort({ option: "openaiApi", model: "gpt-5.3", effort: "high" });
    let state = await backend.adminSetApiEffort({
      option: "openaiApi",
      model: "glm-5.3",
      effort: "low",
    });
    expect(state.options.openaiApi.efforts).toEqual({ "gpt-5.3": "high", "glm-5.3": "low" });
    state = await backend.adminSetApiEffort({
      option: "openaiApi",
      model: "gpt-5.3",
      effort: null,
    });
    expect(state.options.openaiApi.efforts).toEqual({ "glm-5.3": "low" });
  });

  it("refuses an effort that is not one of the five and a model id with spaces", async () => {
    const backend = mock();
    await expect(
      backend.adminSetApiEffort({ option: "openaiApi", model: "gpt-5.3", effort: "extreme" }),
    ).rejects.toMatchObject({
      message: "The reasoning effort must be one of: low, medium, high, xhigh, max.",
    });
    await expect(
      backend.adminSetApiModel({ option: "openaiApi", model: "gpt 5" }),
    ).rejects.toMatchObject({ message: "That is not a model id." });
  });

  it("sets the Claude model and effort and refuses an effort the model does not have", async () => {
    const backend = mock();
    const state = await backend.adminSetModelSelection({
      model: "claude-sonnet-5-5",
      effort: "high",
    });
    expect(state.claude).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
    expect(backend.world.harnessPublic).toMatchObject({
      model: "claude-sonnet-5-5",
      modelName: "Sonnet 5.5",
      effort: "high",
    });
    await expect(
      backend.adminSetModelSelection({ model: "claude-sonnet-5-5", effort: "max" }),
    ).rejects.toMatchObject({
      message: "Sonnet 5.5 supports these reasoning efforts: low, medium, high.",
    });
    await expect(
      backend.adminSetModelSelection({ model: "claude-haiku-5-5", effort: "low" }),
    ).rejects.toMatchObject({ message: "Haiku 5.5 has no reasoning effort to choose." });
    expect((await backend.adminGetHarness()).claude.model).toBe("claude-sonnet-5-5");
  });

  it("answers the kept list without fetching, empty for an option that keeps none", async () => {
    const backend = mock(["setup-opencode-go"]);
    const kept = await backend.adminGetApiModels({ option: "opencodeGo" });
    expect(kept.models).toHaveLength(30);
    expect(kept.fetchedAt).not.toBeNull();
    const none = await backend.adminGetApiModels({ option: "anthropicApi" });
    expect(none).toMatchObject({ models: [], fetchedAt: null });
  });

  it("fetches the list of the address and keeps only OpenCode Go's", async () => {
    const backend = mock();
    const fetched = await backend.adminGetApiModels({ option: "opencodeGo", refresh: true });
    expect(fetched.models).toHaveLength(30);
    expect((await backend.adminGetApiModels({ option: "opencodeGo" })).fetchedAt).toBe(
      fetched.fetchedAt,
    );
    const claude = await backend.adminGetApiModels({ option: "anthropicApi", refresh: true });
    expect(claude.models.map((m) => m.id)).toContain("claude-sonnet-5-5");
    expect((await backend.adminGetApiModels({ option: "anthropicApi" })).models).toEqual([]);
    await backend.adminSetApiBaseUrl({
      option: "openaiApi",
      baseUrl: "https://opencode.ai/zen/v1",
    });
    expect(
      (await backend.adminGetApiModels({ option: "openaiApi", refresh: true })).models,
    ).toHaveLength(86);
  });

  it("forgets the kept list when the address changes", async () => {
    const backend = mock(["setup-opencode-go"]);
    await backend.adminSetApiBaseUrl({
      option: "opencodeGo",
      baseUrl: "https://gateway.example.com",
    });
    expect((await backend.adminGetApiModels({ option: "opencodeGo" })).models).toEqual([]);
  });

  it("fails the fetch for an address with fail in it, a stopped local server and the switch", async () => {
    const backend = mock();
    await backend.adminSetApiBaseUrl({ option: "openaiApi", baseUrl: "https://fail.example.com" });
    await expect(
      backend.adminGetApiModels({ option: "openaiApi", refresh: true }),
    ).rejects.toMatchObject({
      message: "Could not reach the service. Check the address and your internet connection.",
    });
    await backend.adminSetApiBaseUrl({ option: "openaiApi", baseUrl: "http://localhost:11434/v1" });
    await expect(
      backend.adminGetApiModels({ option: "openaiApi", refresh: true }),
    ).rejects.toMatchObject({ code: "io" });
    await backend.adminSetApiBaseUrl({ option: "openaiApi", baseUrl: null });
    harnessSim(backend.world).modelsFail = true;
    await expect(
      backend.adminGetApiModels({ option: "opencodeGo", refresh: true }),
    ).rejects.toMatchObject({
      message: "Could not reach OpenCode. Check the address and your internet connection.",
    });
  });
});

describe("mock harness: Test", () => {
  it("answers ok with the model's name", async () => {
    const backend = mock(["setup-opencode-go"]);
    expect(await backend.adminTestApi({ option: "opencodeGo" })).toEqual({
      ok: true,
      message: "OpenCode Go answered with GLM-5.3.",
    });
  });

  it("says the key was refused when it contains _bad", async () => {
    const backend = mock();
    await backend.adminSetApiKey({ option: "opencodeGo", key: "oc_sk_bad_0123456789" });
    await backend.adminSetApiModel({ option: "opencodeGo", model: "glm-5.3" });
    expect(await backend.adminTestApi({ option: "opencodeGo" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("OpenCode did not accept the API key") as string,
    });
  });

  it("refuses a free model on an OpenCode address", async () => {
    const backend = mock(["setup-opencode-go"]);
    await backend.adminSetApiModel({ option: "opencodeGo", model: "glm-5.3-flash-free" });
    const result = await backend.adminTestApi({ option: "opencodeGo" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Choose another model in Admin, Harness and Model.");
  });

  it("throws the server's sentences while the key or the model is missing", async () => {
    const backend = mock();
    await expect(backend.adminTestApi({ option: "opencodeGo" })).rejects.toMatchObject({
      message: "No API key is saved for this option. Save a key first.",
    });
    await expect(backend.adminTestApi({ option: "openaiApi" })).rejects.toMatchObject({
      message: "Type a model first.",
    });
    await backend.adminSetApiKey({ option: "opencodeGo", key: SAMPLE_OPENCODE_KEY });
    await expect(backend.adminTestApi({ option: "opencodeGo" })).rejects.toMatchObject({
      message: "Choose a model first.",
    });
  });

  it("reports an address that cannot be reached as a failed test, not an error", async () => {
    const backend = mock(["setup-openai-api"]);
    await backend.adminSetApiBaseUrl({ option: "openaiApi", baseUrl: "http://localhost:11434/v1" });
    expect(await backend.adminTestApi({ option: "openaiApi" })).toMatchObject({ ok: false });
  });
});

describe("mock harness: scenarios and readiness", () => {
  it("sets up the four setups", async () => {
    for (const [name, setup] of [
      ["setup-opencode-go", "opencodeGo"],
      ["setup-anthropic-api", "anthropicApi"],
      ["setup-openai-api", "openaiApi"],
    ] as const) {
      const state = await mock([name]).adminGetHarness();
      expect(state.setup).toBe(setup);
    }
    expect((await mock(["setup-ready"]).adminGetHarness()).claude).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "high",
    });
  });

  it("leaves the model of setup-model-gone out of the kept list", async () => {
    const backend = mock(["setup-model-gone"]);
    const state = await backend.adminGetHarness();
    const list = await backend.adminGetApiModels({ option: "opencodeGo" });
    expect(list.models.map((m) => m.id)).not.toContain(state.options.opencodeGo.model);
  });

  it("shows where the server's Claude Code is pointed in claude-routed", async () => {
    expect((await mock(["claude-routed"]).adminGetHarness()).claudeRouting).toEqual({
      baseUrl: "https://gateway.example.com",
      source: "environment",
    });
  });

  it("keeps a Claude login problem for the Claude subscription across a switch and back", async () => {
    const backend = mock(["not-ready"]);
    expect((await backend.getReadiness()).problem).toBe("claudeLoggedOut");
    await saveGoKeyAndModel(backend);
    await backend.adminSetSetup({ setup: "opencodeGo" });
    expect((await backend.getReadiness()).problem).toBeNull();
    await backend.adminSetSetup({ setup: "claudeSubscription" });
    const readiness = await backend.getReadiness();
    expect(readiness.problem).toBe("claudeLoggedOut");
    expect(readiness.message).toContain("Run claude once in a terminal there and sign in.");
  });

  it("tells a user to ask an admin, and an admin where to fix it", async () => {
    const backend = mock(["system-problems"]);
    expect((await backend.getReadiness()).message).toContain("Press Prepare in Admin, System.");
    const user = new MockBackend({
      scenarios: ["default"],
      latencyMs: 0,
      autoTick: false,
      as: "user",
      world: backend.world,
    });
    made.push(user);
    expect((await user.getReadiness()).message).toContain("Ask an admin to fix it.");
  });
});

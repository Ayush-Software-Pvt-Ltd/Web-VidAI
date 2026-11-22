// Addresses, keys, job environment and the selection rules (docs/SPEC-desktop.md section 7a;
// ported from the tests of src-tauri/src/opencode/mod.rs).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  API_OPTIONS,
  GO_BASE_URL,
  NO_KEY_TOKEN,
  SCRUBBED,
  checkEffort,
  defaultBaseUrl,
  keyName,
  keyRequired,
  noModelText,
  normalizeKey,
  normalizeModelId,
  optionOfSetup,
  programOf,
  scrubKey,
} from "../../src/agents/setups.js";
import { jobEnv, problemWith, selectionProblem } from "../../src/agents/setupsJob.js";
import { normalizeBaseUrl } from "../../src/agents/setupsUrl.js";

/** @param {() => unknown} call @param {RegExp} message */
const refuses = (call, message) =>
  assert.throws(call, (error) => {
    assert.equal(/** @type {{ code: string }} */ (error).code, "invalidInput");
    assert.match(/** @type {Error} */ (error).message, message);
    return true;
  });

describe("the four setups", () => {
  it("map to their option and program", () => {
    assert.equal(optionOfSetup("claudeSubscription"), null);
    assert.equal(programOf("claudeSubscription"), "claudeCode");
    assert.equal(programOf("anthropicApi"), "claudeCode");
    assert.equal(programOf("opencodeGo"), "opencode2");
    assert.equal(programOf("openaiApi"), "opencode2");
    assert.deepEqual([...API_OPTIONS], ["opencodeGo", "anthropicApi", "openaiApi"]);
  });

  it("need a key only on OpenCode Go, with a secret name each", () => {
    assert.deepEqual(API_OPTIONS.map(keyRequired), [true, false, false]);
    assert.equal(new Set(API_OPTIONS.map(keyName)).size, 3);
    assert.equal(keyName("opencodeGo"), "opencode-go-api-key");
    assert.equal(noModelText("opencodeGo"), "Choose a model first.");
    assert.equal(noModelText("openaiApi"), "Type a model first.");
  });
});

describe("normalizeBaseUrl", () => {
  it("keeps the default address as null, also when typed", () => {
    for (const option of API_OPTIONS) {
      assert.equal(normalizeBaseUrl(option, null), null);
      assert.equal(normalizeBaseUrl(option, "   "), null);
      assert.equal(normalizeBaseUrl(option, `${defaultBaseUrl(option)}/`), null);
    }
    assert.equal(normalizeBaseUrl("opencodeGo", `${GO_BASE_URL}/v1/messages`), null);
  });

  it("takes the Anthropic form without /v1/messages and /v1", () => {
    assert.equal(
      normalizeBaseUrl("anthropicApi", "https://proxy.example.com/v1/messages"),
      "https://proxy.example.com",
    );
    assert.equal(
      normalizeBaseUrl("anthropicApi", " HTTPS://Proxy.Example.com/gw/V1/ "),
      "https://proxy.example.com/gw",
    );
    assert.equal(
      normalizeBaseUrl("opencodeGo", "https://opencode.ai/inference/anthropic/v1"),
      "https://opencode.ai/inference/anthropic",
    );
  });

  it("keeps /v1 of the OpenAI form and drops /chat/completions", () => {
    assert.equal(
      normalizeBaseUrl("openaiApi", "https://api.example.com/v1/chat/completions"),
      "https://api.example.com/v1",
    );
    assert.equal(
      normalizeBaseUrl("openaiApi", "https://api.example.com/v1/"),
      "https://api.example.com/v1",
    );
  });

  it("allows plain http only for this computer", () => {
    assert.equal(
      normalizeBaseUrl("openaiApi", "http://localhost:11434/v1"),
      "http://localhost:11434/v1",
    );
    assert.equal(
      normalizeBaseUrl("anthropicApi", "http://127.0.0.1:8080"),
      "http://127.0.0.1:8080",
    );
    assert.equal(normalizeBaseUrl("anthropicApi", "http://[::1]:8080"), "http://[::1]:8080");
    refuses(() => normalizeBaseUrl("anthropicApi", "http://proxy.example.com"), /Plain http:\/\//);
  });

  it("refuses what cannot be an address", () => {
    refuses(() => normalizeBaseUrl("anthropicApi", "proxy.example.com"), /starts with https:\/\//);
    refuses(
      () => normalizeBaseUrl("anthropicApi", "ftp://proxy.example.com"),
      /starts with https:\/\//,
    );
    refuses(
      () => normalizeBaseUrl("anthropicApi", "https://me:secret@proxy.example.com"),
      /user name/,
    );
    refuses(() => normalizeBaseUrl("anthropicApi", "https://proxy.example.com?key=1"), /\? or #/);
    refuses(() => normalizeBaseUrl("anthropicApi", "https://proxy.example.com#x"), /\? or #/);
    refuses(() => normalizeBaseUrl("anthropicApi", "https://proxy.example.com/?"), /\? or #/);
    refuses(() => normalizeBaseUrl("anthropicApi", 5), /must be text/);
  });
});

describe("keys, models and efforts", () => {
  it("trim a key and refuse spaces inside", () => {
    assert.equal(normalizeKey("  sk-test-1234  "), "sk-test-1234");
    refuses(() => normalizeKey(""), /Enter an API key/);
    refuses(() => normalizeKey("sk test"), /no spaces/);
    refuses(() => normalizeKey("sk-a\nsk-b"), /no spaces/);
  });

  it("scrub a key from a text", () => {
    assert.equal(scrubKey("bad key sk-secret-1 here", "sk-secret-1"), `bad key ${SCRUBBED} here`);
    assert.equal(scrubKey("nothing", null), "nothing");
    assert.equal(scrubKey("nothing", "  "), "nothing");
  });

  it("check a model id and an effort", () => {
    assert.equal(normalizeModelId(" glm-5.3 "), "glm-5.3");
    refuses(() => normalizeModelId("two words"), /not a model id/);
    refuses(() => normalizeModelId(""), /not a model id/);
    assert.equal(checkEffort("xhigh"), "xhigh");
    refuses(() => checkEffort("extreme"), /one of: low, medium, high, xhigh, max/);
  });
});

describe("jobEnv", () => {
  const base = { PATH: "/bin", ANTHROPIC_AUTH_TOKEN: "login", ANTHROPIC_API_KEY: "own" };

  it("leaves every other setup exactly as it is", () => {
    for (const setup of /** @type {const} */ (["claudeSubscription", "opencodeGo", "openaiApi"])) {
      assert.deepEqual(jobEnv({ setup, baseUrl: "https://x", key: "k", model: "m" }, base), base);
    }
  });

  it("points Claude Code at the API with the key and one model for every alias", () => {
    const env = jobEnv(
      {
        setup: "anthropicApi",
        baseUrl: "https://proxy.example.com",
        key: "sk-1",
        model: "glm-5.3",
      },
      base,
    );
    assert.equal(env.ANTHROPIC_BASE_URL, "https://proxy.example.com");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-1");
    assert.equal("ANTHROPIC_AUTH_TOKEN" in env, false);
    for (const alias of ["OPUS", "SONNET", "HAIKU"]) {
      assert.equal(env[`ANTHROPIC_DEFAULT_${alias}_MODEL`], "glm-5.3");
    }
    assert.equal(env.PATH, "/bin");
    assert.equal(base.ANTHROPIC_API_KEY, "own", "the base environment is not changed");
  });

  it("without a key sends no environment key and a placeholder token", () => {
    const env = jobEnv(
      { setup: "anthropicApi", baseUrl: "http://localhost:8080", key: null, model: "local" },
      base,
    );
    assert.equal("ANTHROPIC_API_KEY" in env, false);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, NO_KEY_TOKEN);
  });

  it("refuses a missing model", () => {
    refuses(
      () => jobEnv({ setup: "anthropicApi", baseUrl: "https://x", key: null, model: null }, base),
      /Type a model first/,
    );
  });
});

describe("selection and launch problems", () => {
  /** @param {Partial<import("../../src/agents/setupsJob.js").ApiSetup>} patch */
  const setup = (patch) => ({
    option: /** @type {const} */ ("opencodeGo"),
    key: "k",
    baseUrl: GO_BASE_URL,
    model: "glm-5.3",
    offered: null,
    ...patch,
  });

  it("selectionProblem asks for what is missing", () => {
    assert.equal(selectionProblem(setup({})), null);
    assert.equal(selectionProblem(setup({ key: null })), "Save an API key first.");
    assert.equal(
      selectionProblem(setup({ key: null, model: null })),
      "Save an API key and choose a model first.",
    );
    assert.equal(selectionProblem(setup({ model: null })), "Choose a model first.");
  });

  it("the two compatible APIs need no key", () => {
    const keyless = setup({ option: "anthropicApi", key: null });
    assert.equal(selectionProblem(keyless), null);
    assert.equal(problemWith(keyless, "m"), null);
    assert.equal(selectionProblem({ ...keyless, model: null }), "Type a model first.");
  });

  it("problemWith names the service and a model the list no longer has", () => {
    assert.equal(problemWith(setup({ key: null }), "m"), "No API key is saved for OpenCode Go.");
    assert.equal(problemWith(setup({}), " "), "No model is chosen for OpenCode Go.");
    assert.equal(
      problemWith(setup({ offered: ["a"] }), "glm-5.3"),
      "OpenCode Go no longer offers the model glm-5.3.",
    );
    assert.equal(problemWith(setup({ offered: ["glm-5.3"] }), "glm-5.3"), null);
    assert.equal(problemWith(setup({ offered: null }), "anything"), null);
  });
});

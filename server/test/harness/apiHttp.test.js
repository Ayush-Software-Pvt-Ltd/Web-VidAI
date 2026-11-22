// The requests VidAI makes to a service, against a local stand-in provider (docs/SPEC.md section 5, "Harness,
// program and model").

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { createApiHttp, transportFailure } from "../../src/agents/apiHttp.js";
import { failureText, parseError } from "../../src/agents/apiHttpFailure.js";
import { parseModelsPage, parseOpenaiModels } from "../../src/agents/apiHttpModels.js";
import { startProvider } from "./fakeProvider.js";

const KEY = "sk-test-secret-1234";
const http = createApiHttp({ version: "9.9.9" });

/** @type {(() => Promise<void>)[]} */
const closers = [];
after(async () => {
  for (const close of closers) await close();
});

/** @param {Parameters<typeof startProvider>[0]} handler */
async function provider(handler) {
  const p = await startProvider(handler);
  closers.push(p.close);
  return p;
}

describe("model lists", () => {
  it("follows the pages of the Anthropic form with the bearer key", async () => {
    const p = await provider(({ url }) =>
      url.includes("after_id=glm-5.3")
        ? {
            status: 200,
            body: JSON.stringify({
              data: [{ id: "kimi-k2", display_name: "Kimi K2" }],
              has_more: false,
            }),
          }
        : {
            status: 200,
            body: JSON.stringify({
              data: [{ type: "model", id: "glm-5.3", display_name: "GLM-5.3" }],
              has_more: true,
              last_id: "glm-5.3",
            }),
          },
    );
    const models = await http.fetchModels("opencodeGo", p.url, KEY);
    assert.deepEqual(models, [
      { id: "glm-5.3", displayName: "GLM-5.3" },
      { id: "kimi-k2", displayName: "Kimi K2" },
    ]);
    assert.equal(p.seen.length, 2);
    assert.equal(p.seen[0].method, "GET");
    assert.match(p.seen[0].url, /^\/v1\/models\?limit=1000$/);
    assert.match(p.seen[1].url, /after_id=glm-5\.3/);
    assert.equal(p.seen[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(p.seen[0].headers["user-agent"], "VidAI/9.9.9");
  });

  it("asks for the public list without a key and sends no credentials", async () => {
    const p = await provider(() => ({
      status: 200,
      body: JSON.stringify({ data: [{ id: "a" }] }),
    }));
    assert.deepEqual(await http.fetchModels("opencodeGo", p.url, null), [
      { id: "a", displayName: "a" },
    ]);
    assert.equal(p.seen[0].headers.authorization, undefined);
    assert.equal(p.seen[0].headers["x-api-key"], undefined);
  });

  it("sends x-api-key for the Anthropic API and no authorization header", async () => {
    const p = await provider(() => ({ status: 200, body: JSON.stringify({ data: [] }) }));
    await http.fetchModels("anthropicApi", p.url, KEY);
    assert.equal(p.seen[0].headers["x-api-key"], KEY);
    assert.equal(p.seen[0].headers.authorization, undefined);
    assert.equal(p.seen[0].headers["anthropic-version"], "2023-06-01");
  });

  it("reads the OpenAI form from /models in one request and removes duplicates", async () => {
    const p = await provider(() => ({
      status: 200,
      body: JSON.stringify({
        object: "list",
        data: [{ id: "gpt-x", owned_by: "me" }, { id: "gpt-x" }, { id: "gpt-y" }],
      }),
    }));
    const models = await http.fetchModels("openaiApi", `${p.url}/v1`, KEY);
    assert.deepEqual(
      models.map((m) => m.id),
      ["gpt-x", "gpt-y"],
    );
    assert.equal(p.seen.length, 1);
    assert.equal(p.seen[0].url, "/v1/models");
    assert.equal(p.seen[0].headers.authorization, `Bearer ${KEY}`);
  });

  it("reads the answer of a local server such as Ollama", async () => {
    const p = await provider(() => ({
      status: 200,
      body: JSON.stringify({
        object: "list",
        data: [{ id: "llama3:8b", object: "model", created: 1, owned_by: "library" }],
      }),
    }));
    assert.deepEqual(await http.fetchModels("openaiApi", `${p.url}/v1`, null), [
      { id: "llama3:8b", displayName: "llama3:8b" },
    ]);
  });

  it("explains a refused key without ever repeating it", async () => {
    const p = await provider(() => ({
      status: 401,
      body: JSON.stringify({
        type: "error",
        error: { type: "AuthError", message: `Bad key ${KEY}` },
      }),
    }));
    await assert.rejects(http.fetchModels("anthropicApi", p.url, KEY), (error) => {
      const message = /** @type {Error} */ (error).message;
      assert.match(message, /did not accept the API key/);
      assert.equal(message.includes(KEY), false);
      return true;
    });
  });

  it("asks for a key when none was sent and the service wants one", async () => {
    const p = await provider(() => ({ status: 401 }));
    await assert.rejects(
      http.fetchModels("openaiApi", p.url, null),
      /The service wants an API key/,
    );
  });

  it("says plainly when the answer is not a model list", async () => {
    const wrongShape = await provider(() => ({ status: 200, body: JSON.stringify({ hello: 1 }) }));
    await assert.rejects(
      http.fetchModels("opencodeGo", wrongShape.url, null),
      /not with a model list/,
    );
    const html = await provider(() => ({
      status: 200,
      body: "<html></html>",
      headers: { "content-type": "text/html" },
    }));
    await assert.rejects(http.fetchModels("openaiApi", html.url, null), /not with a model list/);
  });

  it("does not follow a redirect", async () => {
    const target = await provider(() => ({ status: 200, body: "{}" }));
    const p = await provider(() => ({ status: 302, headers: { location: `${target.url}/steal` } }));
    await assert.rejects(http.fetchModels("opencodeGo", p.url, KEY), /redirect/);
    assert.equal(target.seen.length, 0);
  });

  it("stops a gateway that repeats its last page", async () => {
    const p = await provider(() => ({
      status: 200,
      body: JSON.stringify({
        data: [{ id: "a", display_name: "A" }],
        has_more: true,
        last_id: "a",
      }),
    }));
    assert.equal((await http.fetchModels("opencodeGo", p.url, null)).length, 1);
    assert.equal(p.seen.length, 2);
  });
});

describe("the Test request", () => {
  it("sends one tiny message request on the Anthropic protocol", async () => {
    const p = await provider(() => ({
      status: 200,
      body: JSON.stringify({ type: "message", content: [] }),
    }));
    const result = await http.testApi("opencodeGo", p.url, KEY, "glm-5.3", "GLM-5.3");
    assert.deepEqual(result, { ok: true, message: "OpenCode Go answered with GLM-5.3." });
    const [seen] = p.seen;
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/v1/messages");
    assert.equal(seen.headers.authorization, `Bearer ${KEY}`);
    assert.equal(seen.headers["anthropic-version"], "2023-06-01");
    const body = JSON.parse(seen.body);
    assert.equal(body.model, "glm-5.3");
    assert.equal(body.max_tokens, 1);
  });

  it("uses chat completions on the OpenAI protocol", async () => {
    const p = await provider(() => ({ status: 200, body: JSON.stringify({ choices: [{}] }) }));
    const result = await http.testApi("openaiApi", `${p.url}/v1`, null, "local", "local");
    assert.deepEqual(result, { ok: true, message: "OpenAI Compatible API answered with local." });
    assert.equal(p.seen[0].url, "/v1/chat/completions");
    assert.equal(p.seen[0].headers.authorization, undefined);
  });

  it("explains a model the plan does not allow", async () => {
    const p = await provider(() => ({
      status: 403,
      body: JSON.stringify({ type: "error", error: { type: "permission_error", message: "no" } }),
    }));
    const result = await http.testApi("anthropicApi", p.url, KEY, "forbidden", "forbidden");
    assert.equal(result.ok, false);
    assert.match(result.message, /does not allow the model forbidden/);
    assert.equal(result.message.includes(KEY), false);
  });

  it("explains the 5-hour limit of an OpenCode Go plan", async () => {
    const limit = (/** @type {string} */ name) =>
      JSON.stringify({
        type: "error",
        error: { type: "GoUsageLimitError", message: "Go usage limit exceeded" },
        metadata: { workspace: "wrk_1", limitName: name },
      });
    const p = await provider(() => ({ status: 429, body: limit("5 hour") }));
    const result = await http.testApi("opencodeGo", p.url, KEY, "limited", "limited");
    assert.equal(result.ok, false);
    assert.match(result.message, /^The 5-hour limit of your OpenCode Go plan/);
    assert.match(failureText(429, limit("weekly")), /^The weekly limit/);
    assert.match(failureText(429, limit("monthly")), /^The monthly limit/);
    assert.match(failureText(429, limit("odd")), /^A limit of your OpenCode Go plan/);
  });

  it("says so when the service cannot be reached", async () => {
    const p = await provider(() => ({ status: 200 }));
    const dead = p.url;
    await p.close();
    const result = await http.testApi("anthropicApi", dead, KEY, "m", "m");
    assert.equal(result.ok, false);
    assert.match(result.message, /Could not reach the service/);
  });

  it("says so when the service is too slow", async () => {
    const p = await provider(() => new Promise(() => {}));
    const slow = createApiHttp({ version: "1", timings: { testMs: 30 } });
    const result = await slow.testApi("anthropicApi", p.url, KEY, "m", "m");
    assert.match(result.message, /did not answer in time/);
  });

  it("says when the answer is not as expected", async () => {
    const p = await provider(() => ({ status: 200, body: "{}" }));
    const result = await http.testApi("anthropicApi", p.url, KEY, "m", "m");
    assert.deepEqual(result, {
      ok: false,
      message: "The service answered, but not as expected. Check the address.",
    });
  });
});

describe("the quota request", () => {
  it("carries the key as a bearer token", async () => {
    const p = await provider(() => ({ status: 200, body: "{}" }));
    const answer = await http.getWithKey(`${p.url}/inference/go/v1/usage`, KEY);
    assert.equal(answer.status, 200);
    assert.equal(p.seen[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(p.seen[0].url, "/inference/go/v1/usage");
  });
});

describe("failure texts", () => {
  it("name the model or the key and nothing else", () => {
    assert.match(failureText(401, ""), /^OpenCode did not accept the API key/);
    assert.match(
      failureText(404, "", "x", { service: "generic" }),
      /^The service does not offer the model x at this address/,
    );
    assert.match(failureText(429, ""), /limiting requests/);
    assert.match(failureText(503, ""), /\(error 503\)/);
    assert.match(failureText(418, ""), /HTTP 418/);
    assert.match(failureText(402, ""), /balance is used up/);
    assert.match(failureText(null, ""), /reported an error/);
  });

  it("read the error of Claude Code text with JSON after other words", () => {
    const parsed = parseError(
      'API Error: 429 {"type":"error","error":{"type":"GoUsageLimitError","message":"x"}}',
    );
    assert.equal(parsed.kind, "GoUsageLimitError");
    assert.match(
      failureText(
        null,
        'API Error: 429 {"type":"error","error":{"type":"GoUsageLimitError","message":"x"}}',
      ),
      /limit of your OpenCode Go plan/,
    );
  });

  it("point a user to the admin instead of the settings", () => {
    const admin = failureText(404, "", "m", { audience: "admin" });
    const user = failureText(404, "", "m", { audience: "user" });
    assert.notEqual(admin, user);
    assert.match(user, /admin/i);
  });

  it("describe a failed connection", () => {
    assert.match(
      transportFailure(Object.assign(new Error("x"), { name: "TimeoutError" }), "generic"),
      /did not answer in time/,
    );
    assert.match(
      transportFailure(
        new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
        "opencode",
      ),
      /Could not reach OpenCode/,
    );
    assert.match(transportFailure(new Error("odd"), "generic"), /connection to the service failed/);
  });
});

describe("parsing", () => {
  it("reads a models page and ignores items without an id", () => {
    const page = parseModelsPage(
      JSON.stringify({
        data: [{ id: "a", display_name: "A" }, { x: 1 }, { id: "b" }],
        has_more: true,
        last_id: "b",
      }),
    );
    assert.deepEqual(page, {
      models: [
        { id: "a", displayName: "A" },
        { id: "b", displayName: "b" },
      ],
      next: "b",
    });
    assert.equal(parseModelsPage("nope"), null);
    assert.equal(parseModelsPage("{}"), null);
    assert.equal(parseOpenaiModels("{}"), null);
  });
});

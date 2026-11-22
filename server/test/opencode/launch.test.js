// What a job's OpenCode server is started with (the command line, the environment and the
// configuration), and the folder of the job's own files, and the
// guarantee that a key is only ever in the environment of the server.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FIXED_VARS,
  REMOVED_VARS,
  applyTestLogin,
  buildLaunch,
  customModel,
  isolateUserConfig,
  keyVar,
  listeningUrl,
  modelJson,
  modelRef,
  modelText,
  removeJobFiles,
  route,
  routedModel,
  runConfig,
  serverArgs,
  serverEnv,
  sessionPermissions,
  testLoginRequested,
  variantForEffort,
  withoutKey,
} from "../../src/agents/opencode/launch.js";
import { GO_BASE_URL, OPENAI_BASE_URL, PAY_AS_YOU_GO_BASE_URL } from "../../src/agents/setups.js";

/** @returns {string} */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vidai-launch-"));
}

test("addresses map to providers", () => {
  assert.equal(modelText(routedModel(route("opencodeGo", null), "glm-5.3")), "opencode-go/glm-5.3");
  assert.equal(
    modelText(routedModel(route("opencodeGo", PAY_AS_YOU_GO_BASE_URL), "big-pickle")),
    "opencode/big-pickle",
  );
  assert.equal(
    modelText(routedModel(route("opencodeGo", "https://gateway.example/anthropic"), "m1")),
    "vidai/m1",
  );
  // The OpenAI compatible option never uses OpenCode's own providers, whatever its address.
  for (const address of [
    null,
    GO_BASE_URL,
    PAY_AS_YOU_GO_BASE_URL,
    OPENAI_BASE_URL,
    "https://api.openai.com/v1",
  ]) {
    assert.equal(modelText(routedModel(route("openaiApi", address), "gpt-5")), "vidai/gpt-5");
  }
  assert.deepEqual(modelJson(modelRef("opencode-go", "glm-5.3"), null), {
    id: "glm-5.3",
    providerID: "opencode-go",
  });
  assert.deepEqual(modelJson(customModel("m"), "high"), {
    id: "m",
    providerID: "vidai",
    variant: "high",
  });
});

test("the run configuration of opencodeGo", () => {
  const config = runConfig({
    option: "opencodeGo",
    baseUrl: null,
    modelId: "glm-5.3",
    editingFolder: "/Users/editor/Editing",
    home: "/Users/editor",
    platform: "darwin",
  });
  assert.deepEqual(config, {
    $schema: "https://opencode.ai/config.json",
    formatter: false,
    instructions: ["/Users/editor/Editing/CLAUDE.md", "/Users/editor/.claude/CLAUDE.md"],
    lsp: false,
    providers: {
      vidai: {
        models: { "glm-5.3": { name: "glm-5.3" } },
        name: "OpenCode (VidAI)",
        package: "@ai-sdk/anthropic",
        settings: {
          apiKey: "{env:OPENCODE_API_KEY}",
          baseURL: "https://opencode.ai/inference/go/anthropic/v1",
        },
      },
    },
    share: "disabled",
    snapshots: false,
  });
  const custom = runConfig({
    option: "opencodeGo",
    baseUrl: "http://localhost:8080",
    modelId: "m1",
    editingFolder: "/E",
    home: null,
    platform: "darwin",
  });
  assert.deepEqual(custom["instructions"], ["/E/CLAUDE.md"]);
  assert.deepEqual(custom["providers"], {
    vidai: {
      .../** @type {any} */ (custom)["providers"].vidai,
      settings: { baseURL: "http://localhost:8080/v1", apiKey: "{env:OPENCODE_API_KEY}" },
    },
  });
  const pay = runConfig({
    option: "opencodeGo",
    baseUrl: PAY_AS_YOU_GO_BASE_URL,
    modelId: "m1",
    editingFolder: "/E",
    home: null,
    platform: "darwin",
  });
  assert.equal(
    /** @type {any} */ (pay)["providers"].vidai.settings.baseURL,
    "https://opencode.ai/inference/anthropic/v1",
  );
  withoutKey(pay);
  assert.deepEqual(/** @type {any} */ (pay)["providers"].vidai.settings, {
    baseURL: "https://opencode.ai/inference/anthropic/v1",
  });
});

test("the run configuration of openaiApi", () => {
  const config = runConfig({
    option: "openaiApi",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-5",
    editingFolder: "/Users/editor/Editing",
    home: "/Users/editor",
    platform: "darwin",
  });
  assert.deepEqual(/** @type {any} */ (config)["providers"], {
    vidai: {
      models: { "gpt-5": { name: "gpt-5" } },
      name: "OpenAI Compatible API (VidAI)",
      package: "@ai-sdk/openai-compatible",
      settings: { apiKey: "{env:VIDAI_API_KEY}", baseURL: "https://api.openai.com/v1" },
    },
  });
  // The default address is used as given, with its /v1, and no key value is in the text.
  const byDefault = runConfig({
    option: "openaiApi",
    baseUrl: null,
    modelId: "m1",
    editingFolder: "/E",
    home: null,
    platform: "darwin",
  });
  assert.deepEqual(/** @type {any} */ (byDefault)["providers"].vidai.settings, {
    baseURL: "https://opencode.ai/inference/go/v1",
    apiKey: "{env:VIDAI_API_KEY}",
  });
  const local = runConfig({
    option: "openaiApi",
    baseUrl: "http://localhost:11434/v1",
    modelId: "llama",
    editingFolder: "/E",
    home: null,
    platform: "darwin",
  });
  assert.equal(
    /** @type {any} */ (local)["providers"].vidai.settings.baseURL,
    "http://localhost:11434/v1",
  );
});

test("the instructions use the separators of the system", () => {
  const config = runConfig({
    option: "opencodeGo",
    baseUrl: null,
    modelId: "m",
    editingFolder: "C:\\Edits",
    home: "C:\\Users\\editor",
    platform: "win32",
  });
  assert.deepEqual(config["instructions"], [
    "C:\\Edits\\CLAUDE.md",
    "C:\\Users\\editor\\.claude\\CLAUDE.md",
  ]);
});

test("each option has its own key variable", () => {
  assert.equal(keyVar("opencodeGo"), "OPENCODE_API_KEY");
  assert.equal(keyVar("openaiApi"), "VIDAI_API_KEY");
});

test("the test login is only ever asked for in a test run, for opencodeGo", () => {
  assert.equal(
    testLoginRequested("opencodeGo", { NODE_ENV: "test", VIDAI_E2E_OPENCODE_LOGIN: "own" }),
    true,
  );
  assert.equal(
    testLoginRequested("opencodeGo", { NODE_ENV: "test", VIDAI_E2E_OPENCODE_LOGIN: "public" }),
    true,
  );
  assert.equal(
    testLoginRequested("opencodeGo", { NODE_ENV: "production", VIDAI_E2E_OPENCODE_LOGIN: "own" }),
    false,
  );
  assert.equal(testLoginRequested("opencodeGo", { VIDAI_E2E_OPENCODE_LOGIN: "own" }), false);
  assert.equal(
    testLoginRequested("openaiApi", { NODE_ENV: "test", VIDAI_E2E_OPENCODE_LOGIN: "own" }),
    false,
  );
  assert.equal(
    testLoginRequested("opencodeGo", { NODE_ENV: "test", VIDAI_E2E_OPENCODE_LOGIN: "other" }),
    false,
  );
});

test("the session allows everything and asks nothing", () => {
  assert.deepEqual(sessionPermissions(), [
    { action: "*", resource: "*", effect: "allow" },
    { action: "question", resource: "*", effect: "deny" },
  ]);
});

test("the server environment", () => {
  const base = {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/editor",
    OPENCODE_PASSWORD: "theirs",
    OPENCODE_SERVER_PASSWORD: "theirs",
    OPENCODE_API_KEY: "their-own-key",
    OPENCODE_FLAGS: "all",
    MY_TOOL_TOKEN: "tok",
    UNSET: undefined,
  };
  const env = serverEnv({
    option: "opencodeGo",
    base,
    key: "oc_sk_job",
    password: "pw",
    config: { share: "disabled" },
    platform: "darwin",
  });
  assert.deepEqual(env, {
    HOME: "/Users/editor",
    MY_TOOL_TOKEN: "tok",
    OPENCODE_API_KEY: "oc_sk_job",
    OPENCODE_CONFIG_CONTENT: '{"share":"disabled"}',
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_SERVER_PASSWORD: "pw",
    PATH: "/usr/bin:/bin",
  });
  applyTestLogin(env);
  assert.equal("OPENCODE_API_KEY" in env, false);
});

test("a Windows environment loses the variables whatever their letter case", () => {
  const env = serverEnv({
    option: "opencodeGo",
    base: { Path: "C:\\bin", opencode_config: "x", Opencode_Api_Key: "theirs" },
    key: null,
    password: "pw",
    config: {},
    platform: "win32",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_DISABLE_AUTOUPDATE",
    "OPENCODE_SERVER_PASSWORD",
    "Path",
  ]);
});

test("the openai server environment carries the key in VidAI's variable", () => {
  const env = serverEnv({
    option: "openaiApi",
    base: { PATH: "/usr/bin", OPENCODE_API_KEY: "their-own", VIDAI_API_KEY: "their-other" },
    key: "sk-job",
    password: "pw",
    config: { share: "disabled" },
    platform: "darwin",
  });
  assert.deepEqual(env, {
    OPENCODE_CONFIG_CONTENT: '{"share":"disabled"}',
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_SERVER_PASSWORD: "pw",
    PATH: "/usr/bin",
    VIDAI_API_KEY: "sk-job",
  });
});

test("a server without a key has none of the user's own and no apiKey setting", () => {
  const config = runConfig({
    option: "openaiApi",
    baseUrl: "http://localhost:1234/v1",
    modelId: "local-model",
    editingFolder: "/Users/editor/Editing",
    home: null,
    platform: "darwin",
  });
  withoutKey(config);
  assert.equal("apiKey" in /** @type {any} */ (config)["providers"].vidai.settings, false);
  const env = serverEnv({
    option: "openaiApi",
    base: { PATH: "/usr/bin", OPENCODE_API_KEY: "their-own", VIDAI_API_KEY: "their-other" },
    key: null,
    password: "pw",
    config,
    platform: "darwin",
  });
  assert.equal("VIDAI_API_KEY" in env, false);
  assert.equal("OPENCODE_API_KEY" in env, false);
});

test("the command line", () => {
  assert.equal(serverArgs().join(" "), "serve --stdio --hostname 127.0.0.1 --port 0");
});

test("the listening line", () => {
  assert.equal(listeningUrl('{"url":"http://127.0.0.1:59642"}'), "http://127.0.0.1:59642");
  assert.equal(listeningUrl('{"url":"http://127.0.0.1:59642/"}'), "http://127.0.0.1:59642");
  assert.equal(
    listeningUrl("server listening on http://127.0.0.1:47123"),
    "http://127.0.0.1:47123",
  );
  assert.equal(listeningUrl("Warning: something"), null);
  assert.equal(listeningUrl('{"url":"https://elsewhere"}'), null);
  assert.equal(listeningUrl("server listening on http://"), null);
});

test("an effort is a variant only when the model offers it, else the log says why", () => {
  const model = customModel("glm-5.3");
  assert.deepEqual(variantForEffort(model, "high", ["low", "high"]), {
    variant: "high",
    note: null,
  });
  assert.deepEqual(variantForEffort(model, "xhigh", ["low", "high"]), {
    variant: null,
    note: "glm-5.3 does not offer the reasoning effort xhigh (it offers low, high), so it runs on its default.",
  });
  assert.deepEqual(variantForEffort(model, "high", []), {
    variant: null,
    note: "glm-5.3 has no reasoning effort levels, so the effort high is not used.",
  });
  assert.deepEqual(variantForEffort(model, "high", null), {
    variant: null,
    note: "The reasoning levels of glm-5.3 could not be read, so the effort high is not used.",
  });
});

test("the removed variables include every way to change the server or the key", () => {
  for (const name of [
    "OPENCODE_PASSWORD",
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_API_KEY",
    "VIDAI_API_KEY",
    "ANTHROPIC_BASE_URL",
  ]) {
    assert.ok(REMOVED_VARS.includes(name), name);
  }
  assert.deepEqual(FIXED_VARS, [["OPENCODE_DISABLE_AUTOUPDATE", "1"]]);
});

test("the user's configuration is replaced by a private folder in the job's folder", () => {
  const jobDir = path.join(tempDir(), "job");
  try {
    /** @type {Record<string, string>} */
    const env = { OPENCODE_CONFIG: "stays-until-removed" };
    assert.equal(isolateUserConfig(env, jobDir), true);
    assert.equal(env["OPENCODE_CONFIG_PROJECT_DISABLE"], "1");
    assert.equal(env["OPENCODE_CONFIG_DIR"], path.join(jobDir, "opencode2-config"));
    assert.deepEqual(fs.readdirSync(env["OPENCODE_CONFIG_DIR"] ?? ""), []);
    removeJobFiles(jobDir);
    assert.equal(fs.existsSync(jobDir), false, "the job's folder is removed when it is empty");
  } finally {
    fs.rmSync(path.dirname(jobDir), { recursive: true, force: true });
  }
});

test("removing the job's files keeps what else the caller put in the job's folder", () => {
  const root = tempDir();
  const jobDir = path.join(root, "job");
  try {
    fs.mkdirSync(path.join(jobDir, "opencode2-config"), { recursive: true });
    fs.writeFileSync(path.join(jobDir, "opencode2-config", "x.json"), "{}");
    fs.writeFileSync(path.join(jobDir, "keep.txt"), "mine");
    removeJobFiles(jobDir);
    assert.equal(fs.existsSync(path.join(jobDir, "opencode2-config")), false);
    assert.equal(fs.readFileSync(path.join(jobDir, "keep.txt"), "utf8"), "mine");
    removeJobFiles(path.join(root, "never-made"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildLaunch puts the key only in the environment, never in the configuration", () => {
  const root = tempDir();
  try {
    const launch = buildLaunch({
      program: "/bin/opencode2",
      editingFolder: "/Users/editor/Editing",
      baseEnv: { PATH: "/usr/bin", HOME: "/Users/editor" },
      option: "opencodeGo",
      key: "  oc_sk_secret_value  ",
      baseUrl: null,
      modelId: "glm-5.3",
      effort: "high",
      jobDir: path.join(root, "job"),
      platform: "darwin",
    });
    const { command } = launch;
    assert.equal(command.program, "/bin/opencode2");
    assert.equal(command.cwd, "/Users/editor/Editing");
    assert.deepEqual(command.args, serverArgs());
    assert.equal(command.env["OPENCODE_API_KEY"], "oc_sk_secret_value");
    assert.equal(command.env["OPENCODE_SERVER_PASSWORD"], launch.password);
    assert.match(launch.password, /^[0-9a-f]{32}$/);
    assert.ok(!(command.env["OPENCODE_CONFIG_CONTENT"] ?? "").includes("oc_sk_secret_value"));
    assert.ok(!command.args.join(" ").includes("oc_sk_secret_value"));
    assert.ok(!command.args.join(" ").includes(launch.password));
    assert.equal(command.env["OPENCODE_CONFIG_PROJECT_DISABLE"], "1");
    assert.equal(command.env["OPENCODE_CONFIG_DIR"], path.join(root, "job", "opencode2-config"));
    assert.equal(modelText(launch.model), "opencode-go/glm-5.3");
    assert.equal(launch.effort, "high");
    // A new password for every server.
    assert.notEqual(
      buildLaunch({
        program: "/bin/opencode2",
        editingFolder: "/E",
        baseEnv: {},
        option: "opencodeGo",
        key: "k",
        baseUrl: null,
        modelId: "m",
        effort: null,
        jobDir: path.join(root, "job2"),
        platform: "darwin",
      }).password,
      launch.password,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildLaunch with a test login or without a key sends no key at all", () => {
  const root = tempDir();
  try {
    const base = {
      program: "/bin/opencode2",
      editingFolder: "/E",
      baseEnv: { OPENCODE_API_KEY: "theirs", ANTHROPIC_API_KEY: "theirs-too" },
      baseUrl: null,
      modelId: "m",
      effort: null,
      platform: /** @type {const} */ ("darwin"),
    };
    const test1 = buildLaunch({
      ...base,
      option: "opencodeGo",
      key: "oc_sk",
      testLogin: true,
      jobDir: path.join(root, "a"),
    });
    assert.equal(test1.testLogin, true);
    assert.equal("OPENCODE_API_KEY" in test1.command.env, false);
    assert.equal("ANTHROPIC_API_KEY" in test1.command.env, false);
    assert.equal("apiKey" in /** @type {any} */ (test1.config)["providers"].vidai.settings, false);
    // openaiApi ignores the test login.
    const openai = buildLaunch({
      ...base,
      option: "openaiApi",
      key: "sk",
      testLogin: true,
      jobDir: path.join(root, "b"),
    });
    assert.equal(openai.testLogin, false);
    assert.equal(openai.command.env["VIDAI_API_KEY"], "sk");
    // No key (empty or blank counts as none).
    const none = buildLaunch({
      ...base,
      option: "openaiApi",
      key: "  ",
      jobDir: path.join(root, "c"),
    });
    assert.equal("VIDAI_API_KEY" in none.command.env, false);
    assert.equal("apiKey" in /** @type {any} */ (none.config)["providers"].vidai.settings, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

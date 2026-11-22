import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  defaultModelOf,
  emptyInfo,
  fetchInfo,
  normalizeSelection,
  parseInfo,
  sameModels,
} from "../../src/agents/claude/info.js";
import { control } from "../support/claudeControl.js";

/** @param {string} value @param {string[]} effortLevels */
const model = (value, effortLevels) => ({
  value,
  displayName: value,
  description: "",
  effortLevels,
});

/** @param {ReturnType<typeof model>[]} models @param {string | null} defaultModel */
const info = (models, defaultModel) => ({ ...emptyInfo(), models, defaultModel, fetchedAt: 1 });

describe("parseInfo", () => {
  test("reads the recorded initialize and get_settings answers", () => {
    const result = parseInfo(control("initialize.json"), control("get_settings.json"), 123);
    assert.deepEqual(
      result.models.map((m) => m.value),
      [
        "opus",
        "claude-fable-5-2",
        "sonnet",
        "haiku",
        "fable",
        "claude-haiku-4-5-20251001",
        "claude-opus-4-6",
      ],
    );
    assert.equal(result.defaultModel, "fable");
    assert.equal(result.defaultEffort, "high");
    assert.equal(result.subscriptionType, "Claude Team");
    assert.equal(result.version, "2.1.319");
    assert.equal(result.fetchedAt, 123);
    assert.ok(result.models.every((m) => m.displayName !== "" && Array.isArray(m.effortLevels)));
  });

  test("without get_settings the defaults are unknown", () => {
    for (const settings of [null, undefined]) {
      const result = parseInfo(control("initialize.json"), settings, 5);
      assert.equal(result.models.length, 7);
      assert.equal(result.defaultModel, null);
      assert.equal(result.defaultEffort, null);
    }
  });

  test("tolerates missing fields and drops entries without a value", () => {
    const result = parseInfo(
      { models: [{ value: "a" }, { displayName: "no value" }, { value: " " }, 4, null] },
      {},
      null,
    );
    assert.deepEqual(result.models, [
      { value: "a", displayName: "a", description: "", effortLevels: [] },
    ]);
    assert.equal(result.subscriptionType, null);
    assert.equal(result.version, null);
    assert.equal(result.defaultModel, null);
    assert.deepEqual(parseInfo("nonsense", null, null).models, []);
  });

  test("leaves Claude Code's own default entry out of the list", () => {
    const result = parseInfo({ models: [{ value: "default" }, { value: "opus" }] }, null, 1);
    assert.deepEqual(
      result.models.map((m) => m.value),
      ["opus"],
    );
  });

  test("a model without effort support has no levels", () => {
    const result = parseInfo(
      {
        models: [
          { value: "a", supportsEffort: false, supportedEffortLevels: ["low"] },
          { value: "b", supportedEffortLevels: ["low", " ", 3, "high"] },
        ],
      },
      null,
      1,
    );
    assert.deepEqual(result.models[0]?.effortLevels, []);
    assert.deepEqual(result.models[1]?.effortLevels, ["low", "high"]);
  });
});

describe("defaultModelOf", () => {
  const entries = [
    { value: "default", resolvedModel: "claude-x-1" },
    { value: "opus", resolvedModel: "claude-opus-1" },
    { value: "x", resolvedModel: "claude-x-1" },
    { value: "x-alias", resolvedModel: "claude-x-1" },
    { value: "claude-y-2", resolvedModel: "claude-y-2" },
  ];

  test("an entry whose value is the applied id wins", () => {
    assert.equal(defaultModelOf({ applied: { model: "claude-y-2" } }, entries), "claude-y-2");
  });

  test("the alias of the user's settings wins when it resolves to the applied id", () => {
    const settings = { applied: { model: "claude-x-1" }, effective: { model: "x-alias" } };
    assert.equal(defaultModelOf(settings, entries), "x-alias");
  });

  test("otherwise the first entry that resolves to it", () => {
    assert.equal(defaultModelOf({ applied: { model: "claude-x-1" } }, entries), "x");
    const wrongAlias = { applied: { model: "claude-x-1" }, effective: { model: "opus" } };
    assert.equal(defaultModelOf(wrongAlias, entries), "x");
  });

  test("an applied id that nothing lists is returned as is", () => {
    assert.equal(defaultModelOf({ applied: { model: "claude-z-9" } }, entries), "claude-z-9");
  });

  test("without applied.model the default entry says which model is used", () => {
    assert.equal(defaultModelOf({}, entries), "x");
    assert.equal(defaultModelOf({}, [{ value: "opus" }]), null);
  });
});

describe("fetchInfo", () => {
  /** @param {Record<string, unknown>} answers */
  const client = (answers) => ({
    /** @param {string} subtype */
    request: async (subtype) => {
      const answer = answers[subtype];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });

  test("combines both answers", async () => {
    const result = await fetchInfo(
      client({
        initialize: control("initialize.json"),
        get_settings: control("get_settings.json"),
      }),
      9,
    );
    assert.equal(result.defaultModel, "fable");
    assert.equal(result.fetchedAt, 9);
  });

  test("get_settings failing is not fatal", async () => {
    const result = await fetchInfo(
      client({ initialize: control("initialize.json"), get_settings: new Error("nope") }),
      9,
    );
    assert.equal(result.models.length, 7);
    assert.equal(result.defaultModel, null);
  });

  test("initialize failing is", async () => {
    await assert.rejects(fetchInfo(client({ initialize: new Error("down") }), 9), /down/);
  });
});

test("sameModels compares the list and the default only", () => {
  const a = info([model("a", ["low"])], "a");
  assert.equal(sameModels(a, { ...a, fetchedAt: 99, version: "9" }), true);
  assert.equal(sameModels(a, info([model("a", ["low", "high"])], "a")), false);
  assert.equal(sameModels(a, info([model("a", ["low"])], null)), false);
});

describe("normalizeSelection", () => {
  const list = info([model("fable", ["low", "high"]), model("haiku", [])], "fable");

  test("without a list the selection is kept, blanks become null", () => {
    assert.deepEqual(normalizeSelection({ model: "gone", effort: "max" }, null), {
      model: "gone",
      effort: "max",
    });
    assert.deepEqual(normalizeSelection({ model: " ", effort: "" }, emptyInfo()), {
      model: null,
      effort: null,
    });
  });

  test("a model that is not in the list falls back to the default", () => {
    assert.deepEqual(normalizeSelection({ model: "gone", effort: "high" }, list), {
      model: null,
      effort: "high",
    });
  });

  test("an effort the model does not support is reset", () => {
    assert.deepEqual(normalizeSelection({ model: "fable", effort: "max" }, list), {
      model: "fable",
      effort: null,
    });
    assert.deepEqual(normalizeSelection({ model: "haiku", effort: "low" }, list), {
      model: "haiku",
      effort: null,
    });
    assert.deepEqual(normalizeSelection({ model: "fable", effort: "low" }, list), {
      model: "fable",
      effort: "low",
    });
  });

  test("the default model is checked only when its name is known", () => {
    assert.deepEqual(normalizeSelection({ model: null, effort: "max" }, list), {
      model: null,
      effort: null,
    });
    assert.deepEqual(normalizeSelection({ model: null, effort: "max" }, info(list.models, null)), {
      model: null,
      effort: "max",
    });
  });
});

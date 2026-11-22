// The model list of the installed Claude Code changes under the admin's saved choice (SPEC section
// 6, "Harness"): the choice is checked again, fixed when it names something that is gone, and the
// pages are told (`settings-changed` for everybody, `system-changed` for admins).
import assert from "node:assert/strict";
import { test } from "node:test";
import { control, fakeClient } from "../support/claudeControl.js";
import { startWorld, until } from "./world.js";

/**
 * A world whose Claude Code helper answers from `state.initialize`, which a test can change.
 * @param {{ initialize: any }} state
 */
function claudeWorld(state) {
  return startWorld({
    engine: {
      claude: {
        startClient: () =>
          fakeClient({
            startedAt: Date.now(),
            answers: {
              initialize: () => state.initialize,
              get_settings: () => control("get_settings.json"),
              get_usage: () => control("get_usage.json"),
            },
          }),
      },
    },
  });
}

/** The initial answer without the models whose `value` is in `without`. @param {string[]} without */
function listWithout(without) {
  const full = control("initialize.json");
  return {
    ...full,
    models: full.models.filter((/** @type {any} */ m) => !without.includes(m.value)),
  };
}

/** @param {Awaited<ReturnType<typeof startWorld>>} w */
async function savedChoice(w) {
  const harness = (await w.admin.rpc("adminGetHarness")).json;
  return [harness.claude.model, harness.claude.effort];
}

test("a saved model that Claude Code no longer offers falls back to its default, and everybody is told", async () => {
  const state = { initialize: control("initialize.json") };
  const w = await claudeWorld(state);
  try {
    await w.api["claude"].refreshInfo();
    const saved = await w.admin.rpc("adminSetModelSelection", {
      model: "claude-fable-5-2",
      effort: "max",
    });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(await savedChoice(w), ["claude-fable-5-2", "max"]);
    const stream = await w.admin.openStream();

    state.initialize = listWithout(["claude-fable-5-2"]);
    await w.api["claude"].refreshInfo();
    await until(() => stream.messages().some((m) => m.event === "system-changed"), 10_000);

    // The effort is kept: Claude Code's default model supports it.
    assert.deepEqual(await savedChoice(w), [null, "max"]);
    const events = stream.messages().map((m) => m.event);
    assert.ok(events.includes("settings-changed"), events.join(","));
    const settings = stream.messages().find((m) => m.event === "settings-changed");
    // What users see of it: the model of the active setup, now Claude Code's default.
    assert.equal(settings?.payload.harness.model, null);
  } finally {
    await w.close();
  }
});

test("an effort the saved model does not support is dropped, the model stays", async () => {
  const state = { initialize: control("initialize.json") };
  const w = await claudeWorld(state);
  try {
    await w.api["claude"].refreshInfo();
    await w.admin.rpc("adminSetModelSelection", { model: "sonnet", effort: "max" });
    assert.deepEqual(await savedChoice(w), ["sonnet", "max"]);
    const stream = await w.admin.openStream();

    const next = control("initialize.json");
    for (const m of next.models) {
      if (m.value === "sonnet") m.supportedEffortLevels = ["low", "medium", "high"];
    }
    state.initialize = next;
    await w.api["claude"].refreshInfo();
    await until(() => stream.messages().some((m) => m.event === "system-changed"), 10_000);
    assert.deepEqual(await savedChoice(w), ["sonnet", null]);
  } finally {
    await w.close();
  }
});

test("a new list that still fits the saved choice changes and announces nothing", async () => {
  const state = { initialize: control("initialize.json") };
  const w = await claudeWorld(state);
  try {
    await w.api["claude"].refreshInfo();
    await w.admin.rpc("adminSetModelSelection", { model: "sonnet", effort: "high" });
    const stream = await w.admin.openStream();

    state.initialize = listWithout(["claude-fable-5-2"]);
    await w.api["claude"].refreshInfo();
    // The listener is not awaited by the refresh: give it the moment it needs.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await savedChoice(w), ["sonnet", "high"]);
    assert.deepEqual(
      stream.messages().filter((m) => m.event === "system-changed"),
      [],
    );
  } finally {
    await w.close();
  }
});

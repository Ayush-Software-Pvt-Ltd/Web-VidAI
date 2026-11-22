import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../../src/db/open.js";
import { createSettingsRepo } from "../../src/db/settings.js";
import { createSettings } from "../../src/settings.js";

function make() {
  const db = openDatabase(":memory:");
  const repo = createSettingsRepo(db);
  return { db, repo, settings: createSettings({ repo }) };
}

/** @param {() => unknown} fn @param {RegExp} [message] */
const throwsInvalid = (fn, message) =>
  assert.throws(fn, (e) => {
    const error = /** @type {{ code: string, message: string }} */ (e);
    return error.code === "invalidInput" && (!message || message.test(error.message));
  });

test("defaults are the ones of SPEC section 5", () => {
  const { settings } = make();
  assert.deepEqual(settings.getAll(), {
    setup: "claudeSubscription",
    maxEdits: 2,
    maxTimelineEdits: 2,
    maxRenders: 1,
    maxEditsPerUser: 0,
    startDelayMinutes: 0,
    maxModelRetries: 5,
    cpuPerEditPercent: 100,
    cpuTotalPercent: 100,
    gpuPerEditPercent: 100,
    gpuTotalPercent: 100,
    maxUploadGb: 200,
    proxyCacheGb: 50,
  });
});

test("an update changes only the given keys and returns everything", () => {
  const { settings } = make();
  const result = settings.update({ maxEdits: 4, setup: "opencodeGo" });
  assert.equal(result.maxEdits, 4);
  assert.equal(result.setup, "opencodeGo");
  assert.equal(result.maxRenders, 1);
  assert.deepEqual(settings.getAll(), result);
});

test("settings are stored one row per key and survive reopening", () => {
  const { db, settings } = make();
  settings.update({ maxEdits: 3, proxyCacheGb: 10 });
  assert.deepEqual(
    db.all("SELECT key FROM settings ORDER BY key").map((r) => r.key),
    ["maxEdits", "proxyCacheGb"],
  );
  assert.equal(createSettings({ repo: createSettingsRepo(db) }).getAll().maxEdits, 3);
});

test("every number is clamped into its range", () => {
  const { settings } = make();
  const low = settings.update({
    maxEdits: 0,
    maxTimelineEdits: -5,
    maxRenders: 0,
    maxEditsPerUser: -1,
    startDelayMinutes: -1,
    maxModelRetries: -1,
    maxUploadGb: 0,
    proxyCacheGb: 0,
  });
  assert.deepEqual(
    [low.maxEdits, low.maxTimelineEdits, low.maxRenders, low.maxEditsPerUser],
    [1, 1, 1, 0],
  );
  assert.deepEqual(
    [low.startDelayMinutes, low.maxModelRetries, low.maxUploadGb, low.proxyCacheGb],
    [0, 0, 1, 1],
  );
  const high = settings.update({
    maxEdits: 99,
    maxTimelineEdits: 99,
    maxRenders: 99,
    maxEditsPerUser: 99,
    startDelayMinutes: 999,
    maxModelRetries: 999,
    maxUploadGb: 99999,
    proxyCacheGb: 99999,
  });
  assert.deepEqual(
    [high.maxEdits, high.maxTimelineEdits, high.maxRenders, high.maxEditsPerUser],
    [8, 8, 4, 8],
  );
  assert.deepEqual(
    [high.startDelayMinutes, high.maxModelRetries, high.maxUploadGb, high.proxyCacheGb],
    [120, 50, 2000, 2000],
  );
});

test("fractions are rounded to whole numbers", () => {
  const { settings } = make();
  assert.equal(settings.update({ maxEdits: 2.6 }).maxEdits, 3);
});

test("percentages are rounded to the nearest step of 5 and kept within 5 to 100", () => {
  const { settings } = make();
  const cases = /** @type {[number, number][]} */ ([
    [12, 10],
    [13, 15],
    [7.5, 10],
    [2, 5],
    [0, 5],
    [-20, 5],
    [98, 100],
    [150, 100],
    [55, 55],
  ]);
  for (const [given, expected] of cases) {
    const all = settings.update({
      cpuPerEditPercent: given,
      cpuTotalPercent: given,
      gpuPerEditPercent: given,
      gpuTotalPercent: given,
    });
    assert.deepEqual(
      [all.cpuPerEditPercent, all.cpuTotalPercent, all.gpuPerEditPercent, all.gpuTotalPercent],
      [expected, expected, expected, expected],
      `given ${given}`,
    );
  }
});

test("types are strict: a numeric string, NaN, Infinity or null is refused", () => {
  const { settings } = make();
  for (const bad of ["3", NaN, Infinity, null, true, [], {}]) {
    throwsInvalid(() => settings.update({ maxEdits: bad }), /maxEdits.*number/);
    throwsInvalid(() => settings.update({ cpuTotalPercent: bad }), /cpuTotalPercent.*number/);
  }
});

test("unknown keys are refused and nothing from that update is written", () => {
  const { settings } = make();
  throwsInvalid(() => settings.update({ maxEdits: 5, bogus: 1 }), /bogus/);
  assert.equal(settings.getAll().maxEdits, 2);
  throwsInvalid(() => settings.update(JSON.parse('{"__proto__": 1}')), /__proto__/);
  throwsInvalid(() => settings.update({ toString: 1 }), /toString/);
});

test("a patch that is not an object is refused", () => {
  const { settings } = make();
  for (const bad of [null, undefined, "x", 3, []]) throwsInvalid(() => settings.update(bad));
});

test("setup must be one of the four setups", () => {
  const { settings } = make();
  for (const setup of ["claudeSubscription", "opencodeGo", "anthropicApi", "openaiApi"]) {
    assert.equal(settings.update({ setup }).setup, setup);
  }
  throwsInvalid(() => settings.update({ setup: "gemini" }), /setup/);
  throwsInvalid(() => settings.update({ setup: 1 }));
});

test("storageRoots is gone: it is refused as an unknown setting and never part of the settings", () => {
  const { settings } = make();
  throwsInvalid(() => settings.update({ storageRoots: ["/srv/media"] }), /storageRoots/);
  assert.ok(!("storageRoots" in settings.getAll()));
});

test("one bad value in an update stops the whole update", () => {
  const { settings } = make();
  throwsInvalid(() => settings.update({ maxEdits: 6, setup: "nope" }));
  assert.equal(settings.getAll().maxEdits, 2);
});

test("a stored value that no longer fits falls back to the default", () => {
  const { repo, settings } = make();
  repo.set("maxEdits", "lots");
  repo.set("cpuTotalPercent", 33);
  // A row of the removed storage folders setting is ignored, not an error.
  repo.set("storageRoots", ["/srv/media"]);
  repo.set("setup", "old-setup");
  const all = settings.getAll();
  assert.equal(all.maxEdits, 2);
  assert.equal(all.cpuTotalPercent, 35);
  assert.ok(!("storageRoots" in all));
  assert.equal(all.setup, "claudeSubscription");
});

test("publicView holds the setup and the limits the UI shows, nothing else", () => {
  const { settings } = make();
  settings.update({
    setup: "openaiApi",
    maxUploadGb: 20,
    maxEditsPerUser: 1,
    startDelayMinutes: 7,
    maxEdits: 5,
  });
  assert.deepEqual(settings.publicView(), {
    setup: "openaiApi",
    maxUploadGb: 20,
    maxEditsPerUser: 1,
    startDelayMinutes: 7,
  });
});

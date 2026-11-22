import assert from "node:assert/strict";
import { test } from "node:test";
import { decideSession, ensureLaunchable } from "../../src/jobs/managerSession.js";
import { notReady } from "../../src/errors.js";

/** @param {Set<string>} [broken] @param {string} [current] */
function harnessOf(broken = new Set(), current = "claudeSubscription") {
  return /** @type {any} */ ({
    launchFor(/** @type {string} */ setup = current) {
      const codes = setup === "opencodeGo";
      return {
        setup,
        program: codes ? "opencode2" : "claudeCode",
        option: null,
        model: codes ? "glm-5.3" : null,
        effort: null,
        baseUrl: null,
        key: null,
      };
    },
    async ensureReady({ setup = current } = {}) {
      if (broken.has(setup)) throw notReady("The key is missing.");
    },
  });
}

/** @param {Record<string, unknown>} [over] */
const jobOf = (over = {}) =>
  /** @type {any} */ ({
    kind: "reEdit",
    resume: false,
    setup: "opencodeGo",
    harness: "opencode2",
    model: "glm-5.3",
    effort: null,
    ...over,
  });
const row = (
  /** @type {string | null} */ sessionId,
  /** @type {string | null} */ sessionHarness,
) => ({
  sessionId,
  sessionHarness,
});

test("a session of the same program on a ready setup is resumed", async () => {
  const d = await decideSession({
    job: jobOf(),
    row: row("s1", "opencode2"),
    harness: harnessOf(),
  });
  assert.equal(d.sessionId, "s1");
  assert.equal(d.launch.setup, "opencodeGo");
  assert.equal(d.fallback, null);
});

test("a session of another program is not resumed, the recorded setup is kept", async () => {
  const d = await decideSession({
    job: jobOf(),
    row: row("s1", "claudeCode"),
    harness: harnessOf(),
  });
  assert.equal(d.sessionId, null);
  assert.equal(d.launch.setup, "opencodeGo");
  assert.equal(d.fallback, null);
});

test("a new edit never resumes, a Continue of an edit does", async () => {
  const edit = jobOf({ kind: "edit" });
  assert.equal(
    (await decideSession({ job: edit, row: row("s1", "opencode2"), harness: harnessOf() }))
      .sessionId,
    null,
  );
  assert.equal(
    (
      await decideSession({
        job: { ...edit, resume: true },
        row: row("s1", "opencode2"),
        harness: harnessOf(),
      })
    ).sessionId,
    "s1",
  );
});

test("a session that cannot go on moves to the current setup with a log sentence", async () => {
  const d = await decideSession({
    job: jobOf(),
    row: row("s1", "opencode2"),
    harness: harnessOf(new Set(["opencodeGo"])),
  });
  assert.equal(d.sessionId, null);
  assert.equal(d.launch.setup, "claudeSubscription");
  assert.equal(
    d.fallback,
    "This video's session ran on OpenCode Go (glm-5.3), which cannot continue it now " +
      "(The key is missing). A new session on Claude Code with Claude Subscription gets the full instructions.",
  );
});

test("a launch that starts a new session anyway fails with the reason when nothing is ready", async () => {
  await assert.rejects(
    decideSession({
      job: jobOf(),
      row: row(null, null),
      harness: harnessOf(new Set(["opencodeGo", "claudeSubscription"])),
    }),
    { code: "notReady" },
  );
  // Without a session the current setup is used when the recorded one is not ready.
  const d = await decideSession({
    job: jobOf(),
    row: row(null, null),
    harness: harnessOf(new Set(["opencodeGo"])),
  });
  assert.equal(d.launch.setup, "claudeSubscription");
  assert.equal(d.fallback, null);
});

test("Continue is refused only when neither the recorded nor the current setup is ready", async () => {
  await ensureLaunchable(jobOf(), harnessOf(new Set(["opencodeGo"])));
  await assert.rejects(
    ensureLaunchable(jobOf(), harnessOf(new Set(["opencodeGo", "claudeSubscription"]))),
    {
      code: "notReady",
    },
  );
});

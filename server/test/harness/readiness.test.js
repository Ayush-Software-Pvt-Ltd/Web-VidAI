// The readiness decision, over its whole domain and the shared table (docs/SPEC.md section 5, "Readiness").

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ALL_PROBLEMS,
  createReadiness,
  messageOf,
  problem,
  readyFacts,
} from "../../src/agents/readiness.js";
import { SETUPS } from "../../src/agents/harness.js";
import { programOf } from "../../src/agents/setups.js";

/** @typedef {import("../../../src/lib/wire/harness.ts").ReadinessFacts} Facts */

/** Every value of every fact: the whole domain of the decision. @returns {Facts[]} */
function everyFact() {
  /** @type {Facts[]} */
  const all = [];
  for (const setup of SETUPS)
    for (const keySaved of [false, true])
      for (const modelChosen of [false, true])
        for (const gitBashMissing of [false, true])
          for (const claude of /** @type {const} */ (["none", "loggedOut", "ready"]))
            for (const program of /** @type {const} */ (["none", "unsupported", "ready"]))
              for (const prepared of [false, true])
                all.push({
                  setup,
                  keySaved,
                  modelChosen,
                  gitBashMissing,
                  claude,
                  program,
                  prepared,
                });
  return all;
}

/** @param {string} setup */
const ofSetup = (setup) => everyFact().filter((f) => f.setup === setup);

describe("the decision", () => {
  it("covers every combination", () => {
    assert.equal(everyFact().length, 4 * 2 * 2 * 2 * 3 * 3 * 2);
  });

  it("everything in place is ready on every setup", () => {
    for (const setup of SETUPS) assert.equal(problem(readyFacts(setup)), null);
  });

  it("option 1 never asks for a key, a model or the OpenCode program", () => {
    const allowed = ["gitBashMissing", "claudeMissing", "claudeLoggedOut", "notPrepared", null];
    for (const f of ofSetup("claudeSubscription"))
      assert.ok(allowed.includes(problem(f)), JSON.stringify(f));
  });

  it("options 2 and 4 never ask for Claude Code, a login or Git", () => {
    const allowed = [
      "apiKeyMissing",
      "apiModelMissing",
      "programMissing",
      "programUnsupported",
      "notPrepared",
      null,
    ];
    for (const setup of ["opencodeGo", "openaiApi"]) {
      for (const f of ofSetup(setup)) assert.ok(allowed.includes(problem(f)), JSON.stringify(f));
    }
  });

  it("option 3 needs Claude Code and Git but never a login or the OpenCode program", () => {
    const allowed = ["apiModelMissing", "gitBashMissing", "claudeMissing", "notPrepared", null];
    for (const f of ofSetup("anthropicApi"))
      assert.ok(allowed.includes(problem(f)), JSON.stringify(f));
  });

  it("asks for the login on option 1 only", () => {
    for (const f of everyFact()) {
      if (problem(f) === "claudeLoggedOut") assert.equal(f.setup, "claudeSubscription");
    }
  });

  it("asks for the model first on an API option, and the key on OpenCode Go only", () => {
    for (const f of everyFact()) {
      if (problem(f) === "apiKeyMissing") assert.equal(f.setup, "opencodeGo");
    }
    const go = { ...readyFacts("opencodeGo"), keySaved: false, modelChosen: false };
    assert.equal(problem(go), "apiKeyMissing");
    assert.equal(problem({ ...go, keySaved: true }), "apiModelMissing");
    assert.equal(problem({ ...readyFacts("openaiApi"), keySaved: false }), null);
    assert.equal(
      problem({ ...readyFacts("anthropicApi"), keySaved: false, modelChosen: false }),
      "apiModelMissing",
    );
  });

  it("is not changed by facts the setup does not look at", () => {
    for (const f of everyFact()) {
      const same = problem(f);
      if (programOf(f.setup) === "claudeCode") {
        for (const program of /** @type {const} */ (["none", "unsupported", "ready"])) {
          assert.equal(problem({ ...f, program }), same);
        }
      } else {
        for (const claude of /** @type {const} */ (["none", "loggedOut", "ready"])) {
          assert.equal(problem({ ...f, claude, gitBashMissing: !f.gitBashMissing }), same);
        }
      }
      if (f.setup === "claudeSubscription") {
        assert.equal(problem({ ...f, keySaved: !f.keySaved, modelChosen: !f.modelChosen }), same);
      }
    }
  });

  it("a computer that is not prepared is the last thing asked", () => {
    for (const f of everyFact()) {
      if (f.prepared) continue;
      const withPrepared = problem({ ...f, prepared: true });
      assert.equal(problem(f), withPrepared ?? "notPrepared");
    }
  });

  it("every problem is reachable", () => {
    const seen = new Set(everyFact().map(problem));
    for (const found of ALL_PROBLEMS) assert.ok(seen.has(found), found);
  });
});

describe("the table of the SPEC", () => {
  /** @type {{ name: string, facts: Facts, program: string, problem: string | null }[]} */
  const rows = JSON.parse(
    readFileSync(new URL("../support/fixtures/readiness-table.json", import.meta.url), "utf8"),
  );

  it("holds on the server (the UI runs the same file)", () => {
    assert.ok(rows.length >= 50, String(rows.length));
    assert.equal(new Set(rows.map((r) => r.name)).size, rows.length, "row names are unique");
    const setups = new Set();
    const problems = new Set();
    for (const row of rows) {
      assert.equal(programOf(row.facts.setup), row.program, row.name);
      assert.equal(problem(row.facts), row.problem, row.name);
      setups.add(row.facts.setup);
      problems.add(row.problem);
    }
    assert.equal(setups.size, SETUPS.length);
    for (const found of ALL_PROBLEMS) assert.ok(problems.has(found), `no row for ${found}`);
  });
});

describe("the messages", () => {
  it("name the service and where an admin fixes it", () => {
    assert.equal(
      messageOf("opencodeGo", "apiKeyMissing"),
      "No API key is saved for OpenCode Go. Edits are set to run on it. Fix it in Admin, Harness and Model.",
    );
    assert.match(
      messageOf("openaiApi", "apiModelMissing"),
      /^No model is chosen for OpenAI Compatible API\./,
    );
    assert.match(
      messageOf("claudeSubscription", "claudeLoggedOut"),
      /Run claude once in a terminal/,
    );
    assert.match(messageOf("claudeSubscription", "gitBashMissing"), /git-scm\.com/);
  });

  it("send a user to an admin instead", () => {
    for (const found of ALL_PROBLEMS) {
      const text = messageOf("opencodeGo", found, { audience: "user" });
      assert.match(text, /Ask an admin/, found);
    }
  });

  it("tell what is wrong with the OpenCode 2 program", () => {
    const none = { found: false, supported: false, version: null };
    assert.match(
      messageOf("opencodeGo", "programMissing", { cli: none }),
      /^OpenCode 2 is not installed on the computer that runs VidAI\./,
    );
    const old = { found: true, supported: false, version: "1.4.0" };
    assert.match(
      messageOf("opencodeGo", "programUnsupported", { cli: old }),
      /OpenCode 1\.4\.0 is installed; VidAI needs OpenCode 2\.0 or later\./,
    );
    const silent = { found: true, supported: false, version: null };
    assert.match(
      messageOf("opencodeGo", "programUnsupported", { cli: silent }),
      /did not say which version/,
    );
    assert.match(messageOf("opencodeGo", "programMissing"), /cannot be used/);
  });

  it("every problem has a sentence on every setup", () => {
    for (const found of ALL_PROBLEMS)
      for (const setup of SETUPS) assert.ok(messageOf(setup, found).length > 10);
  });
});

describe("gathering the facts", () => {
  /** @param {{ claude?: boolean, loggedIn?: boolean, cli?: { found: boolean, supported: boolean, version: string | null }, git?: boolean, prepared?: boolean }} [o] */
  function probesOf({
    claude = true,
    loggedIn = true,
    cli = { found: true, supported: true, version: "2.2.6" },
    git = false,
    prepared = true,
  } = {}) {
    /** @type {string[]} */
    const asked = [];
    const readiness = createReadiness({
      probes: {
        locateClaude: async () => (asked.push("claude"), claude),
        claudeLoggedIn: async () => (asked.push("login"), loggedIn),
        locateOpencode: async () => (asked.push("opencode"), cli),
        gitBashMissing: async () => (asked.push("git"), git),
        toolkitPrepared: async () => (asked.push("toolkit"), prepared),
      },
    });
    return { readiness, asked };
  }
  const saved = { keySaved: true, modelChosen: true };

  it("asks only what the setup needs", async () => {
    const claude = probesOf();
    assert.equal((await claude.readiness.check("claudeSubscription", saved)).problem, null);
    assert.deepEqual(claude.asked, ["claude", "git", "login", "toolkit"]);
    const api = probesOf();
    await api.readiness.check("anthropicApi", saved);
    assert.deepEqual(api.asked, ["claude", "git", "toolkit"], "no login on an API option");
    const go = probesOf();
    await go.readiness.check("opencodeGo", saved);
    assert.deepEqual(go.asked, ["opencode", "toolkit"], "never runs claude");
  });

  it("runs nothing for a setup that lacks its key or model", async () => {
    const p = probesOf();
    const result = await p.readiness.check("opencodeGo", { keySaved: false, modelChosen: true });
    assert.equal(result.problem, "apiKeyMissing");
    assert.deepEqual(p.asked, []);
    assert.equal(
      (await p.readiness.check("openaiApi", { keySaved: false, modelChosen: false })).problem,
      "apiModelMissing",
    );
  });

  it("finds a missing program, a logged out Claude Code and an old OpenCode", async () => {
    assert.equal(
      (await probesOf({ claude: false }).readiness.check("claudeSubscription", saved)).problem,
      "claudeMissing",
    );
    const out = probesOf({ loggedIn: false });
    assert.equal(
      (await out.readiness.check("claudeSubscription", saved)).problem,
      "claudeLoggedOut",
    );
    assert.equal(
      (await probesOf({ loggedIn: false }).readiness.check("anthropicApi", saved)).problem,
      null,
    );
    const old = await probesOf({
      cli: { found: true, supported: false, version: "1.4.0" },
    }).readiness.check("opencodeGo", saved);
    assert.equal(old.problem, "programUnsupported");
    assert.match(old.message ?? "", /1\.4\.0/);
    assert.equal(
      (await probesOf({ prepared: false }).readiness.check("claudeSubscription", saved)).problem,
      "notPrepared",
    );
  });

  it("does not run the login without Git on Windows", async () => {
    const p = probesOf({ git: true });
    assert.equal((await p.readiness.check("claudeSubscription", saved)).problem, "gitBashMissing");
    assert.equal(p.asked.includes("login"), false);
  });

  it("ensureReady throws notReady with the sentence for the audience", async () => {
    const p = probesOf({ claude: false });
    await assert.rejects(p.readiness.ensureReady("claudeSubscription", saved), (error) => {
      const e = /** @type {{ code: string, message: string }} */ (error);
      assert.equal(e.code, "notReady");
      assert.match(e.message, /Ask an admin/);
      return true;
    });
    await probesOf().readiness.ensureReady("claudeSubscription", saved);
  });

  it("defaults: Git present and the toolkit prepared", async () => {
    const readiness = createReadiness({
      probes: {
        locateClaude: async () => true,
        claudeLoggedIn: async () => true,
        locateOpencode: async () => ({ found: true, supported: true, version: "2.0.0" }),
      },
    });
    assert.equal((await readiness.check("claudeSubscription", saved)).problem, null);
  });
});

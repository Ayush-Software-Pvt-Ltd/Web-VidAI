// What new edits need on this server: the ONE decision (docs/SPEC.md section 5, "Harness, program
// and model"; docs/SPEC.md section 5, "Readiness", with its table), used by
// Start Editing, the status line and the System page.
// `server/test/support/fixtures/readiness-table.json` is run by the server tests and by the UI
// tests (`src/lib/readiness.ts`), so they cannot disagree.
//
// The rule in one sentence: only the program that does the editing is needed, with the service it
// runs on.
//
// - The program follows from the setup (`programOf`): Claude Code for `claudeSubscription` and
//   `anthropicApi`, OpenCode 2 for `opencodeGo` and `openaiApi`.
// - An API option needs its chosen model, and OpenCode Go also its saved key (the other two work
//   without one: often a server on the admin's own network).
// - Claude Code needs to be installed (and Git for Windows on Windows), and logged in only on
//   `claudeSubscription`.
// - OpenCode 2 needs to be installed in a version VidAI drives.
//
// `problem` is pure; `createReadiness` gathers the facts through injected probes, looking only at
// what the setup needs (an edit on OpenCode 2 never runs `claude`, an edit on Claude Code never
// runs `opencode2 --version`, and only the Claude subscription runs `claude auth status`).

import { notReady } from "../errors.js";
import { optionOfSetup, programOf, keyRequired, SETUP_INFO } from "./setups.js";

/** @typedef {import("../../../src/lib/wire.ts").Setup} Setup */
/** @typedef {import("../../../src/lib/wire/harness.ts").ReadinessFacts} ReadinessFacts */
/** @typedef {import("../../../src/lib/wire/harness.ts").ReadinessProblem} ReadinessProblem */
/** @typedef {import("../../../src/lib/wire/harness.ts").Readiness} Readiness */
/** @typedef {import("../../../src/lib/wire/harness.ts").CliState} CliState */
/** @typedef {import("./apiHttpFailure.js").Audience} Audience */

/** Every problem, in the order of the SPEC table. @type {readonly ReadinessProblem[]} */
export const ALL_PROBLEMS = [
  "apiKeyMissing",
  "apiModelMissing",
  "gitBashMissing",
  "claudeMissing",
  "claudeLoggedOut",
  "programMissing",
  "programUnsupported",
  "notPrepared",
];

/**
 * `setup` with everything it needs in place (the caller sets what it looked at).
 * @param {Setup} setup
 * @returns {ReadinessFacts}
 */
export function readyFacts(setup) {
  return {
    setup,
    keySaved: true,
    modelChosen: true,
    gitBashMissing: false,
    claude: "ready",
    program: "ready",
    prepared: true,
  };
}

/**
 * The first thing that blocks new edits, or null when they can start.
 * @param {ReadinessFacts} facts
 * @returns {ReadinessProblem | null}
 */
export function problem(facts) {
  const option = optionOfSetup(facts.setup);
  if (option !== null) {
    // Only OpenCode Go needs its key: `anthropicApi` and `openaiApi` are often a server on the
    // admin's own network that needs none.
    if (keyRequired(option) && !facts.keySaved) return "apiKeyMissing";
    if (!facts.modelChosen) return "apiModelMissing";
  }
  if (programOf(facts.setup) === "claudeCode") {
    if (facts.gitBashMissing) return "gitBashMissing";
    if (facts.claude === "none") return "claudeMissing";
    // Only the Claude subscription needs a login: an API option brings its own key.
    if (facts.claude === "loggedOut" && facts.setup === "claudeSubscription") {
      return "claudeLoggedOut";
    }
  } else {
    if (facts.program === "none") return "programMissing";
    if (facts.program === "unsupported") return "programUnsupported";
  }
  return facts.prepared ? null : "notPrepared";
}

/**
 * What was found of the OpenCode 2 program (the shape of `locate.js` `OpencodeCli`, of which
 * only these fields count).
 * @typedef {object} CliFound
 * @property {boolean} found
 * @property {boolean} supported
 * @property {string | null} version
 */

/** @param {CliFound} cli @returns {CliState} */
export function cliStateOf(cli) {
  if (!cli.found) return "none";
  return cli.supported ? "ready" : "unsupported";
}

/**
 * @typedef {object} ReadinessProbes What the server can look at; each is asked only when the
 *   setup needs it.
 * @property {() => Promise<boolean>} locateClaude Claude Code is installed.
 * @property {() => Promise<boolean>} claudeLoggedIn `claude auth status` says logged in.
 * @property {() => Promise<CliFound>} locateOpencode
 * @property {() => Promise<boolean>} [gitBashMissing] Windows: Git for Windows is missing;
 *   false everywhere else (default: false).
 * @property {() => Promise<boolean>} [toolkitPrepared] The toolkit environment is ready
 *   (default: true until it exists).
 */

/** What the readiness sentences say about where a problem is fixed. */
const FIX = {
  admin: {
    settings: "Fix it in Admin, Harness and Model.",
    system: "See Admin, System.",
  },
  user: {
    settings: "Ask an admin to fix it.",
    system: "Ask an admin to fix it.",
  },
};

/**
 * The sentence for `problem` on `setup`. `cli` is what was found of OpenCode 2, when it was looked
 * at. An admin is told where to fix it; anyone else is told to ask an admin.
 * @param {Setup} setup
 * @param {ReadinessProblem} found
 * @param {{ cli?: CliFound | null, audience?: Audience }} [options]
 * @returns {string}
 */
export function messageOf(setup, found, { cli = null, audience = "admin" } = {}) {
  const service = SETUP_INFO[setup].service;
  const fix = FIX[audience];
  switch (found) {
    case "apiKeyMissing":
      return `No API key is saved for ${service}. Edits are set to run on it. ${fix.settings}`;
    case "apiModelMissing":
      return `No model is chosen for ${service}. Edits are set to run on it. ${fix.settings}`;
    case "gitBashMissing":
      return `Claude Code needs Git for Windows (Git Bash) on the computer that runs VidAI. ${
        audience === "admin"
          ? "Install it from https://git-scm.com/downloads/win, then try again."
          : fix.system
      }`;
    case "claudeMissing":
      return `Claude Code is not installed on the computer that runs VidAI. ${fix.system}`;
    case "claudeLoggedOut":
      return `Claude Code is not logged in on the computer that runs VidAI. ${
        audience === "admin" ? "Run claude once in a terminal there and sign in." : fix.system
      }`;
    case "programMissing":
    case "programUnsupported": {
      const reason = cli === null ? null : opencodeReason(cli);
      return `${reason ?? "OpenCode 2 cannot be used on the computer that runs VidAI."} Edits are set to run with OpenCode 2. ${fix.system}`;
    }
    case "notPrepared":
      return `The computer that runs VidAI is not prepared for edits yet. ${
        audience === "admin" ? "Press Prepare in Admin, System." : fix.system
      }`;
  }
}

/** @param {CliFound} cli @returns {string | null} */
function opencodeReason(cli) {
  if (!cli.found) return "OpenCode 2 is not installed on the computer that runs VidAI.";
  if (cli.supported) return null;
  return cli.version !== null
    ? `OpenCode ${cli.version} is installed; VidAI needs OpenCode 2.0 or later.`
    : "OpenCode 2 is installed but did not say which version it is.";
}

/**
 * @param {{ probes: ReadinessProbes }} deps
 */
export function createReadiness({ probes }) {
  const gitBashMissing = probes.gitBashMissing ?? (async () => false);
  const toolkitPrepared = probes.toolkitPrepared ?? (async () => true);

  /**
   * Gathers the facts, looking only at what `setup` needs. The key and the model come first:
   * nothing is run for a setup that cannot start anyway.
   * @param {Setup} setup
   * @param {{ keySaved: boolean, modelChosen: boolean }} saved What the settings hold (they
   *   count only for the API options).
   * @returns {Promise<{ facts: ReadinessFacts, cli: CliFound | null }>}
   */
  async function gather(setup, saved) {
    const facts = readyFacts(setup);
    if (optionOfSetup(setup) !== null) {
      facts.keySaved = saved.keySaved;
      facts.modelChosen = saved.modelChosen;
    }
    const early = problem(facts);
    if (early === "apiKeyMissing" || early === "apiModelMissing") return { facts, cli: null };
    /** @type {CliFound | null} */
    let cli = null;
    if (programOf(setup) === "claudeCode") {
      if (!(await probes.locateClaude())) facts.claude = "none";
      facts.gitBashMissing = await gitBashMissing();
      // The login only matters on the Claude subscription (`claude auth status`).
      if (setup === "claudeSubscription" && facts.claude === "ready" && !facts.gitBashMissing) {
        if (!(await probes.claudeLoggedIn())) facts.claude = "loggedOut";
      }
    } else {
      cli = await probes.locateOpencode();
      facts.program = cliStateOf(cli);
    }
    facts.prepared = await toolkitPrepared();
    return { facts, cli };
  }

  /**
   * The answer of a readiness check.
   * @param {Setup} setup
   * @param {{ keySaved: boolean, modelChosen: boolean }} saved
   * @param {{ audience?: Audience }} [options]
   * @returns {Promise<Readiness>}
   */
  async function check(setup, saved, { audience = "admin" } = {}) {
    const { facts, cli } = await gather(setup, saved);
    const found = problem(facts);
    return {
      problem: found,
      message: found === null ? null : messageOf(setup, found, { cli, audience }),
    };
  }

  /**
   * Throws `notReady` with the sentence of the first problem; returns when edits can start.
   * @param {Setup} setup
   * @param {{ keySaved: boolean, modelChosen: boolean }} saved
   * @param {{ audience?: Audience }} [options]
   * @returns {Promise<void>}
   */
  async function ensureReady(setup, saved, { audience = "user" } = {}) {
    const result = await check(setup, saved, { audience });
    if (result.message !== null) throw notReady(result.message);
  }

  return { gather, check, ensureReady };
}

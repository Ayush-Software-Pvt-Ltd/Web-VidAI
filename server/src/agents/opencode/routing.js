// Whether the server's own Claude Code setup already points Claude Code at another service
// (docs/SPEC.md section 5, "Harness, program and model").
//
// Claude Code reads `ANTHROPIC_BASE_URL` from its environment and from the `env` object of its
// settings file (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`), which it
// applies over the environment. VidAI never changes either: with the Claude subscription
// selected it sets nothing, so such a setting decides where edits go, and "Claude subscription"
// would not mean what it says. The admin screen shows that plainly instead (SPEC section 5).

import { readFile } from "node:fs/promises";
import path from "node:path";

/** @typedef {import("../../../../src/lib/wire/harness.ts").ClaudeRouting} ClaudeRouting */
/** @typedef {Readonly<Record<string, string | undefined>>} Env */

const BASE_URL_VAR = "ANTHROPIC_BASE_URL";

/** @param {string | undefined} value @returns {string | null} */
function nonBlank(value) {
  const text = value?.trim();
  return text ? text : null;
}

/**
 * Claude Code's settings file for this environment: `$CLAUDE_CONFIG_DIR/settings.json`, else
 * `<home>/.claude/settings.json` (`HOME`, or `USERPROFILE` on Windows). Null when no home is known.
 * @param {Env} env
 * @returns {string | null}
 */
export function settingsFile(env) {
  const dir = nonBlank(env.CLAUDE_CONFIG_DIR);
  if (dir !== null) return path.join(env.CLAUDE_CONFIG_DIR ?? dir, "settings.json");
  const home = nonBlank(env.HOME) ?? nonBlank(env.USERPROFILE);
  return home === null ? null : path.join(home, ".claude", "settings.json");
}

/**
 * The routing in `env` or in the text of Claude Code's settings file; the settings file wins, as
 * in Claude Code.
 * @param {Env} env
 * @param {string | null} settingsJson The text of the settings file, when there is one.
 * @returns {ClaudeRouting | null}
 */
export function routingFrom(env, settingsJson) {
  /** @type {string | null} */
  let fromSettings = null;
  if (settingsJson !== null) {
    try {
      /** @type {unknown} */
      const settings = JSON.parse(settingsJson);
      const section =
        typeof settings === "object" && settings !== null
          ? /** @type {Record<string, unknown>} */ (settings).env
          : null;
      const url =
        typeof section === "object" && section !== null && !Array.isArray(section)
          ? /** @type {Record<string, unknown>} */ (section)[BASE_URL_VAR]
          : null;
      if (typeof url === "string") fromSettings = nonBlank(url);
    } catch {
      // Not JSON: Claude Code ignores it too.
    }
  }
  if (fromSettings !== null) return { baseUrl: fromSettings, source: "claudeSettings" };
  const fromEnv = nonBlank(env[BASE_URL_VAR]);
  return fromEnv === null ? null : { baseUrl: fromEnv, source: "environment" };
}

/**
 * The routing of this computer now (reads the settings file; cheap, called by the admin screen).
 * @param {{ env?: Env, readText?: (file: string) => Promise<string> }} [deps]
 * @returns {Promise<ClaudeRouting | null>}
 */
export async function detectRouting({
  env = process.env,
  readText = (file) => readFile(file, "utf8"),
} = {}) {
  const file = settingsFile(env);
  /** @type {string | null} */
  let text = null;
  if (file !== null) {
    try {
      text = await readText(file);
    } catch {
      text = null;
    }
  }
  return routingFrom(env, text);
}
